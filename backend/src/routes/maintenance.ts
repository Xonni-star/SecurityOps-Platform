import type {PoolClient} from 'pg';
import {Router,type RequestHandler} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {queueNotificationEvent} from '../services/notifications.js';
import {effectiveMaintenanceStatus,maintenanceStatusLabels,nextMaintenanceDate,withMaintenanceStatus} from '../services/maintenance-domain.js';
import {runIdempotentMutation} from '../services/offline-sync.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();
const maintenanceTypes=['inspection','preventive','corrective','repair','other'] as const;
const priorities=['critical','high','medium','low'] as const;
const openStatuses=['planned','open','in_progress'] as const;
const createOrderBody=z.object({
  device_id:uuid,
  maintenance_type:z.enum(maintenanceTypes).default('inspection'),
  description:z.string().trim().min(3).max(4000),
  priority_code:z.enum(priorities).default('medium'),
  due_on:z.string().date().nullable().optional(),
  status:z.enum(openStatuses).default('planned'),
  responsible_employee_id:uuid.nullable().optional(),
}).strict();

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

/**
 * Locks an order for a state-changing workflow step inside the caller's
 * transaction. A concurrent request waits here and then sees the updated
 * status, so a second completion cannot overwrite the first one.
 */
async function lockOrder(client:PoolClient,tenantId:string,orderId:string):Promise<OrderRow|null>{
  const result=await client.query<OrderRow>(
    `SELECT o.* FROM maintenance_orders o WHERE o.tenant_id=$1 AND o.id=$2 FOR UPDATE`,
    [tenantId,orderId],
  );
  return result.rows[0]??null;
}

function isOpenOrder(order:OrderRow){
  return openStatuses.includes(order.status as typeof openStatuses[number]);
}

async function employeeAssignedToSite(tenantId:string,siteId:string,employeeId:string){
  return Boolean((await query(
    `SELECT 1 FROM employee_object_assignments oa
     WHERE oa.tenant_id=$1 AND oa.site_id=$2 AND oa.employee_id=$3
       AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)`,
    [tenantId,siteId,employeeId],
  )).rows[0]);
}

