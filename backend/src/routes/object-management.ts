import {Router,type RequestHandler} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();
const nonempty=z.string().trim().min(1);
const relationshipSchema=z.object({
  customer_id:uuid,
  relationship_type:z.enum(['primary','branch','operational','billing','other']).default('operational'),
  starts_on:z.coerce.date().nullable().optional(),
  ends_on:z.coerce.date().nullable().optional(),
  notes:z.string().trim().max(4000).nullable().optional(),
}).strict();
const locationFields=z.object({
  parent_id:uuid.nullable().optional(),
  code:z.string().trim().max(80).nullable().optional(),
  name:nonempty.max(160),
  location_type:z.enum(['building','area','zone']),
  description:z.string().trim().max(4000).nullable().optional(),
  security_level:z.enum(['unknown','low','medium','high','critical']),
  hazard_notes:z.string().trim().max(4000).nullable().optional(),
  access_rules:z.string().trim().max(4000).nullable().optional(),
  responsible_employee_id:uuid.nullable().optional(),
  sort_order:z.number().int().min(0).max(100000),
}).strict();
const locationSchema=locationFields.extend({
  security_level:z.enum(['unknown','low','medium','high','critical']).default('unknown'),
  sort_order:z.number().int().min(0).max(100000).default(0),
}).strict();
const locationPatchSchema=locationFields.partial().strict().refine(value=>Object.keys(value).length>0,{message:'At least one field is required'});
const hazardFields=z.object({
  location_id:uuid.nullable().optional(),
  title:nonempty.max(160),
  category:z.enum(['burglary','theft','vandalism','fire','robbery','unauthorized_access','sabotage','conflict','technical','environmental','other']),
  description:nonempty.max(10000),
  likelihood:z.number().int().min(1).max(5),
  impact:z.number().int().min(1).max(5),
  protective_measures:z.string().trim().max(10000).nullable().optional(),
  required_actions:z.string().trim().max(10000).nullable().optional(),
  responsible_employee_id:uuid.nullable().optional(),
  due_on:z.string().date().nullable().optional(),
  review_on:z.string().date().nullable().optional(),
  status:z.enum(['open','mitigated','accepted','closed']),
}).strict();
const hazardSchema=hazardFields.extend({status:z.enum(['open','mitigated','accepted','closed']).default('open')}).strict()
  .refine(value=>!value.due_on||!value.review_on||value.review_on>=value.due_on,{message:'review_on must be on or after due_on'});
const hazardPatchSchema=hazardFields.partial().strict().refine(value=>Object.keys(value).length>0,{message:'At least one field is required'});
const instructionSchema=z.object({
  location_id:uuid.nullable().optional(),
  title:nonempty.max(200),
  content:nonempty.max(20000),
  version:z.number().int().positive().default(1),
  status:z.enum(['draft','pending_approval','approved','archived']).default('draft'),
  requires_acknowledgement:z.boolean().default(false),
  valid_from:z.string().date().nullable().optional(),
  valid_until:z.string().date().nullable().optional(),
  supersedes_id:uuid.nullable().optional(),
}).strict().refine(value=>!value.valid_from||!value.valid_until||value.valid_until>=value.valid_from,{message:'valid_until must be on or after valid_from'});

function patchAssignments<T extends object>(body:T,columns:Record<keyof T,string>,firstParameter:number){
  const entries=Object.entries(body);
  return {
    assignments:entries.map(([key],index)=>`${columns[key as keyof T]}=$${firstParameter+index}`).join(','),
    values:entries.map(([,value])=>value),
  };
}

export const objectManagementRouter=Router();

function requireSiteScope(permission:string):RequestHandler{
  return async(req,res,next)=>{
    try{
      const siteId=uuid.parse(String(req.params.id));
      const user=req.user!;
      const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
      const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
      if(!scope)return res.status(403).json({error:'Insufficient permissions'});
      if(scope==='own'){
        const owner=await query('SELECT 1 FROM resource_owners WHERE tenant_id=$1 AND resource=$2 AND resource_id=$3 AND user_id=$4',[user.tenantId,'sites',siteId,user.id]);
        if(!owner.rowCount)return res.status(403).json({error:'Permission scope does not include this site'});
      }else if(!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},scope,{tenantId:user.tenantId,siteId})){
        return res.status(403).json({error:'Permission scope does not include this site'});
      }
      next();
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid site id'});next(error);}
  };
}

