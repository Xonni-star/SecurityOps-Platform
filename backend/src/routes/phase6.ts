import {Router} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';

const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nonempty=z.string().trim().min(1);
const status=z.enum(['active','lost','blocked','replaced']);
export const phase6Router=Router();
phase6Router.use((req,res,next)=>/^\/nfc-devices/.test(req.path)
  ? requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  : next());

async function targetExists(tenantId:string,key:'employee_id'|'site_id'|'control_point_id',id:string){
  const table={employee_id:'employees',site_id:'sites',control_point_id:'control_points'}[key];
  return (await query(`SELECT id FROM ${table} WHERE id=$1 AND tenant_id=$2`,[id,tenantId])).rows[0];
}

phase6Router.get('/nfc-devices',requirePermission('nfc_devices:read'),async(req,res,next)=>{
  try{
    const rows=await query(`SELECT n.*,e.name employee_name,s.name site_name,cp.name control_point_name
      FROM nfc_devices n LEFT JOIN employees e ON e.id=n.employee_id LEFT JOIN sites s ON s.id=n.site_id
      LEFT JOIN control_points cp ON cp.id=n.control_point_id WHERE n.tenant_id=$1 ORDER BY n.updated_at DESC`,[req.user!.tenantId]);
    res.json(rows.rows);
  }catch(error){next(error);}
});

phase6Router.post('/nfc-devices',requirePermission('nfc_devices:write'),async(req,res,next)=>{
  try{
    const body=z.object({identifier:nonempty,device_type:nonempty,manufacturer:nonempty,status:status.optional(),employee_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),control_point_id:uuid.nullable().optional(),notes:z.string().max(2000).optional()}).strict().parse(req.body);
    const targets=Object.entries({employee_id:body.employee_id,site_id:body.site_id,control_point_id:body.control_point_id}).filter(([,value])=>value);
    if(targets.length>1)return res.status(400).json({error:'Only one NFC assignment target is allowed'});
    if(targets[0]&&!(await targetExists(req.user!.tenantId,targets[0][0] as 'employee_id'|'site_id'|'control_point_id',String(targets[0][1]))))return res.status(404).json({error:'Assignment target not found'});
    const device=(await query(`INSERT INTO nfc_devices(tenant_id,identifier,device_type,manufacturer,status,employee_id,site_id,control_point_id,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.user!.tenantId,body.identifier,body.device_type,body.manufacturer,body.status??'active',body.employee_id??null,body.site_id??null,body.control_point_id??null,body.notes??''])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'nfc_device.created','nfc_device',String(device.id),{identifier:body.identifier});
    res.status(201).json(device);
  }catch(error){next(error);}
});

phase6Router.patch('/nfc-devices/:id',requirePermission('nfc_devices:write'),async(req,res,next)=>{
  try{
    const id=String(req.params.id);
    const body=z.object({identifier:nonempty.optional(),device_type:nonempty.optional(),manufacturer:nonempty.optional(),status:status.optional(),employee_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),control_point_id:uuid.nullable().optional(),notes:z.string().max(2000).optional()}).strict().parse(req.body);
    const current=(await query('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id])).rows[0];
    if(!current)return res.status(404).json({error:'NFC device not found'});
    const assignment={employee_id:body.employee_id===undefined?current.employee_id:body.employee_id,site_id:body.site_id===undefined?current.site_id:body.site_id,control_point_id:body.control_point_id===undefined?current.control_point_id:body.control_point_id};
    const targets=Object.entries(assignment).filter(([,value])=>value);
    if(targets.length>1)return res.status(400).json({error:'Only one NFC assignment target is allowed'});
    if(targets[0]&&!(await targetExists(req.user!.tenantId,targets[0][0] as 'employee_id'|'site_id'|'control_point_id',String(targets[0][1]))))return res.status(404).json({error:'Assignment target not found'});
    const fields={...body,...assignment};const keys=Object.keys(fields).filter(key=>fields[key as keyof typeof fields]!==undefined) as (keyof typeof fields)[];
    if(!keys.length)return res.status(400).json({error:'No changes supplied'});
    const values=keys.map(key=>fields[key]);const set=keys.map((key,index)=>`${key}=$${index+1}`).join(',');
    const device=(await query(`UPDATE nfc_devices SET ${set},updated_at=now() WHERE tenant_id=$${keys.length+1} AND id=$${keys.length+2} RETURNING *`,[...values,req.user!.tenantId,id])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'nfc_device.updated','nfc_device',id,{changed:keys});
    res.json(device);
  }catch(error){next(error);}
});

phase6Router.delete('/nfc-devices/:id',requirePermission('nfc_devices:write'),async(req,res,next)=>{
  try{
    const id=String(req.params.id);
    const result=await query('DELETE FROM nfc_devices WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id]);
    if(!result.rowCount)return res.status(404).json({error:'NFC device not found'});
    await recordAudit(req.user!.tenantId,req.user!.id,'nfc_device.deleted','nfc_device',id,{});
    res.status(204).send();
  }catch(error){next(error);}
});
