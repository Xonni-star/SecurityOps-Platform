import {Router} from 'express'; import {z} from 'zod'; import {query} from '../db/pool.js'; import {requirePermission} from '../middleware/auth.js'; import {recordAudit} from '../services/audit.js'; import {effectivePermissionScope,normalizePermissionGrants,PermissionScope} from '../types/authorization.js'; import type {AuthUser} from '../types/models.js';
const nonempty=z.string().trim().min(1);
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date=z.coerce.date();
const schemas={
  employees:z.object({
    name:nonempty,email:z.string().email(),title:nonempty.optional(),
    employee_number:z.string().trim().max(80).nullable().optional(),
    first_name:z.string().trim().max(120).nullable().optional(),
    last_name:z.string().trim().max(120).nullable().optional(),
    phone:z.string().trim().max(40).nullable().optional(),
    mobile:z.string().trim().max(40).nullable().optional(),
    address:z.string().trim().max(1000).nullable().optional(),
    date_of_birth:z.string().date().nullable().optional(),
    hire_date:z.string().date().nullable().optional(),
    termination_date:z.string().date().nullable().optional(),
    employment_status:z.enum(['active','probation','leave','terminated','archived']).optional(),
    employment_type:z.enum(['employee','temporary','contractor','intern','apprentice','freelancer']).optional(),
    department:z.string().trim().max(160).nullable().optional(),
    position:z.string().trim().max(160).nullable().optional(),
    work_location:z.string().trim().max(160).nullable().optional(),
    weekly_hours:z.number().min(0).max(168).nullable().optional(),
    user_id:uuid.nullable().optional(),
  }).strict(),
  customers:z.object({name:nonempty,email:z.string().email().nullable().optional()}).strict(),
  sites:z.object({
    name:nonempty,address:nonempty.nullable().optional(),site_number:nonempty.nullable().optional(),alias:z.string().trim().max(160).nullable().optional(),
    site_type:z.string().trim().max(160).nullable().optional(),description:z.string().trim().max(8000).nullable().optional(),
    status:z.enum(['planning','setup','active','restricted','temporarily_closed','decommissioned','archived']).optional(),
    security_classification:z.enum(['unknown','low','medium','high','critical']).optional(),
    latitude:z.number().min(-90).max(90).nullable().optional(),
    longitude:z.number().min(-180).max(180).nullable().optional(),
    opening_hours:z.record(z.string(),z.string()).nullable().optional(),
    access_information:z.string().trim().max(8000).nullable().optional(),
    special_notes:z.string().trim().max(8000).nullable().optional(),
    hazard_notes:z.string().trim().max(8000).nullable().optional(),
    object_manager_employee_id:uuid.nullable().optional(),
    operations_manager_employee_id:uuid.nullable().optional(),
    required_staff_count:z.number().int().min(0).max(100000).optional(),
    street:z.string().trim().max(240).nullable().optional(),
    house_number:z.string().trim().max(30).nullable().optional(),
    postal_code:z.string().trim().max(20).nullable().optional(),
    city:z.string().trim().max(160).nullable().optional(),
    contact_person:z.string().trim().max(240).nullable().optional(),
  }).strict(),
  devices:z.object({
    name:nonempty,status:z.enum(['online','offline','maintenance']).optional(),site_id:uuid.nullable().optional(),last_seen_at:date.nullable().optional(),
    asset_number:z.string().trim().max(100).nullable().optional(),category:z.string().trim().max(160).nullable().optional(),
    manufacturer:z.string().trim().max(160).nullable().optional(),model:z.string().trim().max(160).nullable().optional(),
    serial_number:z.string().trim().max(160).nullable().optional(),location_id:uuid.nullable().optional(),
    responsible_employee_id:uuid.nullable().optional(),operational_status:z.enum(['active','maintenance','fault','offline','decommissioned']).optional(),
    installed_on:z.string().date().nullable().optional(),commissioned_on:z.string().date().nullable().optional(),
    last_inspection_on:z.string().date().nullable().optional(),next_inspection_on:z.string().date().nullable().optional(),
    maintenance_interval_days:z.number().int().positive().nullable().optional(),next_maintenance_on:z.string().date().nullable().optional(),
    last_maintenance_on:z.string().date().nullable().optional(),
  }).strict(),
  alarms:z.object({device_id:uuid.nullable().optional(),severity:z.enum(['low','medium','high','critical']),status:z.enum(['open','acknowledged','resolved']).optional(),message:nonempty,triggered_at:date.optional(),resolved_at:date.nullable().optional()}).strict()
} as const;
const fields={employees:['name','email','title','employee_number','first_name','last_name','phone','mobile','address','date_of_birth','hire_date','termination_date','employment_status','employment_type','department','position','work_location','weekly_hours','user_id'],customers:['name','email'],sites:['name','address','site_number','alias','site_type','description','status','security_classification','latitude','longitude','opening_hours','access_information','special_notes','hazard_notes','object_manager_employee_id','operations_manager_employee_id','required_staff_count','street','house_number','postal_code','city','contact_person'],devices:['name','status','site_id','last_seen_at','asset_number','category','manufacturer','model','serial_number','location_id','responsible_employee_id','operational_status','installed_on','commissioned_on','last_inspection_on','next_inspection_on','maintenance_interval_days','next_maintenance_on','last_maintenance_on'],alarms:['device_id','severity','status','message','triggered_at','resolved_at']} as const;
type Resource=keyof typeof schemas;
function parseBody(resource:Resource,body:unknown,partial:boolean){const parsed=(partial?schemas[resource].partial():schemas[resource]).safeParse(body);return parsed.success?parsed.data:null;}
function invalid(res:import('express').Response){return res.status(400).json({error:'Invalid request'});}
const siteResources=new Set<Resource>(['sites','devices']);
const siteStatusTransitions:Record<string,Set<string>>={
  planning:new Set(['planning','setup','active','archived']),
  setup:new Set(['setup','active','restricted','temporarily_closed','archived']),
  active:new Set(['active','restricted','temporarily_closed','decommissioned']),
  restricted:new Set(['restricted','active','temporarily_closed','decommissioned']),
  temporarily_closed:new Set(['temporarily_closed','active','restricted','decommissioned']),
  decommissioned:new Set(['decommissioned','archived']),
  archived:new Set(['archived']),
};
function scopeFor(user:AuthUser,permission:string):PermissionScope|null{return effectivePermissionScope(normalizePermissionGrants(user.permissionGrants,user.permissions),permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});}
function scopeFilter(resource:Resource,scope:PermissionScope,user:AuthUser,start:number):{sql:string;values:unknown[]}{if(scope==='tenant'||scope==='system')return {sql:'',values:[]};if(scope==='site'){if(resource==='sites')return {sql:` AND id = ANY($${start}::uuid[])`,values:[user.siteIds??[]]};if(!siteResources.has(resource))return {sql:' AND FALSE',values:[]};return {sql:` AND site_id = ANY($${start}::uuid[])`,values:[user.siteIds??[]]};}return {sql:` AND EXISTS (SELECT 1 FROM resource_owners ro WHERE ro.tenant_id=$${start} AND ro.resource=$${start+1} AND ro.resource_id=${resource}.id AND ro.user_id=$${start+2})`,values:[user.tenantId,resource,user.id]};}
function createScopeAllowed(resource:Resource,scope:PermissionScope,user:AuthUser,body:Record<string,unknown>):boolean{if(scope==='tenant'||scope==='system')return true;if(scope==='own')return false;if(scope==='site')return resource==='sites'?false:siteResources.has(resource)&&typeof body.site_id==='string'&&(user.siteIds??[]).includes(body.site_id);return false;}
export function crudRouter(resource:Resource){const router=Router();const deviceInventoryFilter=resource==='devices'?" AND device_kind='operational'":'';router.get('/',requirePermission(`${resource}:read`,{allowedScopes:['tenant','site','own','system']}),async(req,res,next)=>{try{const user=req.user!;const scope=scopeFor(user,`${resource}:read`)!;const filter=scopeFilter(resource,scope,user,2);const r=await query(`SELECT * FROM ${resource} WHERE tenant_id=$1${deviceInventoryFilter}${filter.sql} ORDER BY created_at DESC`,[user.tenantId,...filter.values]);res.json(r.rows);}catch(e){next(e);}});router.post('/',requirePermission(`${resource}:write`,{allowedScopes:['tenant','site','own','system']}),async(req,res,next)=>{try{const body=parseBody(resource,req.body,false);if(!body)return invalid(res);const user=req.user!;const scope=scopeFor(user,`${resource}:write`)!;if(!createScopeAllowed(resource,scope,user,body as Record<string,unknown>))return res.status(403).json({error:'Permission scope does not include this site'});const selected=fields[resource].filter(field=>field in body) as string[];const deviceColumns=resource==='devices'?['device_kind',...selected]:selected;const vals=resource==='devices'?[user.tenantId,'operational',...selected.map(field=>(body as Record<string,unknown>)[field])]:[user.tenantId,...selected.map(field=>(body as Record<string,unknown>)[field])];const r=await query(`INSERT INTO ${resource} (tenant_id,${deviceColumns.join(',')}) VALUES (${vals.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,vals);if(scope==='own')await query('INSERT INTO resource_owners(tenant_id,resource,resource_id,user_id) VALUES($1,$2,$3,$4)',[user.tenantId,resource,r.rows[0].id,user.id]);await recordAudit(user.tenantId,user.id,`${resource}.created`,resource,String(r.rows[0].id),{});res.status(201).json(r.rows[0]);}catch(e){next(e);}});router.patch('/:id',requirePermission(`${resource}:write`,{allowedScopes:['tenant','site','own','system']}),async(req,res,next)=>{try{const id=String(req.params.id);if(!uuid.safeParse(id).success)return invalid(res);const body=parseBody(resource,req.body,true);if(!body)return invalid(res);const selected=fields[resource].filter(field=>field in body) as string[];if(!selected.length)return invalid(res);const user=req.user!;const scope=scopeFor(user,`${resource}:write`)!;if(scope==='site'&&(!siteResources.has(resource)||('site_id' in body&&typeof body.site_id==='string'&&!user.siteIds?.includes(body.site_id))))return res.status(403).json({error:'Permission scope does not include this site'});const tenantIndex=selected.length+1;const permissionScope=scopeFor(user,`${resource}:write`)!;if(resource==='sites'&&'status' in body&&typeof body.status==='string'){const current=(await query<{status:string}>('SELECT status FROM sites WHERE tenant_id=$1 AND id=$2',[user.tenantId,id])).rows[0];if(!current)return res.status(404).json({error:'Not found'});if(!siteStatusTransitions[current.status]?.has(body.status))return res.status(409).json({error:'Invalid site status transition'});}
const scopeFilterValue=scopeFilter(resource,permissionScope,user,tenantIndex+2);const vals=[...selected.map(field=>(body as Record<string,unknown>)[field]),user.tenantId,id,...scopeFilterValue.values];const r=await query(`UPDATE ${resource} SET ${selected.map((field,i)=>`${field}=$${i+1}`).join(',')},updated_at=now() WHERE tenant_id=$${tenantIndex} AND id=$${tenantIndex+1}${deviceInventoryFilter}${scopeFilterValue.sql} RETURNING *`,vals);if(!r.rowCount)return res.status(404).json({error:'Not found'});await recordAudit(user.tenantId,user.id,`${resource}.updated`,resource,id,{});res.json(r.rows[0]);}catch(e){next(e);}});router.delete('/:id',requirePermission(`${resource}:delete`,{allowedScopes:['tenant','site','own','system']}),async(req,res,next)=>{try{const id=String(req.params.id);if(!uuid.safeParse(id).success)return invalid(res);const user=req.user!;const scope=scopeFor(user,`${resource}:delete`)!;const filter=scopeFilter(resource,scope,user,3);const r=await query(`DELETE FROM ${resource} WHERE tenant_id=$1 AND id=$2${deviceInventoryFilter}${filter.sql}`,[user.tenantId,id,...filter.values]);if(!r.rowCount)return res.status(404).json({error:'Not found'});await recordAudit(user.tenantId,user.id,`${resource}.deleted`,resource,id,{});res.status(204).send();}catch(e){next(e);}});return router;}