objectManagementRouter.get(
  '/sites/:id/object-context',
  requireAuth,
  requirePermission('sites:read',{allowedScopes:['tenant','site','own','system']}),
  requireSiteScope('sites:read'),
  async(req,res,next)=>{
    try{
      const id=uuid.parse(String(req.params.id));
      const site=(await query(
        `SELECT s.*,om.name AS object_manager_name,op.name AS operations_manager_name
         FROM sites s
         LEFT JOIN employees om ON om.tenant_id=s.tenant_id AND om.id=s.object_manager_employee_id
         LEFT JOIN employees op ON op.tenant_id=s.tenant_id AND op.id=s.operations_manager_employee_id
         WHERE s.tenant_id=$1 AND s.id=$2`,
        [req.user!.tenantId,id],
      )).rows[0];
      if(!site)return res.status(404).json({error:'Not found'});
      const user=req.user!;
      const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
      const canReadTenantData=(code:string)=>{
        const scope=effectivePermissionScope(grants,code,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
        return scope==='tenant'||scope==='system';
      };
      const canReadSiteData=(code:string)=>{
        const scope=effectivePermissionScope(grants,code,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
        return scope!==null&&canAccessResource(
          {userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},
          scope,
          {tenantId:user.tenantId,siteId:id},
        );
      };
      const customers=canReadTenantData('customers:read')?(await query(
        `SELECT cs.*,c.name AS customer_name,c.customer_number
         FROM customer_sites cs JOIN customers c ON c.tenant_id=cs.tenant_id AND c.id=cs.customer_id
         WHERE cs.tenant_id=$1 AND cs.site_id=$2
         ORDER BY cs.is_primary DESC,c.name`,
        [req.user!.tenantId,id],
      )).rows:null;
      const contracts=canReadTenantData('contracts:read')?(await query(
        `SELECT con.id,con.contract_number,con.contract_type,con.status,con.customer_id,c.name AS customer_name
         FROM contract_sites cts
         JOIN contracts con ON con.tenant_id=cts.tenant_id AND con.id=cts.contract_id
         JOIN customers c ON c.tenant_id=cts.tenant_id AND c.id=cts.customer_id
         WHERE cts.tenant_id=$1 AND cts.site_id=$2
         ORDER BY con.starts_on DESC,con.contract_number`,
        [req.user!.tenantId,id],
      )).rows:null;
      const locations=(await query(
        `SELECT l.*,e.name AS responsible_employee_name
         FROM object_locations l
         LEFT JOIN employees e ON e.tenant_id=l.tenant_id AND e.id=l.responsible_employee_id
         WHERE l.tenant_id=$1 AND l.site_id=$2 ORDER BY l.parent_id NULLS FIRST,l.sort_order,l.name`,
        [req.user!.tenantId,id],
      )).rows;
      const hazards=(await query(
        `SELECT h.*,l.name AS location_name,e.name AS responsible_employee_name
         FROM object_hazards h
         LEFT JOIN object_locations l ON l.tenant_id=h.tenant_id AND l.id=h.location_id
         LEFT JOIN employees e ON e.tenant_id=h.tenant_id AND e.id=h.responsible_employee_id
         WHERE h.tenant_id=$1 AND h.site_id=$2 ORDER BY h.status,h.risk_score DESC,h.title`,
        [req.user!.tenantId,id],
      )).rows;
      const instructions=(await query(
        `SELECT i.*,l.name AS location_name,u.email AS created_by_email,
          (SELECT count(*)::int FROM instruction_acknowledgements a WHERE a.tenant_id=i.tenant_id AND a.instruction_id=i.id AND a.acknowledged_version=i.version) AS acknowledgement_count
         FROM site_instructions i
         LEFT JOIN object_locations l ON l.tenant_id=i.tenant_id AND l.id=i.location_id
         JOIN users u ON u.tenant_id=i.tenant_id AND u.id=i.created_by
         WHERE i.tenant_id=$1 AND i.site_id=$2 AND i.status<>'archived'
         ORDER BY i.title,i.version DESC`,
        [req.user!.tenantId,id],
      )).rows;
      const canReadWatchbook=canReadSiteData('watchbook:read');
      const journal=canReadWatchbook?(await query(
        `SELECT e.id,e.site_id,e.created_by,e.created_at,e.client_entry_id,
          r.revision_no,r.content,r.status,c.name AS category_name,p.name AS priority_name
         FROM watchbook_entries e
         JOIN LATERAL (
           SELECT r0.* FROM watchbook_revisions r0
           WHERE r0.tenant_id=e.tenant_id AND r0.entry_id=e.id
           ORDER BY r0.revision_no DESC LIMIT 1
         ) r ON true
         JOIN watchbook_categories c ON c.tenant_id=e.tenant_id AND c.id=r.category_id
         JOIN watchbook_priorities p ON p.tenant_id=e.tenant_id AND p.id=r.priority_id
         WHERE e.tenant_id=$1 AND e.site_id=$2
         ORDER BY e.created_at DESC LIMIT 20`,
        [user.tenantId,id],
      )).rows:null;
      const canReadStaffing=canReadSiteData('employees:read');
      const staffing=canReadStaffing?(await query(
        `SELECT oa.id,oa.employee_id,e.name AS employee_name,oa.assignment_type,oa.role,oa.starts_on,oa.ends_on,
          oa.primary_assignment,oa.notes
         FROM employee_object_assignments oa
         JOIN employees e ON e.tenant_id=oa.tenant_id AND e.id=oa.employee_id
         WHERE oa.tenant_id=$1 AND oa.site_id=$2
           AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
         ORDER BY oa.starts_on<=CURRENT_DATE DESC,oa.primary_assignment DESC,oa.starts_on, e.name`,
        [user.tenantId,id],
      )).rows:null;
      const canReadSchedule=canReadSiteData('scheduling:read');
      const shifts=canReadSchedule?(await query(
        `SELECT p.id AS period_id,p.name AS period_name,p.status AS period_status,
          p.starts_at AS period_starts_at,p.ends_at AS period_ends_at,
          sh.id,sh.role_code,sh.starts_at,sh.ends_at,sh.required_qualification_codes,
          COUNT(a.id)::int AS assigned_count,
          CASE WHEN $3::boolean THEN
            COALESCE(json_agg(json_build_object('id',a.id,'employee_id',a.employee_id,'employee_name',e.name) ORDER BY e.name)
              FILTER (WHERE a.id IS NOT NULL),'[]'::json)
          ELSE '[]'::json END AS assignments
         FROM schedule_periods p
         JOIN schedule_shifts sh ON sh.tenant_id=p.tenant_id AND sh.period_id=p.id AND sh.site_id=p.site_id
         LEFT JOIN schedule_assignments a ON a.tenant_id=sh.tenant_id AND a.shift_id=sh.id AND a.status='assigned'
         LEFT JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id
         WHERE p.tenant_id=$1 AND p.site_id=$2 AND p.ends_at>=now() AND sh.ends_at>=now()
         GROUP BY p.id,sh.id ORDER BY sh.starts_at,sh.role_code`,
        [user.tenantId,id,canReadStaffing],
      )).rows:null;
      const canReadPatrols=canReadSiteData('patrols:read');
      const patrols=canReadPatrols?{
        routes:(await query(
          `SELECT r.id,r.name,r.expected_start,r.expected_end,
            COALESCE((
              SELECT json_agg(json_build_object(
                'control_point_id',rp.control_point_id,'name',cp.name,'sequence',rp.sequence,
                'expected_offset_seconds',rp.expected_offset_seconds
              ) ORDER BY rp.sequence)
              FROM patrol_route_points rp
              JOIN control_points cp ON cp.tenant_id=r.tenant_id AND cp.id=rp.control_point_id
              WHERE rp.tenant_id=r.tenant_id AND rp.route_id=r.id
            ),'[]'::json) AS points,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id',pa.id,'starts_at',pa.starts_at,'ends_at',pa.ends_at,
                'employee_name',CASE WHEN $3::boolean THEN e.name ELSE NULL END
              ) ORDER BY pa.starts_at)
              FROM patrol_assignments pa
              LEFT JOIN employees e ON e.tenant_id=pa.tenant_id AND e.id=pa.employee_id
              WHERE pa.tenant_id=r.tenant_id AND pa.route_id=r.id
                AND (pa.ends_at IS NULL OR pa.ends_at>=now())
            ),'[]'::json) AS assignments
           FROM patrol_routes r
           WHERE r.tenant_id=$1 AND r.site_id=$2
           ORDER BY r.name,r.created_at DESC`,
          [user.tenantId,id,canReadStaffing],
        )).rows,
        recentScans:(await query(
          `SELECT ps.id,ps.scanned_at,ps.deviation,r.id AS route_id,r.name AS route_name,
            cp.id AS control_point_id,cp.name AS control_point_name,
            CASE WHEN $3::boolean THEN e.name ELSE NULL END AS employee_name
           FROM patrol_scans ps
           JOIN patrol_routes r ON r.tenant_id=ps.tenant_id AND r.id=ps.route_id AND r.site_id=$2
           JOIN control_points cp ON cp.tenant_id=ps.tenant_id AND cp.id=ps.control_point_id
           LEFT JOIN employees e ON e.tenant_id=ps.tenant_id AND e.id=ps.employee_id
           WHERE ps.tenant_id=$1
           ORDER BY ps.scanned_at DESC LIMIT 20`,
          [user.tenantId,id,canReadStaffing],
        )).rows,
      }:null;
      const keys=canReadSiteData('keys:read')?{
        items:(await query(
          `SELECT id,key_code,label,key_type,status,holder_user_id,holder_employee_id,issued_at,returned_at,lost_at,deactivated_at
           FROM keys WHERE tenant_id=$1 AND site_id=$2 ORDER BY label`,
          [user.tenantId,id],
        )).rows,
        recentMovements:(await query(
          `SELECT m.id,m.key_id,k.label AS key_label,m.movement_type,m.from_status,m.to_status,m.created_at,
            CASE WHEN $3::boolean THEN e.name ELSE NULL END AS employee_name
           FROM key_movements m
           JOIN keys k ON k.tenant_id=m.tenant_id AND k.id=m.key_id AND k.site_id=$2
           LEFT JOIN employees e ON e.tenant_id=m.tenant_id AND e.id=m.holder_employee_id
           WHERE m.tenant_id=$1
           ORDER BY m.created_at DESC LIMIT 20`,
          [user.tenantId,id,canReadStaffing],
        )).rows,
      }:null;
      const keyBundles=canReadSiteData('keys:bundle_read')?(await query(
        `SELECT b.id,b.name,b.status,b.holder_user_id,b.holder_employee_id,
          COUNT(i.key_id)::int AS item_count,
          COUNT(i.key_id) FILTER (WHERE k.status='issued')::int AS issued_count
         FROM key_bundles b
         LEFT JOIN key_bundle_items i ON i.tenant_id=b.tenant_id AND i.bundle_id=b.id
         LEFT JOIN keys k ON k.tenant_id=i.tenant_id AND k.id=i.key_id
         WHERE b.tenant_id=$1 AND b.site_id=$2
         GROUP BY b.id ORDER BY b.name`,
        [user.tenantId,id],
      )).rows:null;
      const canReadDocuments=canReadSiteData('dms:read');
      const canReadCustomerDocuments=canReadTenantData('customer_documents:read');
      const documents=canReadDocuments?(await query(
        `SELECT d.id,d.title,d.description,d.document_status,d.created_at,d.deleted_at,
          COALESCE(json_agg(json_build_object(
            'id',v.id,'version_no',v.version_no,'size_bytes',v.size_bytes,'content_type',v.content_type,
            'lifecycle_state',v.lifecycle_state,'created_at',v.created_at,'retention_until',v.retention_until
          ) ORDER BY v.version_no DESC) FILTER (WHERE v.id IS NOT NULL),'[]') AS versions
         FROM dms_documents d
         LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
         WHERE d.tenant_id=$1 AND d.site_id=$2
           AND ($3::boolean OR d.customer_id IS NULL)
         GROUP BY d.id ORDER BY d.created_at DESC`,
        [user.tenantId,id,canReadCustomerDocuments],
      )).rows:null;
      const alarms=canReadSiteData('alarms:read')?(await query(
        `SELECT a.id,a.site_id,a.type,a.description,a.severity,a.status,a.triggered_at,a.acknowledged_at,a.resolved_at,
          p.name AS priority_name
         FROM alarms a
         LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
         LEFT JOIN devices d ON d.tenant_id=a.tenant_id AND d.id=a.device_id
         WHERE a.tenant_id=$1 AND (a.site_id=$2 OR (a.site_id IS NULL AND d.site_id=$2))
         ORDER BY a.triggered_at DESC LIMIT 20`,
        [user.tenantId,id],
      )).rows:null;
      const incidents=canReadSiteData('incidents:read')?(await query(
        `SELECT i.id,COALESCE(i.site_id,a.site_id) AS site_id,i.alarm_id,i.description,i.status,i.created_at,i.updated_at,
          p.name AS priority_name,
          CASE WHEN $3::boolean THEN e.name ELSE NULL END AS employee_name,
          COUNT(DISTINCT ia.employee_id)::int AS assigned_count,
          CASE WHEN $3::boolean THEN
            COALESCE(json_agg(json_build_object('id',ae.id,'name',ae.name) ORDER BY ae.name)
              FILTER (WHERE ae.id IS NOT NULL),'[]'::json)
          ELSE '[]'::json END AS assignees
         FROM incidents i
         LEFT JOIN alarms a ON a.tenant_id=i.tenant_id AND a.id=i.alarm_id
         LEFT JOIN alarm_priorities p ON p.tenant_id=i.tenant_id AND p.id=i.priority_id
         LEFT JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id
         LEFT JOIN incident_assignments ia ON ia.incident_id=i.id
         LEFT JOIN employees ae ON ae.tenant_id=i.tenant_id AND ae.id=ia.employee_id
         WHERE i.tenant_id=$1 AND (i.site_id=$2 OR (i.site_id IS NULL AND a.site_id=$2))
         GROUP BY i.id,a.site_id,p.name,e.name
         ORDER BY i.created_at DESC LIMIT 20`,
        [user.tenantId,id,canReadStaffing],
      )).rows:null;
      const customerTasks=canReadTenantData('customers:read')?(await query(
        `SELECT t.id,t.customer_id,c.name AS customer_name,t.title,t.description,t.status,t.due_at,t.assigned_employee_id,
          CASE WHEN $3::boolean THEN e.name ELSE NULL END AS assigned_employee_name,t.created_at,t.completed_at
         FROM customer_tasks t
         JOIN customer_sites cs ON cs.tenant_id=t.tenant_id AND cs.customer_id=t.customer_id
         JOIN customers c ON c.tenant_id=t.tenant_id AND c.id=t.customer_id
         LEFT JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.assigned_employee_id
         WHERE t.tenant_id=$1 AND cs.site_id=$2 AND cs.relationship_status='active'
         ORDER BY t.status,t.due_at NULLS LAST,t.created_at DESC LIMIT 100`,
        [user.tenantId,id,canReadStaffing],
      )).rows:null;
      const maintenance=canReadWatchbook?(await query(
        `SELECT e.id,e.created_at,r.revision_no,r.content,r.status,p.name AS priority_name
         FROM watchbook_entries e
         JOIN LATERAL (
           SELECT r0.* FROM watchbook_revisions r0
           WHERE r0.tenant_id=e.tenant_id AND r0.entry_id=e.id
           ORDER BY r0.revision_no DESC LIMIT 1
         ) r ON true
         JOIN watchbook_categories c ON c.tenant_id=e.tenant_id AND c.id=r.category_id AND c.code='maintenance'
         JOIN watchbook_priorities p ON p.tenant_id=e.tenant_id AND p.id=r.priority_id
         WHERE e.tenant_id=$1 AND e.site_id=$2
         ORDER BY e.created_at DESC LIMIT 20`,
        [user.tenantId,id],
      )).rows:null;
      const qualifications=canReadStaffing&&canReadSiteData('qualifications:read')?(await query(
        `SELECT q.id,q.employee_id,e.name AS employee_name,q.code,c.name AS qualification_name,
          q.valid_from,q.valid_until,q.status,
          CASE WHEN q.status IN ('revoked','invalid') THEN q.status
            WHEN q.valid_until IS NULL THEN 'valid'
            WHEN q.valid_until<CURRENT_DATE THEN 'expired'
            WHEN q.valid_until<=CURRENT_DATE+INTERVAL '90 days' THEN 'expiring'
            ELSE 'valid' END AS computed_status
         FROM employee_qualifications q
         JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
         LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.code=q.code
         WHERE q.tenant_id=$1 AND EXISTS (
           SELECT 1 FROM employee_object_assignments oa
           WHERE oa.tenant_id=q.tenant_id AND oa.employee_id=q.employee_id AND oa.site_id=$2
             AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
         )
         ORDER BY e.name,c.name,q.valid_until NULLS LAST LIMIT 200`,
        [user.tenantId,id],
      )).rows:null;
      const handovers=canReadSiteData('handover:read')?(await query(
        `SELECT h.id,h.shift_id,h.title,h.status,h.created_at,
          (SELECT count(*)::int FROM handover_participants p
           WHERE p.tenant_id=h.tenant_id AND p.handover_id=h.id AND p.state='active') AS participant_count,
          (SELECT count(*)::int FROM handover_confirmations c
           WHERE c.tenant_id=h.tenant_id AND c.handover_id=h.id AND c.state='confirmed') AS confirmation_count
         FROM handover_records h
         WHERE h.tenant_id=$1 AND h.site_id=$2
         ORDER BY h.created_at DESC LIMIT 20`,
        [user.tenantId,id],
      )).rows:null;
      res.json({site,customers,contracts,locations,hazards,instructions,journal,staffing,shifts,patrols,keys,keyBundles,documents,alarms,incidents,customerTasks,maintenance,qualifications,handovers});
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid site id'});next(error);}
  },
);

objectManagementRouter.post('/sites/:id/locations',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const body=locationSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
    if(!site)return res.status(404).json({error:'Site not found'});
    if(body.parent_id){
      const parent=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.parent_id])).rows[0];
      if(!parent)return res.status(400).json({error:'Parent location not found in site'});
    }
    if(body.responsible_employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.responsible_employee_id])).rows[0];
      if(!employee)return res.status(400).json({error:'Responsible employee not found'});
    }
    const row=(await query(`INSERT INTO object_locations(tenant_id,site_id,parent_id,code,name,location_type,description,security_level,hazard_notes,access_rules,responsible_employee_id,sort_order)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tenantId,siteId,body.parent_id??null,body.code??null,body.name,body.location_type,body.description??null,body.security_level,body.hazard_notes??null,body.access_rules??null,body.responsible_employee_id??null,body.sort_order])).rows[0];
    await recordAudit(tenantId,req.user!.id,'site.location.created','object_locations',row.id,{site_id:siteId,location_type:body.location_type});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid location'});next(error);}
});

objectManagementRouter.patch('/sites/:id/locations/:locationId',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const locationId=uuid.parse(String(req.params.locationId)); const body=locationPatchSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const current=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,locationId])).rows[0];
    if(!current)return res.status(404).json({error:'Location not found'});
    if(body.parent_id){
      const parent=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.parent_id])).rows[0];
      if(!parent)return res.status(400).json({error:'Parent location not found in site'});
      const cycle=(await query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND parent_id=$3
          UNION
           SELECT child.id FROM object_locations child JOIN descendants d ON child.parent_id=d.id
           WHERE child.tenant_id=$1 AND child.site_id=$2
         )
         SELECT 1 FROM descendants WHERE id=$4`,
        [tenantId,siteId,locationId,body.parent_id],
      )).rows[0];
      if(body.parent_id===locationId||cycle)return res.status(400).json({error:'Parent location would create a hierarchy cycle'});
    }
    if(body.responsible_employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.responsible_employee_id])).rows[0];
      if(!employee)return res.status(400).json({error:'Responsible employee not found'});
    }
    const columns:Record<keyof typeof body,string>={parent_id:'parent_id',code:'code',name:'name',location_type:'location_type',description:'description',security_level:'security_level',hazard_notes:'hazard_notes',access_rules:'access_rules',responsible_employee_id:'responsible_employee_id',sort_order:'sort_order'};
    const patch=patchAssignments(body,columns,4);
    const row=(await query(
      `UPDATE object_locations SET ${patch.assignments},updated_at=now()
       WHERE tenant_id=$1 AND site_id=$2 AND id=$3 RETURNING *`,
      [tenantId,siteId,locationId,...patch.values],
    )).rows[0];
    if(!row)return res.status(404).json({error:'Location not found'});
    await recordAudit(tenantId,req.user!.id,'site.location.updated','object_locations',locationId,{site_id:siteId,changed_fields:Object.keys(body)});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid location'});next(error);}
});

