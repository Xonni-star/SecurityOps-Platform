import {Router} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';
import {controlCenterUser,findEligibleCandidates,getControlCenter,sourceStillOpen} from '../services/operations-control-center.js';
import {publish} from '../services/realtime.js';
import {recordAudit} from '../services/audit.js';

const uuid=z.string().uuid();
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const readScopes=['tenant','site','system'] as const;
const writeScopes=['tenant','site'] as const;
const measureModules=['leitstelle','einsatz','schicht','objekt','mitarbeiter','qualifikation','dokument','nfc','schluessel','kunde','system'] as const;
const measurePriorities=['critical','high','medium','low'] as const;
const measureStatuses=['open','in_progress','on_hold','done','cancelled'] as const;
const sourceTypes=['shift','site','qualification','document','nfc_device','key','alarm','conflict'] as const;

export const operativeLeitstelleRouter=Router();
// Nur eigene Pfade authentifizieren; sonst würde jede /api/v1-Anfrage die
// Session mehrfach laden, weil dieser Router global montiert ist.
operativeLeitstelleRouter.use((req,res,next)=>/^\/operations\//.test(req.path)
  ?requireAuth(req,res,()=>['POST','PUT','PATCH','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  :next());

function authContext(req:Parameters<typeof controlCenterUser>[0]){return controlCenterUser(req);}
function writeScope(req:Parameters<typeof controlCenterUser>[0]){
  const context=authContext(req);
  return effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),
    'operations_measures:write',context);
}
function ensureSiteAccess(req:Parameters<typeof controlCenterUser>[0],siteId:string|null|undefined){
  const user=req.user!;
  const context=authContext(req);
  if(!siteId){
    if(writeScope(req)==='site')throw Object.assign(new Error('Für objektbezogene Berechtigungen ist ein Objekt erforderlich'),{status:403});
    return;
  }
  const scope=writeScope(req);
  if(!scope||!canAccessResource(context,scope,{tenantId:user.tenantId,siteId}))throw Object.assign(new Error('Kein Zugriff auf dieses Objekt'),{status:403});
}

operativeLeitstelleRouter.get('/operations/control-center',requirePermission('nsl:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{
    const querySchema=z.object({
      date:isoDate.optional(),site_id:uuid.optional(),customer_id:uuid.optional(),employee_id:uuid.optional(),
      page:z.coerce.number().int().min(1).default(1),page_size:z.coerce.number().int().min(5).max(100).default(25),
    }).strict();
    const input=querySchema.parse(req.query);
    const data=await getControlCenter(authContext(req),{
      date:input.date??new Date().toISOString().slice(0,10),siteId:input.site_id,customerId:input.customer_id,
      employeeId:input.employee_id,page:input.page,pageSize:input.page_size,
    });
    res.setHeader('Cache-Control','no-store');
    res.json(data);
  }catch(error){next(error);}
});

operativeLeitstelleRouter.get('/operations/control-center/candidates',requirePermission('scheduling:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{
    const {shift_id}=z.object({shift_id:uuid}).strict().parse(req.query);
    res.json(await findEligibleCandidates(authContext(req),shift_id));
  }catch(error){next(error);}
});

