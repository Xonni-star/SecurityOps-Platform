import {Router} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';

const uuid=z.string().uuid();const nonempty=z.string().trim().min(1);
export const qualificationsRouter=Router();
qualificationsRouter.use((req,res,next)=>{
  if(!/^\/(qualifications|employees\/[^/]+\/qualifications)/.test(req.path))return next();
  return requireAuth(req,res,()=>['POST','PUT','PATCH','DELETE'].includes(req.method)?requireCsrf(req,res,next):next());
});

qualificationsRouter.get('/qualifications/catalog',requirePermission('qualifications:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT id,code,name,description,category,default_validity_days,required,required_documents,active,created_at,updated_at FROM qualification_catalog WHERE tenant_id=$1 ORDER BY name',[req.user!.tenantId])).rows);}catch(error){next(error);}
});
qualificationsRouter.post('/qualifications/catalog',requirePermission('qualifications:write'),async(req,res,next)=>{
  try{
    const body=z.object({code:z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),name:nonempty.max(160),description:z.string().max(2000).nullable().optional(),category:z.string().trim().max(80).nullable().optional(),default_validity_days:z.number().int().positive().nullable().optional(),required:z.boolean().default(false),required_documents:z.array(z.string().trim().min(1).max(120)).max(16).default([]),active:z.boolean().default(true),reason:nonempty.max(500)}).strict().parse(req.body);
    const row=(await query(`INSERT INTO qualification_catalog(tenant_id,code,name,description,category,default_validity_days,required,required_documents,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,code,name,description,category,default_validity_days,required,required_documents,active,created_at,updated_at`,
      [req.user!.tenantId,body.code,body.name,body.description??null,body.category??null,body.default_validity_days??null,body.required,JSON.stringify(body.required_documents),body.active])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'qualification.catalog.created','qualification_catalog',row.id,{reason:body.reason,code:body.code});
    res.status(201).json(row);
  }catch(error){next(error);}
});
qualificationsRouter.get('/employees/:employeeId/qualifications',requirePermission('qualifications:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT q.id,q.employee_id,q.code,q.valid_from,q.valid_until,q.document_id,q.issuing_authority,q.status,q.notes,q.revoked_at,c.name,c.default_validity_days,
    CASE WHEN q.status IN ('revoked','invalid') THEN q.status WHEN q.valid_until IS NULL THEN 'valid' WHEN q.valid_until<CURRENT_DATE THEN 'expired'
      WHEN q.valid_until<=CURRENT_DATE+INTERVAL '90 days' THEN 'expiring' ELSE 'valid' END computed_status
    FROM employee_qualifications q LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.code=q.code
    WHERE q.tenant_id=$1 AND q.employee_id=$2 ORDER BY q.valid_until NULLS LAST,c.name`,[req.user!.tenantId,req.params.employeeId])).rows);}catch(error){next(error);}
});
qualificationsRouter.post('/employees/:employeeId/qualifications',requirePermission('qualifications:write'),async(req,res,next)=>{
  try{
    const body=z.object({code:z.string().trim().min(1).max(80),valid_from:z.string().date().nullable().optional(),valid_until:z.string().date().nullable().optional(),document_id:uuid.nullable().optional(),issuing_authority:z.string().trim().max(200).nullable().optional(),status:z.enum(['valid','expired','revoked','invalid']).default('valid'),notes:z.string().max(2000).nullable().optional(),reason:nonempty.max(500)}).strict().refine(value=>!value.valid_from||!value.valid_until||value.valid_until>=value.valid_from,{message:'valid_until muss gleich oder nach valid_from liegen'}).parse(req.body);
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,req.params.employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    const catalog=(await query('SELECT code FROM qualification_catalog WHERE tenant_id=$1 AND code=$2 AND active=true',[req.user!.tenantId,body.code])).rows[0];
    if(!catalog)return res.status(400).json({error:'Qualifikationscode ist im Katalog nicht aktiv'});
    // Site assignment is added to audit details so the object chronicle can
    // show which object the qualification change belongs to.
    const assignment=(await query(`SELECT site_id FROM employee_object_assignments
      WHERE tenant_id=$1 AND employee_id=$2 AND starts_on<=CURRENT_DATE AND (ends_on IS NULL OR ends_on>=CURRENT_DATE)
      ORDER BY primary_assignment DESC,starts_on DESC LIMIT 1`,[req.user!.tenantId,req.params.employeeId])).rows[0];
    const row=(await query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,valid_from,valid_until,document_id,issuing_authority,status,notes,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(tenant_id,employee_id,code) DO UPDATE SET valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,document_id=EXCLUDED.document_id,issuing_authority=EXCLUDED.issuing_authority,status=EXCLUDED.status,notes=EXCLUDED.notes,revoked_at=CASE WHEN EXCLUDED.status='revoked' THEN now() ELSE NULL END,updated_at=now() RETURNING *`,
      [req.user!.tenantId,req.params.employeeId,body.code,body.valid_from??null,body.valid_until??null,body.document_id??null,body.issuing_authority??null,body.status,body.notes??null])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'qualification.employee.updated','employee_qualification',row.id,{reason:body.reason,employee_id:req.params.employeeId,site_id:assignment?.site_id??null,code:body.code,valid_from:body.valid_from??null,valid_until:body.valid_until??null});
    res.status(201).json(row);
  }catch(error){next(error);}
});
qualificationsRouter.delete('/employees/:employeeId/qualifications/:id',requirePermission('qualifications:write'),async(req,res,next)=>{
  try{
    const body=z.object({reason:nonempty.max(500)}).strict().parse(req.body);
    const row=(await query('DELETE FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 RETURNING id,code',[req.user!.tenantId,req.params.employeeId,req.params.id])).rows[0];
    if(!row)return res.status(404).json({error:'Qualifikation nicht gefunden'});
    const assignment=(await query(`SELECT site_id FROM employee_object_assignments
      WHERE tenant_id=$1 AND employee_id=$2 AND starts_on<=CURRENT_DATE AND (ends_on IS NULL OR ends_on>=CURRENT_DATE)
      ORDER BY primary_assignment DESC,starts_on DESC LIMIT 1`,[req.user!.tenantId,req.params.employeeId])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'qualification.employee.deleted','employee_qualification',row.id,{reason:body.reason,employee_id:req.params.employeeId,site_id:assignment?.site_id??null,code:row.code});
    res.status(204).send();
  }catch(error){next(error);}
});
qualificationsRouter.get('/qualifications/reminders',requirePermission('qualifications:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT reminder_days,updated_at FROM qualification_reminder_settings WHERE tenant_id=$1',[req.user!.tenantId])).rows[0]??{reminder_days:[90,60,30,7]});}catch(error){next(error);}
});
qualificationsRouter.put('/qualifications/reminders',requirePermission('qualifications:write'),async(req,res,next)=>{
  try{
    const body=z.object({reminder_days:z.array(z.number().int().min(-3650).max(3650)).min(1).max(12),reason:nonempty.max(500)}).strict().parse(req.body);
    const days=[...new Set(body.reminder_days)].sort((a,b)=>b-a);
    const row=(await query(`INSERT INTO qualification_reminder_settings(tenant_id,reminder_days,updated_by)
      VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET reminder_days=EXCLUDED.reminder_days,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING reminder_days,updated_at`,[req.user!.tenantId,days,req.user!.id])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'qualification.reminders.updated','qualification_reminder_settings',req.user!.tenantId,{reason:body.reason,reminder_days:days});
    res.json(row);
  }catch(error){next(error);}
});