objectManagementRouter.post('/sites/:id/hazards',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const body=hazardSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
    if(!site)return res.status(404).json({error:'Site not found'});
    if(body.location_id){
      const location=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.location_id])).rows[0];
      if(!location)return res.status(400).json({error:'Location not found in site'});
    }
    if(body.responsible_employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.responsible_employee_id])).rows[0];
      if(!employee)return res.status(400).json({error:'Responsible employee not found'});
    }
    const row=(await query(`INSERT INTO object_hazards(tenant_id,site_id,location_id,title,category,description,likelihood,impact,protective_measures,required_actions,responsible_employee_id,due_on,review_on,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [tenantId,siteId,body.location_id??null,body.title,body.category,body.description,body.likelihood,body.impact,body.protective_measures??null,body.required_actions??null,body.responsible_employee_id??null,body.due_on??null,body.review_on??null,body.status,req.user!.id])).rows[0];
    await recordAudit(tenantId,req.user!.id,'site.hazard.created','object_hazards',row.id,{site_id:siteId,risk_score:body.likelihood*body.impact});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid hazard'});next(error);}
});

objectManagementRouter.patch('/sites/:id/hazards/:hazardId',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const hazardId=uuid.parse(String(req.params.hazardId)); const body=hazardPatchSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const current=(await query('SELECT id,due_on,review_on,likelihood,impact FROM object_hazards WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,hazardId])).rows[0];
    if(!current)return res.status(404).json({error:'Hazard not found'});
    if(body.location_id){
      const location=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.location_id])).rows[0];
      if(!location)return res.status(400).json({error:'Location not found in site'});
    }
    if(body.responsible_employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.responsible_employee_id])).rows[0];
      if(!employee)return res.status(400).json({error:'Responsible employee not found'});
    }
    const dueOn=body.due_on===undefined?(current.due_on?String(current.due_on).slice(0,10):null):body.due_on;
    const reviewOn=body.review_on===undefined?(current.review_on?String(current.review_on).slice(0,10):null):body.review_on;
    if(dueOn&&reviewOn&&reviewOn<dueOn)return res.status(400).json({error:'review_on must be on or after due_on'});
    const columns:Record<keyof typeof body,string>={location_id:'location_id',title:'title',category:'category',description:'description',likelihood:'likelihood',impact:'impact',protective_measures:'protective_measures',required_actions:'required_actions',responsible_employee_id:'responsible_employee_id',due_on:'due_on',review_on:'review_on',status:'status'};
    const patch=patchAssignments(body,columns,4);
    const row=(await query(
      `UPDATE object_hazards SET ${patch.assignments},updated_at=now()
       WHERE tenant_id=$1 AND site_id=$2 AND id=$3 RETURNING *`,
      [tenantId,siteId,hazardId,...patch.values],
    )).rows[0];
    if(!row)return res.status(404).json({error:'Hazard not found'});
    await recordAudit(tenantId,req.user!.id,'site.hazard.updated','object_hazards',hazardId,{site_id:siteId,changed_fields:Object.keys(body),risk_score:(body.likelihood??Number(current.likelihood))*(body.impact??Number(current.impact))});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid hazard'});next(error);}
});

objectManagementRouter.post('/sites/:id/instructions',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const body=instructionSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
    if(!site)return res.status(404).json({error:'Site not found'});
    if(body.location_id){
      const location=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.location_id])).rows[0];
      if(!location)return res.status(400).json({error:'Location not found in site'});
    }
    if(body.supersedes_id){
      const previous=(await query('SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.supersedes_id])).rows[0];
      if(!previous)return res.status(400).json({error:'Superseded instruction not found in site'});
    }
    if(body.status==='approved'&&!req.user!.isSystemAdmin&&req.user!.role==='viewer')return res.status(403).json({error:'Only operators may approve instructions'});
    const row=(await query(`INSERT INTO site_instructions(tenant_id,site_id,location_id,title,content,version,status,requires_acknowledgement,valid_from,valid_until,created_by,approved_by,approved_at,supersedes_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $7='approved' THEN now() ELSE NULL END,$13) RETURNING *`,
      [tenantId,siteId,body.location_id??null,body.title,body.content,body.version,body.status,body.requires_acknowledgement,body.valid_from??null,body.valid_until??null,req.user!.id,body.status==='approved'?req.user!.id:null,body.supersedes_id??null])).rows[0];
    await recordAudit(tenantId,req.user!.id,'site.instruction.created','site_instructions',row.id,{site_id:siteId,version:body.version,status:body.status});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid instruction'});next(error);}
});

objectManagementRouter.post('/sites/:id/instructions/:instructionId/acknowledgements',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const instructionId=uuid.parse(String(req.params.instructionId));
    const body=z.object({employee_id:uuid}).strict().parse(req.body); const tenantId=req.user!.tenantId;
    const instruction=(await query('SELECT id,version,status FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,instructionId])).rows[0];
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.employee_id])).rows[0];
    if(!instruction||!employee)return res.status(404).json({error:'Instruction or employee not found'});
    if(instruction.status!=='approved')return res.status(409).json({error:'Only approved instructions can be acknowledged'});
    const row=(await query(`INSERT INTO instruction_acknowledgements(tenant_id,instruction_id,employee_id,acknowledged_version)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,[tenantId,instructionId,body.employee_id,instruction.version])).rows[0];
    if(row)await recordAudit(tenantId,req.user!.id,'site.instruction.acknowledged','instruction_acknowledgements',instructionId,{site_id:siteId,employee_id:body.employee_id,version:instruction.version});
    res.status(row?201:200).json(row??{acknowledged:true,version:instruction.version});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid acknowledgement'});next(error);}
});

