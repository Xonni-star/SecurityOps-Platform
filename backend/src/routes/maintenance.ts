import {Router,type RequestHandler} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {queueNotificationEvent} from '../services/notifications.js';
import {effectiveMaintenanceStatus,maintenanceStatusLabels,nextMaintenanceDate,withMaintenanceStatus} from '../services/maintenance-domain.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();
const maintenanceTypes=['inspection','preventive','corrective','repair','other'] as const;
const priorities=['critical','high','medium','low'] as const;
const openStatuses=['planned','open','in_progress'] as const;

type OrderRow={
  id:string;tenant_id:string;site_id:string;device_id:string;order_number:string;
  status:string;due_on:string|null;responsible_employee_id:string|null;description:string;
};

function accessContext(req:Parameters<RequestHandler>[0]){
  const user=req.user!;
  const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
  return {user,grants,authorization:{userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants}};
}

function requireSiteScope(permission:string):RequestHandler{
  return async(req,res,next)=>{
    try{
      const siteId=uuid.parse(String(req.params.id));
      const {user,grants,authorization}=accessContext(req);
      const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
      if(!scope)return res.status(403).json({error:'Insufficient permissions'});
      if(!canAccessResource(authorization,scope,{tenantId:user.tenantId,siteId}))return res.status(403).json({error:'Permission scope does not include this site'});
      next();
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid site id'});next(error);}
  };
}

async function loadOrder(req:Parameters<RequestHandler>[0],res:Parameters<RequestHandler>[1],permission:string):Promise<OrderRow|null>{
  const orderId=uuid.parse(String(req.params.id));
  const order=(await query<OrderRow>(`SELECT o.* FROM maintenance_orders o WHERE o.tenant_id=$1 AND o.id=$2`,[req.user!.tenantId,orderId])).rows[0];
  if(!order){res.status(404).json({error:'Maintenance order not found'});return null;}
  const {user,grants,authorization}=accessContext(req);
  const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  if(!scope||!canAccessResource(authorization,scope,{tenantId:user.tenantId,siteId:order.site_id})){
    res.status(403).json({error:'Permission scope does not include this maintenance order'});
    return null;
  }
  return order;
}

async function employeeAssignedToSite(tenantId:string,siteId:string,employeeId:string){
  return Boolean((await query(
    `SELECT 1 FROM employee_object_assignments oa
     WHERE oa.tenant_id=$1 AND oa.site_id=$2 AND oa.employee_id=$3
       AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)`,
    [tenantId,siteId,employeeId],
  )).rows[0]);
}


async function notifyResponsible(order:OrderRow,title:string,body:string){
  if(!order.responsible_employee_id)return;
  await queueNotificationEvent(order.tenant_id,'maintenance.status',`maintenance:${order.id}:${order.status}`,title,body,'maintenance_order',order.id);
}

export const maintenanceRouter=Router();

maintenanceRouter.get('/sites/:id/maintenance-orders',requireAuth,requirePermission('devices:read',{allowedScopes:['tenant','site','own','system']}),requireSiteScope('devices:read'),async(req,res,next)=>{
  try{
    const rows=(await query<OrderRow & Record<string,unknown>>(
      `SELECT o.*,d.name AS device_name,d.asset_number,d.maintenance_interval_days,
         e.name AS responsible_employee_name,
         COALESCE(json_agg(json_build_object('id',link.id,'document_id',link.document_id) ORDER BY link.created_at) FILTER (WHERE link.id IS NOT NULL),'[]') AS documents
       FROM maintenance_orders o
       LEFT JOIN devices d ON d.tenant_id=o.tenant_id AND d.id=o.device_id AND d.device_kind='operational'
       LEFT JOIN employees e ON e.tenant_id=o.tenant_id AND e.id=o.responsible_employee_id
       LEFT JOIN maintenance_order_documents link ON link.tenant_id=o.tenant_id AND link.order_id=o.id
       WHERE o.tenant_id=$1 AND o.site_id=$2
       GROUP BY o.id,d.name,d.asset_number,d.maintenance_interval_days,e.name
       ORDER BY o.due_on ASC NULLS LAST,o.created_at DESC`,
      [req.user!.tenantId,req.params.id],
    )).rows;
    res.json(rows.map(row=>withMaintenanceStatus(row)));
  }catch(error){next(error);}
});

maintenanceRouter.post('/sites/:id/maintenance-orders',requireAuth,requireCsrf,requirePermission('devices:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('devices:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id));
    const body=z.object({
      device_id:uuid,
      maintenance_type:z.enum(maintenanceTypes).default('inspection'),
      description:z.string().trim().min(3).max(4000),
      priority_code:z.enum(priorities).default('medium'),
      due_on:z.string().date().nullable().optional(),
      status:z.enum(openStatuses).default('planned'),
      responsible_employee_id:uuid.nullable().optional(),
    }).strict().parse(req.body);
    const device=(await query<{id:string;site_id:string}>(
      `SELECT id,site_id FROM devices WHERE tenant_id=$1 AND id=$2 AND device_kind='operational'`,
      [req.user!.tenantId,body.device_id],
    )).rows[0];
    if(!device||device.site_id!==siteId)return res.status(404).json({error:'Operational device not found at this site'});
    if(body.responsible_employee_id&&!await employeeAssignedToSite(req.user!.tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    const sequence=(await query<{next:string}>(`SELECT nextval('maintenance_order_number_seq')::text AS next`)).rows[0];
    const orderNumber=`MAIN-${new Date().getUTCFullYear()}-${String(sequence?.next??'').padStart(6,'0')}`;
    const row=(await query<OrderRow>(
      `INSERT INTO maintenance_orders(tenant_id,site_id,device_id,order_number,maintenance_type,description,priority_code,due_on,responsible_employee_id,status,created_by,started_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user!.tenantId,siteId,body.device_id,orderNumber,body.maintenance_type,body.description,body.priority_code,body.due_on??null,body.responsible_employee_id??null,body.status,req.user!.id,body.status==='in_progress'?new Date():null],
    )).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'maintenance_order.created','maintenance_order',row.id,{site_id:siteId,device_id:body.device_id,order_number:orderNumber,status:body.status});
    await notifyResponsible(row,'Wartungsauftrag erfasst',`${row.order_number}: ${row.description}`);
    res.status(201).json(withMaintenanceStatus(row));
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid maintenance order'});next(error);}
});

maintenanceRouter.patch('/maintenance-orders/:id',requireAuth,requireCsrf,requirePermission('devices:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const order=await loadOrder(req,res,'devices:write');if(!order)return;
    if(!openStatuses.includes(order.status as typeof openStatuses[number]))return res.status(409).json({error:'Completed or cancelled orders cannot be edited'});
    const body=z.object({
      status:z.enum(openStatuses).optional(),
      maintenance_type:z.enum(maintenanceTypes).optional(),
      description:z.string().trim().min(3).max(4000).optional(),
      priority_code:z.enum(priorities).optional(),
      due_on:z.string().date().nullable().optional(),
      responsible_employee_id:uuid.nullable().optional(),
    }).strict().refine(value=>Object.keys(value).length>0).parse(req.body);
    if(body.responsible_employee_id&&!await employeeAssignedToSite(order.tenant_id,order.site_id,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    const columns:Record<string,string>={status:'status',maintenance_type:'maintenance_type',description:'description',priority_code:'priority_code',due_on:'due_on',responsible_employee_id:'responsible_employee_id'};
    const assignments=Object.keys(body).map((key,index)=>{
      const placeholder=`$${index+3}`;
      return key==='status'&&body.status==='in_progress'
        ?`status=${placeholder},started_at=COALESCE(started_at,now())`
        :`${columns[key]}=${placeholder}`;
    });
    const values=Object.entries(body).map(([,value])=>value);
    const row=(await query<OrderRow>(`UPDATE maintenance_orders SET ${assignments.join(',')},updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[order.tenant_id,order.id,...values])).rows[0];
    await recordAudit(order.tenant_id,req.user!.id,body.status?'maintenance_order.status_changed':'maintenance_order.updated','maintenance_order',order.id,{previous_status:order.status,next_status:body.status??order.status,changed_fields:Object.keys(body)});
    if(body.status)await notifyResponsible(row,'Wartungsstatus aktualisiert',`${row.order_number}: ${maintenanceStatusLabels[effectiveMaintenanceStatus(row)]}`);
    res.json(withMaintenanceStatus(row));
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid maintenance order update'});next(error);}
});

maintenanceRouter.post('/maintenance-orders/:id/complete',requireAuth,requireCsrf,requirePermission('devices:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const order=await loadOrder(req,res,'devices:write');if(!order)return;
    if(!openStatuses.includes(order.status as typeof openStatuses[number]))return res.status(409).json({error:'Maintenance order is already finished'});
    const body=z.object({
      performed_work:z.string().trim().min(3).max(4000),
      result:z.string().trim().max(2000).nullable().optional(),
      remarks:z.string().trim().max(4000).nullable().optional(),
    }).strict().parse(req.body);
    const device=(await query<{maintenance_interval_days:number|string|null}>(`SELECT maintenance_interval_days FROM devices WHERE tenant_id=$1 AND id=$2 AND device_kind='operational'`,[order.tenant_id,order.device_id])).rows[0];
    const completedAt=new Date();
    const nextDate=nextMaintenanceDate(completedAt,device?.maintenance_interval_days);
    const updated=(await query<OrderRow>(
      `UPDATE maintenance_orders SET status='completed',completed_at=$3,performed_work=$4,result=$5,remarks=$6,next_maintenance_on=$7,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [order.tenant_id,order.id,completedAt,body.performed_work,body.result??null,body.remarks??null,nextDate],
    )).rows[0];
    await query(
      `UPDATE devices SET last_maintenance_on=CURRENT_DATE,next_maintenance_on=COALESCE($3::date,next_maintenance_on),updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND device_kind='operational'`,
      [order.tenant_id,order.device_id,nextDate],
    );
    await recordAudit(order.tenant_id,req.user!.id,'maintenance_order.completed','maintenance_order',order.id,{order_number:order.order_number,device_id:order.device_id,next_maintenance_on:nextDate});
    await notifyResponsible(updated,'Wartung abgeschlossen',`${order.order_number}: ${body.performed_work}`);
    res.json(withMaintenanceStatus(updated));
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid maintenance completion'});next(error);}
});

maintenanceRouter.post('/maintenance-orders/:id/cancel',requireAuth,requireCsrf,requirePermission('devices:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const order=await loadOrder(req,res,'devices:write');if(!order)return;
    if(!openStatuses.includes(order.status as typeof openStatuses[number]))return res.status(409).json({error:'Maintenance order is already finished'});
    const body=z.object({reason:z.string().trim().min(1).max(2000)}).strict().parse(req.body);
    const row=(await query<OrderRow>(`UPDATE maintenance_orders SET status='cancelled',remarks=CASE WHEN remarks IS NULL THEN $3 ELSE remarks||E'\n'||$3 END,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[order.tenant_id,order.id,body.reason])).rows[0];
    await recordAudit(order.tenant_id,req.user!.id,'maintenance_order.cancelled','maintenance_order',order.id,{order_number:order.order_number,reason:body.reason});
    res.json(withMaintenanceStatus(row));
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid cancellation request'});next(error);}
});

maintenanceRouter.post('/maintenance-orders/:id/documents',requireAuth,requireCsrf,requirePermission('devices:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const order=await loadOrder(req,res,'devices:write');if(!order)return;
    const body=z.object({document_id:uuid}).strict().parse(req.body);
    const document=(await query<{id:string;site_id:string|null}>(`SELECT id,site_id FROM dms_documents WHERE tenant_id=$1 AND id=$2 AND document_status='active'`,[order.tenant_id,body.document_id])).rows[0];
    if(!document||(document.site_id!==null&&document.site_id!==order.site_id))return res.status(404).json({error:'Document not found for this site'});
    const row=(await query(
      `INSERT INTO maintenance_order_documents(tenant_id,order_id,document_id,created_by) VALUES($1,$2,$3,$4)
       ON CONFLICT(tenant_id,order_id,document_id) DO NOTHING RETURNING *`,
      [order.tenant_id,order.id,body.document_id,req.user!.id],
    )).rows[0]??{order_id:order.id,document_id:body.document_id};
    await recordAudit(order.tenant_id,req.user!.id,'maintenance_order.document_linked','maintenance_order',order.id,{document_id:body.document_id});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid document link'});next(error);}
});

maintenanceRouter.delete('/maintenance-orders/:id/documents/:documentId',requireAuth,requireCsrf,requirePermission('devices:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const order=await loadOrder(req,res,'devices:write');if(!order)return;
    const documentId=uuid.parse(String(req.params.documentId));
    await query(`DELETE FROM maintenance_order_documents WHERE tenant_id=$1 AND order_id=$2 AND document_id=$3`,[order.tenant_id,order.id,documentId]);
    await recordAudit(order.tenant_id,req.user!.id,'maintenance_order.document_unlinked','maintenance_order',order.id,{document_id:documentId});
    res.status(204).end();
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid document id'});next(error);}
});