async function insertMaintenanceOrder(
  client:PoolClient,
  tenantId:string,
  userId:string,
  siteId:string,
  body:z.infer<typeof createOrderBody>,
):Promise<OrderRow>{
  const sequence=(await client.query<{next:string}>(`SELECT nextval('maintenance_order_number_seq')::text AS next`)).rows[0];
  const orderNumber=`MAIN-${new Date().getUTCFullYear()}-${String(sequence?.next??'').padStart(6,'0')}`;
  const row=(await client.query<OrderRow>(
    `INSERT INTO maintenance_orders(tenant_id,site_id,device_id,order_number,maintenance_type,description,priority_code,due_on,responsible_employee_id,status,created_by,started_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [tenantId,siteId,body.device_id,orderNumber,body.maintenance_type,body.description,body.priority_code,body.due_on??null,body.responsible_employee_id??null,body.status,userId,body.status==='in_progress'?new Date():null],
  )).rows[0];
  await recordAudit(tenantId,userId,'maintenance_order.created','maintenance_order',row.id,{site_id:siteId,device_id:body.device_id,order_number:orderNumber,status:body.status},client);
  return row;
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
         COALESCE(json_agg(json_build_object('id',link.id,'document_id',link.document_id,'document_title',ld.title,'document_status',ld.document_status) ORDER BY link.created_at) FILTER (WHERE link.id IS NOT NULL),'[]') AS documents
       FROM maintenance_orders o
       LEFT JOIN devices d ON d.tenant_id=o.tenant_id AND d.id=o.device_id AND d.device_kind='operational'
       LEFT JOIN employees e ON e.tenant_id=o.tenant_id AND e.id=o.responsible_employee_id
       LEFT JOIN maintenance_order_documents link ON link.tenant_id=o.tenant_id AND link.order_id=o.id
       LEFT JOIN dms_documents ld ON ld.tenant_id=link.tenant_id AND ld.id=link.document_id
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
    const body=createOrderBody.parse(req.body);
    const idempotencyKey=req.get('Idempotency-Key');
    const mutationId=idempotencyKey?uuid.safeParse(idempotencyKey):null;
    if(idempotencyKey&&!mutationId?.success)return res.status(400).json({error:'Invalid Idempotency-Key'});
    const device=(await query<{id:string;site_id:string}>(
      `SELECT id,site_id FROM devices WHERE tenant_id=$1 AND id=$2 AND device_kind='operational'`,
      [req.user!.tenantId,body.device_id],
    )).rows[0];
    if(!device||device.site_id!==siteId)return res.status(404).json({error:'Operational device not found at this site'});
    if(body.responsible_employee_id&&!await employeeAssignedToSite(req.user!.tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    let row:OrderRow;
    let replayed=false;
    if(mutationId?.success){
      const result=await withTransaction(client=>runIdempotentMutation(client,{
        tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:mutationId.data,
        action:'maintenance.order.create',payload:req.body,
      },tx=>insertMaintenanceOrder(tx,req.user!.tenantId,req.user!.id,siteId,body)));
      row=result.response;
      replayed=result.replayed;
    }else{
      row=await withTransaction(client=>insertMaintenanceOrder(client,req.user!.tenantId,req.user!.id,siteId,body));
    }
    if(!replayed)await notifyResponsible(row,'Wartungsauftrag erfasst',`${row.order_number}: ${row.description}`);
    res.status(replayed?200:201).json(withMaintenanceStatus(row));
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
    const row=(await query<OrderRow>(`UPDATE maintenance_orders SET ${assignments.join(',')},updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('planned','open','in_progress') RETURNING *`,[order.tenant_id,order.id,...values])).rows[0];
    if(!row)return res.status(409).json({error:'Maintenance order is already finished'});
    await recordAudit(order.tenant_id,req.user!.id,body.status?'maintenance_order.status_changed':'maintenance_order.updated','maintenance_order',order.id,{previous_status:order.status,next_status:body.status??order.status,changed_fields:Object.keys(body)});
    if(body.status)await notifyResponsible(row,'Wartungsstatus aktualisiert',`${row.order_number}: ${maintenanceStatusLabels[effectiveMaintenanceStatus(row)]}`);
    res.json(withMaintenanceStatus(row));
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid maintenance order update'});next(error);}
});

maintenanceRouter.post('/maintenance-orders/:id/complete',requireAuth,requireCsrf,requirePermission('devices:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    // Permission and existence are checked first; the definitive state check
    // happens under a row lock in the transaction below.
    const order=await loadOrder(req,res,'devices:write');if(!order)return;
    if(!isOpenOrder(order))return res.status(409).json({error:'Maintenance order is already finished'});
    const body=z.object({
      performed_work:z.string().trim().min(3).max(4000),
      result:z.string().trim().max(2000).nullable().optional(),
      remarks:z.string().trim().max(4000).nullable().optional(),
    }).strict().parse(req.body);

    type Completion={updated:OrderRow;nextDate:string|null;completedAt:Date};
    const completion=await withTransaction(async(client):Promise<Completion|null>=>{
      const locked=await lockOrder(client,order.tenant_id,order.id);
      if(!locked||!isOpenOrder(locked))return null;
      const device=(await client.query<{maintenance_interval_days:number|string|null}>(
        `SELECT maintenance_interval_days FROM devices WHERE tenant_id=$1 AND id=$2 AND device_kind='operational' FOR UPDATE`,
        [locked.tenant_id,locked.device_id],
      )).rows[0];
      const completedAt=new Date();
      const nextDate=nextMaintenanceDate(completedAt,device?.maintenance_interval_days);
      const updated=(await client.query<OrderRow>(
        `UPDATE maintenance_orders
            SET status='completed',completed_at=$3,completed_by=$4,performed_work=$5,result=$6,remarks=$7,
                next_maintenance_on=$8,started_at=COALESCE(started_at,$3),updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status IN ('planned','open','in_progress')
          RETURNING *`,
        [locked.tenant_id,locked.id,completedAt,req.user!.id,body.performed_work,body.result??null,body.remarks??null,nextDate],
      )).rows[0];
      if(!updated)return null;
      await client.query(
        `UPDATE devices SET last_maintenance_on=CURRENT_DATE,next_maintenance_on=COALESCE($3::date,next_maintenance_on),updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND device_kind='operational'`,
        [locked.tenant_id,locked.device_id,nextDate],
      );
      await recordAudit(locked.tenant_id,req.user!.id,'maintenance_order.completed','maintenance_order',locked.id,{
        order_number:locked.order_number,device_id:locked.device_id,next_maintenance_on:nextDate,
        performed_work:body.performed_work,result:body.result??null,completed_by:req.user!.id,
      },client);
      return {updated,nextDate,completedAt};
    });
    if(!completion)return res.status(409).json({error:'Maintenance order is already finished'});

    // Notification delivery is a side effect outside the database transaction.
    await notifyResponsible(completion.updated,'Wartung abgeschlossen',`${order.order_number}: ${body.performed_work}`);
    res.json(withMaintenanceStatus(completion.updated));
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid maintenance completion'});next(error);}
});

maintenanceRouter.post('/maintenance-orders/:id/cancel',requireAuth,requireCsrf,requirePermission('devices:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const order=await loadOrder(req,res,'devices:write');if(!order)return;
    if(!openStatuses.includes(order.status as typeof openStatuses[number]))return res.status(409).json({error:'Maintenance order is already finished'});
    const body=z.object({reason:z.string().trim().min(1).max(2000)}).strict().parse(req.body);
    const row=(await query<OrderRow>(`UPDATE maintenance_orders SET status='cancelled',remarks=CASE WHEN remarks IS NULL THEN $3 ELSE remarks||E'\n'||$3 END,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('planned','open','in_progress') RETURNING *`,[order.tenant_id,order.id,body.reason])).rows[0];
    if(!row)return res.status(409).json({error:'Maintenance order is already finished'});
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