objectManagementRouter.post(
  '/sites/:id/customer-links',
  requireAuth,
  requireCsrf,
  requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),
  requirePermission('customers:write'),
  requireSiteScope('sites:write'),
  async(req,res,next)=>{
    try{
      const siteId=uuid.parse(String(req.params.id));
      const body=relationshipSchema.parse(req.body);
      const tenantId=req.user!.tenantId;
      const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
      const customer=(await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,body.customer_id])).rows[0];
      if(!site||!customer)return res.status(404).json({error:'Site or customer not found'});
      if(body.ends_on&&body.starts_on&&body.ends_on<body.starts_on)return res.status(400).json({error:'Invalid relationship dates'});
      const link=(await query(
        `INSERT INTO customer_sites(tenant_id,customer_id,site_id,relationship_type,starts_on,ends_on,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,customer_id,site_id) DO UPDATE SET
           relationship_type=EXCLUDED.relationship_type,starts_on=EXCLUDED.starts_on,
           ends_on=EXCLUDED.ends_on,notes=EXCLUDED.notes,relationship_status='active',updated_at=now()
         RETURNING *`,
        [tenantId,body.customer_id,siteId,body.relationship_type,body.starts_on??null,body.ends_on??null,body.notes??null],
      )).rows[0];
      await recordAudit(tenantId,req.user!.id,'site.customer_linked','customer_sites',link.id,{site_id:siteId,customer_id:body.customer_id});
      res.status(201).json(link);
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid customer relationship'});next(error);}
  },
);

objectManagementRouter.delete(
  '/sites/:id/customer-links/:customerId',
  requireAuth,
  requireCsrf,
  requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),
  requirePermission('customers:write'),
  requireSiteScope('sites:write'),
  async(req,res,next)=>{
    try{
      const siteId=uuid.parse(String(req.params.id));
      const customerId=uuid.parse(String(req.params.customerId));
      const result=await query(
        `UPDATE customer_sites SET relationship_status='archived',updated_at=now()
         WHERE tenant_id=$1 AND site_id=$2 AND customer_id=$3 AND relationship_status<>'archived'
         RETURNING id`,
        [req.user!.tenantId,siteId,customerId],
      );
      if(!result.rowCount)return res.status(404).json({error:'Relationship not found'});
      await recordAudit(req.user!.tenantId,req.user!.id,'site.customer_link_archived','customer_sites',result.rows[0].id,{site_id:siteId,customer_id:customerId});
      res.status(204).send();
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid relationship id'});next(error);}
  },
);