operativeLeitstelleRouter.get('/operations/measures',requirePermission('operations_measures:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{
    const input=z.object({
      q:z.string().trim().max(200).optional(),status:z.enum(measureStatuses).optional(),module:z.enum(measureModules).optional(),
      site_id:uuid.optional(),overdue:z.enum(['true','false']).transform(value=>value==='true').optional(),
      page:z.coerce.number().int().min(1).default(1),page_size:z.coerce.number().int().min(5).max(100).default(25),
    }).strict().parse(req.query);
    const values:unknown[]=[req.user!.tenantId];
    const clauses=['m.tenant_id=$1'];
    const context=authContext(req);
    const readScope=effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),'operations_measures:read',context);
    if(readScope==='site'){
      values.push(req.user!.siteIds);
      clauses.push(`m.site_id=ANY($${values.length}::uuid[])`);
    }
    if(input.q){values.push(`%${input.q}%`);clauses.push(`(m.title ILIKE $${values.length} OR m.description ILIKE $${values.length})`);}
    if(input.status){values.push(input.status);clauses.push(`m.status=$${values.length}`);}
    if(input.module){values.push(input.module);clauses.push(`m.module=$${values.length}`);}
    if(input.site_id){values.push(input.site_id);clauses.push(`m.site_id=$${values.length}`);}
    if(input.overdue){clauses.push(`m.status NOT IN ('done','cancelled') AND m.due_at < now()`);}
    const where=clauses.join(' AND ');
    const count=(await query<{count:string}>(`SELECT count(*)::text count FROM operations_measures m WHERE ${where}`,values)).rows[0];
    values.push(input.page_size,(input.page-1)*input.page_size);
    const rows=(await query(`SELECT m.*,s.name site_name,e.name assigned_employee_name,
      (SELECT count(*)::int FROM operations_measures c WHERE c.tenant_id=m.tenant_id
        AND c.incident_id=m.incident_id AND c.status NOT IN ('done','cancelled')) open_siblings
      FROM operations_measures m LEFT JOIN sites s ON s.tenant_id=m.tenant_id AND s.id=m.site_id
      LEFT JOIN employees e ON e.tenant_id=m.tenant_id AND e.id=m.assigned_employee_id
      WHERE ${where}
      ORDER BY CASE m.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'on_hold' THEN 3 ELSE 4 END,
        m.due_at NULLS LAST,m.created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values)).rows;
    const total=Number(count?.count??0);
    res.setHeader('X-Total-Count',String(total));
    res.setHeader('X-Page-Count',String(Math.max(1,Math.ceil(total/input.page_size))));
    res.json(rows);
  }catch(error){next(error);}
});

const createMeasureSchema=z.object({
  title:z.string().trim().min(1).max(240),description:z.string().trim().max(5000).optional(),
  module:z.enum(measureModules),priority:z.enum(measurePriorities).default('medium'),
  status:z.enum(measureStatuses).default('open'),site_id:uuid.nullable().optional(),
  incident_id:uuid.nullable().optional(),assigned_employee_id:uuid.nullable().optional(),assigned_user_id:uuid.nullable().optional(),
  due_at:z.coerce.date().nullable().optional(),source_type:z.enum(sourceTypes).nullable().optional(),
  source_id:uuid.nullable().optional(),source_key:z.string().trim().max(240).nullable().optional(),
  client_mutation_id:uuid.optional(),reason:z.string().trim().max(1000).optional(),
}).strict();

operativeLeitstelleRouter.post('/operations/measures',requireCsrf,requirePermission('operations_measures:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{
    const body=createMeasureSchema.parse(req.body);
    ensureSiteAccess(req,body.site_id);
    const sourceKey=body.source_key??(body.client_mutation_id?`manual:${body.client_mutation_id}`:null);
    if(sourceKey){
      const existing=(await query('SELECT * FROM operations_measures WHERE tenant_id=$1 AND source_key=$2',[req.user!.tenantId,sourceKey])).rows[0];
      if(existing)return res.status(200).json(existing);
    }
    const row=await withTransaction(async client=>{
      const result=await client.query(`INSERT INTO operations_measures
        (id,tenant_id,incident_id,title,description,module,priority,status,assigned_employee_id,assigned_user_id,
         site_id,due_at,source_type,source_id,source_key,created_by,updated_by,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$17,$17,$16) RETURNING *`,
        [crypto.randomUUID(),req.user!.tenantId,body.incident_id??null,body.title,body.description??null,body.module,
         body.priority,body.status,body.assigned_employee_id??null,body.assigned_user_id??null,body.site_id??null,
         body.due_at?.toISOString()??null,body.source_type??null,body.source_id??null,sourceKey,
         ['done','cancelled'].includes(body.status)?new Date().toISOString():null,req.user!.id]);
      await recordAudit(req.user!.tenantId,req.user!.id,'operations.measure.created','operations_measure',result.rows[0].id,
        {module:body.module,priority:body.priority,source_type:body.source_type??null,source_key:sourceKey},client);
      return result.rows[0];
    });
    publish(req.user!.tenantId,'operations.measure.created',row,'operations_measures:read');
    res.status(201).json(row);
  }catch(error){next(error);}
});

const updateMeasureSchema=z.object({
  status:z.enum(measureStatuses).optional(),title:z.string().trim().min(1).max(240).optional(),
  description:z.string().trim().max(5000).nullable().optional(),priority:z.enum(measurePriorities).optional(),
  assigned_employee_id:uuid.nullable().optional(),assigned_user_id:uuid.nullable().optional(),
  due_at:z.coerce.date().nullable().optional(),reason:z.string().trim().min(1).max(1000).optional(),
}).strict().refine(value=>Object.keys(value).some(key=>key!=='reason'),{message:'Keine Änderung angegeben'});

operativeLeitstelleRouter.patch('/operations/measures/:id',requireCsrf,requirePermission('operations_measures:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{
    const measureId=String(req.params.id);
    if(!uuid.safeParse(measureId).success)return res.status(400).json({error:'Ungültige Maßnahmen-ID'});
    const body=updateMeasureSchema.parse(req.body);
    const tenant=req.user!.tenantId;
    const current=(await query('SELECT * FROM operations_measures WHERE tenant_id=$1 AND id=$2',[tenant,measureId])).rows[0];
    if(!current)return res.status(404).json({error:'Maßnahme nicht gefunden'});
    ensureSiteAccess(req,current.site_id);
    if(body.status==='done'&&(current.status!=='done')){
      const open=await sourceStillOpen(authContext(req),current.source_type,current.source_id);
      if(open)return res.status(409).json({error:'Die Ursache der Maßnahme besteht weiterhin',reason_code:'source_open'});
    }
    const fields:string[]=[];const values:unknown[]=[];
    for(const key of ['title','description','priority','status','assigned_employee_id','assigned_user_id'] as const){
      if(body[key]===undefined)continue;
      values.push(body[key]);fields.push(`${key}=$${values.length}`);
    }
    if(body.due_at!==undefined){values.push(body.due_at?body.due_at.toISOString():null);fields.push(`due_at=$${values.length}`);}
    if(!fields.length)return res.status(400).json({error:'Keine Änderung angegeben'});
    values.push(new Date().toISOString());fields.push(`updated_at=$${values.length}`);
    values.push(req.user!.id);fields.push(`updated_by=$${values.length}`);
    if(body.status){
      values.push(['done','cancelled'].includes(body.status)?new Date().toISOString():null);
      fields.push(`completed_at=$${values.length}`);
    }
    values.push(tenant,measureId);
    const row=await withTransaction(async client=>{
      const result=await client.query(`UPDATE operations_measures SET ${fields.join(',')}
        WHERE tenant_id=$${values.length-1} AND id=$${values.length} RETURNING *`,values);
      await recordAudit(tenant,req.user!.id,body.status?'operations.measure.status':'operations.measure.updated',
        'operations_measure',measureId,{status:body.status??current.status,reason:body.reason??null,changes:Object.keys(body)},client);
      return result.rows[0];
    });
    publish(tenant,'operations.measure.updated',row,'operations_measures:read');
    res.json(row);
  }catch(error){next(error);}
});
