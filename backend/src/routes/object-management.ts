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
type LocationType='building'|'area'|'zone';
const parentTypeFor:Record<LocationType,LocationType|null>={building:null,area:'building',zone:'area'};
const hazardFields=z.object({
  location_id:uuid.nullable().optional(),
  title:nonempty.max(160),
  category:z.enum(['burglary','theft','vandalism','fire','robbery','unauthorized_access','sabotage','conflict','technical','environmental','other']),
  description:nonempty.max(10000),
  likelihood:z.number().int().min(1).max(5),
  impact:z.number().int().min(1).max(5),
  protective_measures:z.string().trim().max(10000).nullable().optional(),
  responsible_employee_id:uuid.nullable().optional(),
  due_on:z.string().date().nullable().optional(),
  review_on:z.string().date().nullable().optional(),
  status:z.enum(['open','mitigated','accepted','closed']),
}).strict();
const hazardSchema=hazardFields.extend({status:z.enum(['open','mitigated','accepted','closed']).default('open')}).strict()
  .refine(value=>!value.due_on||!value.review_on||value.review_on>=value.due_on,{message:'review_on must be on or after due_on'});
const hazardPatchSchema=hazardFields.partial().strict().refine(value=>Object.keys(value).length>0,{message:'At least one field is required'});
const hazardMeasureFields=z.object({
  title:nonempty.max(160),
  description:z.string().trim().max(4000).nullable().optional(),
  responsible_employee_id:uuid.nullable().optional(),
  due_on:z.string().date().nullable().optional(),
  status:z.enum(['open','in_progress','completed','cancelled']),
}).strict();
const hazardMeasureSchema=hazardMeasureFields.extend({status:z.enum(['open','in_progress','completed','cancelled']).default('open')}).strict();
const hazardMeasurePatchSchema=hazardMeasureFields.partial().strict().refine(value=>Object.keys(value).length>0,{message:'At least one field is required'});
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

objectManagementRouter.get(
  '/sites/overview-dashboard',
  requireAuth,
  requirePermission('sites:read',{allowedScopes:['tenant','site','own','system']}),
  async(req,res,next)=>{
    try{
      const user=req.user!;
      const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
      const authorization={userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants};
      const siteScope=effectivePermissionScope(grants,'sites:read',{role:user.role,isSystemAdmin:user.isSystemAdmin===true})!;
      const scopeFilter=siteScope==='site'
        ?' AND s.id=ANY($2::uuid[])'
        :siteScope==='own'
          ?` AND EXISTS (SELECT 1 FROM resource_owners ro WHERE ro.tenant_id=s.tenant_id AND ro.resource='sites' AND ro.resource_id=s.id AND ro.user_id=$2)`
          :'';
      const scopeValues=siteScope==='site'?[user.siteIds??[]]:siteScope==='own'?[user.id]:[];
      const visibleSites=(await query<{id:string}>(
        `SELECT s.id FROM sites s WHERE s.tenant_id=$1${scopeFilter}`,
        [user.tenantId,...scopeValues],
      )).rows;
      const visibleSiteIds=visibleSites.map(site=>site.id);
      const canReadSiteData=(permission:string,siteId:string)=>{
        const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
        return scope!==null&&canAccessResource(authorization,scope,{tenantId:user.tenantId,siteId});
      };
      const customerSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('customers:read',siteId));
      const contractSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('contracts:read',siteId));
      const employeeSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('employees:read',siteId));
      const documentSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('dms:read',siteId));
      const watchbookSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('watchbook:read',siteId));
      const scheduleSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('scheduling:read',siteId));
      const taskSiteIds=customerSiteIds;
      const hasContractRead=effectivePermissionScope(grants,'contracts:read',{role:user.role,isSystemAdmin:user.isSystemAdmin===true})!==null;
      const hasDocumentRead=effectivePermissionScope(grants,'dms:read',{role:user.role,isSystemAdmin:user.isSystemAdmin===true})!==null;
      type OverviewSite={
        id:string;name:string;site_number:string|null;address:string|null;alias:string|null;site_type:string|null;
        status:string;security_classification:string;object_manager_employee_id:string|null;object_manager_name:string|null;
        operations_manager_employee_id:string|null;operations_manager_name:string|null;customer_names:string[]|null;
        assigned_employee_count:number|null;active_contract_count:number|null;expiring_contract_count:number|null;
        contract_statuses:string[]|null;open_hazard_count:number;critical_hazard_count:number;overdue_measure_count:number;
        open_task_count:number|null;overdue_task_count:number|null;open_shift_count:number|null;undercovered_shift_count:number|null;
        required_staff_count:number;understaffed:boolean;available_document_count:number|null;last_activity:string|null;
      };
      const sites=(await query<OverviewSite>(
        `WITH customer_summary AS (
           SELECT cs.site_id,array_agg(DISTINCT c.name ORDER BY c.name) AS customer_names
           FROM customer_sites cs JOIN customers c ON c.tenant_id=cs.tenant_id AND c.id=cs.customer_id
           WHERE cs.tenant_id=$1 AND cs.site_id=ANY($3::uuid[]) AND cs.relationship_status='active'
           GROUP BY cs.site_id
         ), contract_summary AS (
           SELECT cts.site_id,
             count(*) FILTER (WHERE con.status IN ('active','expiring') AND con.starts_on<=CURRENT_DATE AND (con.ends_on IS NULL OR con.ends_on>=CURRENT_DATE))::int AS active_contract_count,
               count(*) FILTER (WHERE con.status IN ('active','expiring') AND con.ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE+30)::int AS expiring_contract_count,
               array_agg(DISTINCT con.status ORDER BY con.status) AS contract_statuses
           FROM contract_sites cts JOIN contracts con ON con.tenant_id=cts.tenant_id AND con.id=cts.contract_id
           WHERE cts.tenant_id=$1 AND cts.site_id=ANY($4::uuid[])
           GROUP BY cts.site_id
         ), staffing_summary AS (
           SELECT oa.site_id,count(*)::int AS assigned_employee_count
           FROM employee_object_assignments oa
           WHERE oa.tenant_id=$1 AND oa.site_id=ANY($5::uuid[]) AND oa.starts_on<=CURRENT_DATE AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
           GROUP BY oa.site_id
         ), hazard_summary AS (
           SELECT h.site_id,count(*) FILTER (WHERE h.status='open')::int AS open_hazard_count,
               count(*) FILTER (WHERE h.status='open' AND h.risk_score>=15)::int AS critical_hazard_count,
             (SELECT count(*)::int FROM object_hazard_measures m
              WHERE m.tenant_id=h.tenant_id AND m.site_id=h.site_id AND m.status IN ('open','in_progress') AND m.due_on<CURRENT_DATE) AS overdue_measure_count
           FROM object_hazards h
           WHERE h.tenant_id=$1 AND h.site_id=ANY($6::uuid[])
           GROUP BY h.tenant_id,h.site_id
         ), task_summary AS (
           SELECT cs.site_id,
             count(*) FILTER (WHERE ct.status='open')::int AS open_task_count,
             count(*) FILTER (WHERE ct.status='open' AND ct.due_at IS NOT NULL AND ct.due_at<now())::int AS overdue_task_count
           FROM customer_tasks ct
           JOIN customer_sites cs ON cs.tenant_id=ct.tenant_id AND cs.customer_id=ct.customer_id AND cs.relationship_status='active'
           WHERE ct.tenant_id=$1 AND cs.site_id=ANY($9::uuid[])
           GROUP BY cs.site_id
         ), shift_summary AS (
           SELECT sh.site_id,
             count(*) FILTER (WHERE p.status='published' AND sh.ends_at>=now())::int AS open_shift_count,
             count(*) FILTER (WHERE p.status='published' AND sh.ends_at>=now()
               AND NOT EXISTS (SELECT 1 FROM schedule_assignments sa WHERE sa.tenant_id=sh.tenant_id AND sa.shift_id=sh.id AND sa.status='assigned'))::int AS undercovered_shift_count
           FROM schedule_shifts sh
           JOIN schedule_periods p ON p.tenant_id=sh.tenant_id AND p.id=sh.period_id
           WHERE sh.tenant_id=$1 AND sh.site_id=ANY($10::uuid[])
           GROUP BY sh.site_id
         ), latest_document_versions AS (
           SELECT DISTINCT ON (v.document_id) v.document_id,v.lifecycle_state
           FROM dms_versions v JOIN dms_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
           WHERE v.tenant_id=$1 AND d.site_id=ANY($7::uuid[]) AND d.document_status='active'
           ORDER BY v.document_id,v.version_no DESC
         ), document_summary AS (
           SELECT d.site_id,count(*) FILTER (WHERE latest.lifecycle_state='available')::int AS available_document_count
           FROM dms_documents d LEFT JOIN latest_document_versions latest ON latest.document_id=d.id
           WHERE d.tenant_id=$1 AND d.site_id=ANY($7::uuid[]) AND d.document_status='active'
           GROUP BY d.site_id
         ), activity_summary AS (
           SELECT e.site_id,max(e.created_at) AS last_activity
           FROM watchbook_entries e
           WHERE e.tenant_id=$1 AND e.site_id=ANY($8::uuid[])
           GROUP BY e.site_id
         )
         SELECT s.id,s.name,s.site_number,s.address,s.alias,s.site_type,s.status,s.security_classification,
           CASE WHEN s.id=ANY($5::uuid[]) THEN s.object_manager_employee_id ELSE NULL END AS object_manager_employee_id,
           CASE WHEN s.id=ANY($5::uuid[]) THEN om.name ELSE NULL END AS object_manager_name,
           CASE WHEN s.id=ANY($5::uuid[]) THEN s.operations_manager_employee_id ELSE NULL END AS operations_manager_employee_id,
           CASE WHEN s.id=ANY($5::uuid[]) THEN op.name ELSE NULL END AS operations_manager_name,
           CASE WHEN s.id=ANY($3::uuid[]) THEN customers.customer_names ELSE NULL END AS customer_names,
           CASE WHEN s.id=ANY($5::uuid[]) THEN COALESCE(staff.assigned_employee_count,0) ELSE NULL END AS assigned_employee_count,
           CASE WHEN s.id=ANY($4::uuid[]) THEN COALESCE(contracts.active_contract_count,0) ELSE NULL END AS active_contract_count,
           CASE WHEN s.id=ANY($4::uuid[]) THEN COALESCE(contracts.expiring_contract_count,0) ELSE NULL END AS expiring_contract_count,
           CASE WHEN s.id=ANY($4::uuid[]) THEN contracts.contract_statuses ELSE NULL END AS contract_statuses,
           COALESCE(hazards.open_hazard_count,0) AS open_hazard_count,
           COALESCE(hazards.critical_hazard_count,0) AS critical_hazard_count,
           COALESCE(hazards.overdue_measure_count,0) AS overdue_measure_count,
           CASE WHEN s.id=ANY($9::uuid[]) THEN COALESCE(tasks.open_task_count,0) ELSE NULL END AS open_task_count,
           CASE WHEN s.id=ANY($9::uuid[]) THEN COALESCE(tasks.overdue_task_count,0) ELSE NULL END AS overdue_task_count,
           CASE WHEN s.id=ANY($10::uuid[]) THEN COALESCE(shifts.open_shift_count,0) ELSE NULL END AS open_shift_count,
           CASE WHEN s.id=ANY($10::uuid[]) THEN COALESCE(shifts.undercovered_shift_count,0) ELSE NULL END AS undercovered_shift_count,
           s.required_staff_count,
           CASE WHEN s.required_staff_count>0 AND s.id=ANY($5::uuid[])
             AND COALESCE(staff.assigned_employee_count,0)<s.required_staff_count THEN true ELSE false END AS understaffed,
           CASE WHEN s.id=ANY($7::uuid[]) THEN COALESCE(documents.available_document_count,0) ELSE NULL END AS available_document_count,
           GREATEST(s.updated_at,activity.last_activity) AS last_activity
         FROM sites s
         LEFT JOIN employees om ON om.tenant_id=s.tenant_id AND om.id=s.object_manager_employee_id
         LEFT JOIN employees op ON op.tenant_id=s.tenant_id AND op.id=s.operations_manager_employee_id
         LEFT JOIN customer_summary customers ON customers.site_id=s.id
         LEFT JOIN contract_summary contracts ON contracts.site_id=s.id
         LEFT JOIN staffing_summary staff ON staff.site_id=s.id
         LEFT JOIN hazard_summary hazards ON hazards.site_id=s.id
         LEFT JOIN task_summary tasks ON tasks.site_id=s.id
         LEFT JOIN shift_summary shifts ON shifts.site_id=s.id
         LEFT JOIN document_summary documents ON documents.site_id=s.id
         LEFT JOIN activity_summary activity ON activity.site_id=s.id
         WHERE s.tenant_id=$1 AND s.id=ANY($2::uuid[])
         ORDER BY s.name,s.id`,
        [user.tenantId,visibleSiteIds,customerSiteIds,contractSiteIds,employeeSiteIds,visibleSiteIds,documentSiteIds,watchbookSiteIds,taskSiteIds,scheduleSiteIds],
      )).rows;
      const sum=(field:'active_contract_count'|'expiring_contract_count'|'assigned_employee_count'|'open_hazard_count'|'critical_hazard_count'|'overdue_measure_count'|'open_task_count'|'overdue_task_count'|'open_shift_count'|'undercovered_shift_count',authorized:boolean)=>
        authorized?sites.reduce((total,site)=>total+(site[field]??0),0):null;
      const metrics={
        total_sites:visibleSites.length,
        active_sites:sites.filter(site=>site.status==='active').length,
        preparation_sites:sites.filter(site=>site.status==='planning'||site.status==='setup').length,
        restricted_sites:sites.filter(site=>site.status==='restricted'||site.status==='temporarily_closed').length,
        critical_sites:sites.filter(site=>site.security_classification==='critical').length,
        sites_with_critical_hazards:sites.filter(site=>site.critical_hazard_count>0).length,
        sites_with_open_tasks:sites.filter(site=>site.open_task_count!==null&&site.open_task_count>0).length,
        sites_with_understaffing:sites.filter(site=>site.understaffed).length,
        open_hazards:sum('open_hazard_count',true),
        overdue_measures:sum('overdue_measure_count',true),
        open_tasks:sum('open_task_count',taskSiteIds.length>0),
        overdue_tasks:sum('overdue_task_count',taskSiteIds.length>0),
        open_shifts:sum('open_shift_count',scheduleSiteIds.length>0),
        undercovered_shifts:sum('undercovered_shift_count',scheduleSiteIds.length>0),
        expiring_contracts:sum('expiring_contract_count',hasContractRead),
        sites_without_available_documents:hasDocumentRead?sites.filter(site=>site.available_document_count===0).length:null,
      };
      res.json({sites,metrics});
    }catch(error){next(error);}
  },
);

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

async function employeeAssignedToSite(tenantId:string,siteId:string,employeeId:string){
  return Boolean((await query(
    `SELECT 1 FROM employee_object_assignments oa
     WHERE oa.tenant_id=$1 AND oa.site_id=$2 AND oa.employee_id=$3
       AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)`,
    [tenantId,siteId,employeeId],
  )).rows[0]);
}

objectManagementRouter.get(
  '/sites/:id/object-context',
  requireAuth,
  requirePermission('sites:read',{allowedScopes:['tenant','site','own','system']}),
  requireSiteScope('sites:read'),
  async(req,res,next)=>{
    try{
      const id=uuid.parse(String(req.params.id));
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
      const canReadStaffing=canReadSiteData('employees:read');
      const canApproveInstructions=canReadSiteData('site_instructions:approve');
      const siteRow=(await query(
        `SELECT s.*,CASE WHEN $3::boolean THEN om.name ELSE NULL END AS object_manager_name,
          CASE WHEN $3::boolean THEN op.name ELSE NULL END AS operations_manager_name
         FROM sites s
         LEFT JOIN employees om ON om.tenant_id=s.tenant_id AND om.id=s.object_manager_employee_id
         LEFT JOIN employees op ON op.tenant_id=s.tenant_id AND op.id=s.operations_manager_employee_id
         WHERE s.tenant_id=$1 AND s.id=$2`,
        [user.tenantId,id,canReadStaffing],
      )).rows[0];
      if(!siteRow)return res.status(404).json({error:'Not found'});
      const site=canReadStaffing?siteRow:{...siteRow,object_manager_employee_id:null,operations_manager_employee_id:null};
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
        `SELECT l.id,l.tenant_id,l.site_id,l.parent_id,l.code,l.name,l.location_type,l.description,l.security_level,l.hazard_notes,l.access_rules,
          CASE WHEN $3::boolean THEN l.responsible_employee_id ELSE NULL END AS responsible_employee_id,
          l.sort_order,l.active,l.created_at,l.updated_at,
          CASE WHEN $3::boolean THEN e.name ELSE NULL END AS responsible_employee_name
         FROM object_locations l
         LEFT JOIN employees e ON e.tenant_id=l.tenant_id AND e.id=l.responsible_employee_id
         WHERE l.tenant_id=$1 AND l.site_id=$2 ORDER BY l.parent_id NULLS FIRST,l.sort_order,l.name`,
        [req.user!.tenantId,id,canReadStaffing],
      )).rows;
      const hazards=(await query(
        `SELECT h.id,h.tenant_id,h.site_id,h.location_id,h.title,h.category,h.description,h.likelihood,h.impact,h.risk_score,h.protective_measures,
          CASE WHEN $3::boolean THEN h.responsible_employee_id ELSE NULL END AS responsible_employee_id,
          h.due_on,h.review_on,h.status,h.created_by,h.created_at,h.updated_at,l.name AS location_name,
          CASE WHEN $3::boolean THEN e.name ELSE NULL END AS responsible_employee_name,
          COALESCE((
            SELECT json_agg(json_build_object(
              'id',m.id,'hazard_id',m.hazard_id,'title',m.title,'description',m.description,
              'responsible_employee_id',CASE WHEN $3::boolean THEN m.responsible_employee_id ELSE NULL END,
              'responsible_employee_name',CASE WHEN $3::boolean THEN me.name ELSE NULL END,
              'due_on',m.due_on,'status',m.status,'completed_at',m.completed_at
            ) ORDER BY m.due_on NULLS LAST,m.created_at,m.id)
            FROM object_hazard_measures m
            LEFT JOIN employees me ON me.tenant_id=m.tenant_id AND me.id=m.responsible_employee_id
            WHERE m.tenant_id=h.tenant_id AND m.site_id=h.site_id AND m.hazard_id=h.id
          ),'[]'::json) AS measures
         FROM object_hazards h
         LEFT JOIN object_locations l ON l.tenant_id=h.tenant_id AND l.id=h.location_id
         LEFT JOIN employees e ON e.tenant_id=h.tenant_id AND e.id=h.responsible_employee_id
         WHERE h.tenant_id=$1 AND h.site_id=$2 ORDER BY h.status,h.risk_score DESC,h.title`,
        [req.user!.tenantId,id,canReadStaffing],
      )).rows;
      const instructions=(await query(
        `SELECT i.*,l.name AS location_name,u.email AS created_by_email,
          CASE WHEN $4::boolean AND i.created_by<>$5 THEN true ELSE false END AS can_approve,
          (SELECT count(*)::int FROM instruction_acknowledgements a WHERE a.tenant_id=i.tenant_id AND a.instruction_id=i.id AND a.acknowledged_version=i.version) AS acknowledgement_count,
          CASE WHEN $3::boolean THEN COALESCE((
            SELECT json_agg(json_build_object('employee_id',a.employee_id,'employee_name',ae.name,'acknowledged_at',a.acknowledged_at) ORDER BY ae.name)
            FROM instruction_acknowledgements a
            JOIN employees ae ON ae.tenant_id=a.tenant_id AND ae.id=a.employee_id
            WHERE a.tenant_id=i.tenant_id AND a.instruction_id=i.id AND a.acknowledged_version=i.version
          ),'[]'::json) ELSE '[]'::json END AS acknowledgements
         FROM site_instructions i
         LEFT JOIN object_locations l ON l.tenant_id=i.tenant_id AND l.id=i.location_id
         JOIN users u ON u.tenant_id=i.tenant_id AND u.id=i.created_by
         WHERE i.tenant_id=$1 AND i.site_id=$2 AND i.status<>'archived'
         ORDER BY i.title,i.version DESC`,
        [req.user!.tenantId,id,canReadStaffing,canApproveInstructions,user.id],
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
      const staffing=canReadStaffing?(await query(
        `SELECT oa.id,oa.employee_id,e.name AS employee_name,e.employee_number,e.employment_status,oa.assignment_type,oa.role,oa.starts_on,oa.ends_on,
          oa.primary_assignment,oa.notes
         FROM employee_object_assignments oa
         JOIN employees e ON e.tenant_id=oa.tenant_id AND e.id=oa.employee_id
         WHERE oa.tenant_id=$1 AND oa.site_id=$2
           AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
         ORDER BY oa.starts_on<=CURRENT_DATE DESC,oa.primary_assignment DESC,oa.starts_on, e.name`,
        [user.tenantId,id],
      )).rows:null;
      const assignmentHistory=canReadStaffing?(await query(
        `SELECT oa.id,oa.employee_id,e.name AS employee_name,e.employee_number,oa.assignment_type,oa.role,oa.starts_on,oa.ends_on,
          oa.primary_assignment,oa.notes
         FROM employee_object_assignments oa
         JOIN employees e ON e.tenant_id=oa.tenant_id AND e.id=oa.employee_id
         WHERE oa.tenant_id=$1 AND oa.site_id=$2
         ORDER BY oa.ends_on DESC NULLS FIRST,oa.starts_on DESC,e.name LIMIT 100`,
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
          d.document_number,d.document_type,d.responsible_employee_id,d.valid_from,d.valid_until,d.review_on,d.approval_status,d.location_id,
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
      const devices=canReadSiteData('devices:read')?(await query(
        `SELECT id,name,status,site_id,last_seen_at,metadata,asset_number,category,manufacturer,model,serial_number,
          location_id,responsible_employee_id,operational_status,installed_on,commissioned_on,last_inspection_on,
          next_inspection_on,maintenance_interval_days,next_maintenance_on,last_maintenance_on,created_at,updated_at
         FROM devices
         WHERE tenant_id=$1 AND site_id=$2 AND device_kind='operational'
         ORDER BY name,last_seen_at DESC NULLS LAST`,
        [user.tenantId,id],
      )).rows:null;
      res.json({site,customers,contracts,locations,hazards,instructions,journal,staffing,assignmentHistory,shifts,patrols,keys,keyBundles,documents,alarms,incidents,customerTasks,maintenance,qualifications,handovers,devices});
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid site id'});next(error);}
  },
);

objectManagementRouter.post('/sites/:id/locations',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const body=locationSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
    if(!site)return res.status(404).json({error:'Site not found'});
    if(body.parent_id){
      const parent=(await query('SELECT id,location_type FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.parent_id])).rows[0];
      if(!parent)return res.status(400).json({error:'Parent location not found in site'});
      if(parent.location_type!==parentTypeFor[body.location_type])return res.status(400).json({error:`Parent location must be a ${parentTypeFor[body.location_type]??'root location'}`});
    }else if(parentTypeFor[body.location_type]){
      return res.status(400).json({error:`${body.location_type} locations require a parent location`});
    }
    if(body.responsible_employee_id){
      if(!await employeeAssignedToSite(tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
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
    const current=(await query('SELECT id,location_type,parent_id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,locationId])).rows[0];
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
    if(body.parent_id!==undefined||body.location_type!==undefined){
      const locationType=(body.location_type??current.location_type) as LocationType;
      const parentId=body.parent_id===undefined?current.parent_id:body.parent_id;
      if(locationType==='building'&&parentId)return res.status(400).json({error:'Building locations cannot have a parent location'});
      if(locationType!=='building'&&!parentId)return res.status(400).json({error:`${locationType} locations require a parent location`});
      if(parentId){
        const parent=(await query('SELECT location_type FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,parentId])).rows[0];
        if(!parent)return res.status(400).json({error:'Parent location not found in site'});
        if(parent.location_type!==parentTypeFor[locationType])return res.status(400).json({error:`Parent location must be a ${parentTypeFor[locationType]??'root location'}`});
      }
      if(body.location_type&&body.location_type!==current.location_type){
        const children=(await query('SELECT location_type FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND parent_id=$3',[tenantId,siteId,locationId])).rows;
        const expectedChildType=locationType==='building'?'area':locationType==='area'?'zone':null;
        if(children.some(child=>child.location_type!==expectedChildType))return res.status(400).json({error:'Location type is incompatible with its existing child locations'});
      }
    }
    if(body.responsible_employee_id){
      if(!await employeeAssignedToSite(tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
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
      if(!await employeeAssignedToSite(tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    }
    const row=(await query(`INSERT INTO object_hazards(tenant_id,site_id,location_id,title,category,description,likelihood,impact,protective_measures,responsible_employee_id,due_on,review_on,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [tenantId,siteId,body.location_id??null,body.title,body.category,body.description,body.likelihood,body.impact,body.protective_measures??null,body.responsible_employee_id??null,body.due_on??null,body.review_on??null,body.status,req.user!.id])).rows[0];
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
      if(!await employeeAssignedToSite(tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    }
    const dueOn=body.due_on===undefined?(current.due_on?String(current.due_on).slice(0,10):null):body.due_on;
    const reviewOn=body.review_on===undefined?(current.review_on?String(current.review_on).slice(0,10):null):body.review_on;
    if(dueOn&&reviewOn&&reviewOn<dueOn)return res.status(400).json({error:'review_on must be on or after due_on'});
    const columns:Record<keyof typeof body,string>={location_id:'location_id',title:'title',category:'category',description:'description',likelihood:'likelihood',impact:'impact',protective_measures:'protective_measures',responsible_employee_id:'responsible_employee_id',due_on:'due_on',review_on:'review_on',status:'status'};
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

objectManagementRouter.post('/sites/:id/hazards/:hazardId/measures',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const hazardId=uuid.parse(String(req.params.hazardId)); const body=hazardMeasureSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const hazard=(await query('SELECT id FROM object_hazards WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,hazardId])).rows[0];
    if(!hazard)return res.status(404).json({error:'Hazard not found'});
    if(body.responsible_employee_id&&!await employeeAssignedToSite(tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    const row=(await query(`INSERT INTO object_hazard_measures(tenant_id,site_id,hazard_id,title,description,responsible_employee_id,due_on,status,completed_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8='completed' THEN now() ELSE NULL END,$9) RETURNING *`,
      [tenantId,siteId,hazardId,body.title,body.description??null,body.responsible_employee_id??null,body.due_on??null,body.status,req.user!.id])).rows[0];
    await recordAudit(tenantId,req.user!.id,'site.hazard_measure.created','object_hazard_measures',row.id,{site_id:siteId,hazard_id:hazardId,status:body.status,due_on:body.due_on??null});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid hazard measure'});next(error);}
});

objectManagementRouter.patch('/sites/:id/hazards/:hazardId/measures/:measureId',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const hazardId=uuid.parse(String(req.params.hazardId)); const measureId=uuid.parse(String(req.params.measureId)); const body=hazardMeasurePatchSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const current=(await query('SELECT id,status FROM object_hazard_measures WHERE tenant_id=$1 AND site_id=$2 AND hazard_id=$3 AND id=$4',[tenantId,siteId,hazardId,measureId])).rows[0];
    if(!current)return res.status(404).json({error:'Hazard measure not found'});
    if(body.responsible_employee_id&&!await employeeAssignedToSite(tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    const columns:Record<keyof typeof body,string>={title:'title',description:'description',responsible_employee_id:'responsible_employee_id',due_on:'due_on',status:'status'};
    const patch=patchAssignments(body,columns,6);
    const status=body.status??current.status;
    const row=(await query(
      `UPDATE object_hazard_measures SET ${patch.assignments},completed_at=CASE WHEN $4='completed' THEN COALESCE(completed_at,now()) ELSE NULL END,updated_at=now()
       WHERE tenant_id=$1 AND site_id=$2 AND hazard_id=$3 AND id=$5 RETURNING *`,
      [tenantId,siteId,hazardId,status,measureId,...patch.values],
    )).rows[0];
    if(!row)return res.status(404).json({error:'Hazard measure not found'});
    await recordAudit(tenantId,req.user!.id,'site.hazard_measure.updated','object_hazard_measures',measureId,{site_id:siteId,hazard_id:hazardId,changed_fields:Object.keys(body),status});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid hazard measure'});next(error);}
});

objectManagementRouter.post('/sites/:id/instructions',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const body=instructionSchema.parse(req.body); const tenantId=req.user!.tenantId;
    if(body.status==='approved'||body.status==='archived')return res.status(400).json({error:'Instructions must be submitted for approval and cannot be created as approved or archived'});
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
    if(!site)return res.status(404).json({error:'Site not found'});
    if(body.location_id){
      const location=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.location_id])).rows[0];
      if(!location)return res.status(400).json({error:'Location not found in site'});
    }
    if(body.supersedes_id){
      const previous=(await query('SELECT id,version,title FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.supersedes_id])).rows[0];
      if(!previous)return res.status(400).json({error:'Superseded instruction not found in site'});
      if(body.title!==previous.title||body.version!==Number(previous.version)+1)return res.status(400).json({error:'A new instruction version must retain its title and increment the version by one'});
      const latest=(await query('SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND title=$3 ORDER BY version DESC LIMIT 1',[tenantId,siteId,previous.title])).rows[0];
      if(latest?.id!==previous.id)return res.status(409).json({error:'Only the latest instruction version can be superseded'});
    }else{
      if(body.version!==1)return res.status(400).json({error:'A new instruction must start at version 1'});
      const existing=(await query('SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND title=$3 ORDER BY version DESC LIMIT 1',[tenantId,siteId,body.title])).rows[0];
      if(existing)return res.status(409).json({error:'An existing instruction with this title must be superseded'});
    }
    const row=(await query(`INSERT INTO site_instructions(tenant_id,site_id,location_id,title,content,version,status,requires_acknowledgement,valid_from,valid_until,created_by,approved_by,approved_at,supersedes_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,$12) RETURNING *`,
      [tenantId,siteId,body.location_id??null,body.title,body.content,body.version,body.status,body.requires_acknowledgement,body.valid_from??null,body.valid_until??null,req.user!.id,body.supersedes_id??null])).rows[0];
    await recordAudit(tenantId,req.user!.id,'site.instruction.created','site_instructions',row.id,{site_id:siteId,version:body.version,status:body.status});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid instruction'});next(error);}
});

objectManagementRouter.post('/sites/:id/instructions/:instructionId/approve',requireAuth,requireCsrf,requirePermission('site_instructions:approve',{allowedScopes:['tenant','site','system']}),requireSiteScope('site_instructions:approve'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const instructionId=uuid.parse(String(req.params.instructionId)); const tenantId=req.user!.tenantId;
    const current=(await query('SELECT id,status,created_by,version,title FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,instructionId])).rows[0];
    if(!current)return res.status(404).json({error:'Instruction not found'});
    if(current.created_by===req.user!.id)return res.status(403).json({error:'Instruction authors cannot approve their own instruction'});
    if(current.status!=='pending_approval')return res.status(409).json({error:'Only pending instructions can be approved'});
    const latest=(await query('SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND title=$3 ORDER BY version DESC LIMIT 1',[tenantId,siteId,current.title])).rows[0];
    if(latest?.id!==current.id)return res.status(409).json({error:'Only the latest instruction version can be approved'});
    const row=(await query(`UPDATE site_instructions SET status='approved',approved_by=$4,approved_at=now(),updated_at=now()
      WHERE tenant_id=$1 AND site_id=$2 AND id=$3 AND status='pending_approval' AND created_by<>$4
        AND NOT EXISTS(SELECT 1 FROM site_instructions newer WHERE newer.tenant_id=site_instructions.tenant_id AND newer.site_id=site_instructions.site_id AND newer.title=site_instructions.title AND newer.version>site_instructions.version)
      RETURNING *`,
      [tenantId,siteId,instructionId,req.user!.id])).rows[0];
    if(!row)return res.status(409).json({error:'Instruction status changed before approval'});
    await recordAudit(tenantId,req.user!.id,'site.instruction.approved','site_instructions',instructionId,{site_id:siteId,version:current.version});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid instruction id'});next(error);}
});

objectManagementRouter.post('/sites/:id/instructions/:instructionId/return-for-revision',requireAuth,requireCsrf,requirePermission('site_instructions:approve',{allowedScopes:['tenant','site','system']}),requireSiteScope('site_instructions:approve'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const instructionId=uuid.parse(String(req.params.instructionId)); const body=z.object({reason:nonempty.max(4000)}).strict().parse(req.body); const tenantId=req.user!.tenantId;
    const current=(await query('SELECT id,status,created_by,version,title FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,instructionId])).rows[0];
    if(!current)return res.status(404).json({error:'Instruction not found'});
    if(current.created_by===req.user!.id)return res.status(403).json({error:'Instruction authors cannot return their own instruction'});
    if(current.status!=='pending_approval')return res.status(409).json({error:'Only pending instructions can be returned for revision'});
    const latest=(await query('SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND title=$3 ORDER BY version DESC LIMIT 1',[tenantId,siteId,current.title])).rows[0];
    if(latest?.id!==current.id)return res.status(409).json({error:'Only the latest instruction version can be returned for revision'});
    const row=(await query(`UPDATE site_instructions SET status='draft',approved_by=NULL,approved_at=NULL,updated_at=now()
      WHERE tenant_id=$1 AND site_id=$2 AND id=$3 AND status='pending_approval' AND created_by<>$4
        AND NOT EXISTS(SELECT 1 FROM site_instructions newer WHERE newer.tenant_id=site_instructions.tenant_id AND newer.site_id=site_instructions.site_id AND newer.title=site_instructions.title AND newer.version>site_instructions.version)
      RETURNING *`,
      [tenantId,siteId,instructionId,req.user!.id])).rows[0];
    if(!row)return res.status(409).json({error:'Instruction status changed before it could be returned'});
    await recordAudit(tenantId,req.user!.id,'site.instruction.returned_for_revision','site_instructions',instructionId,{site_id:siteId,version:current.version,reason:body.reason});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid return for revision'});next(error);}
});

objectManagementRouter.post('/sites/:id/instructions/:instructionId/acknowledgements',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),requirePermission('employees:read',{allowedScopes:['tenant','site','system']}),requireSiteScope('employees:read'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const instructionId=uuid.parse(String(req.params.instructionId));
    const body=z.object({employee_id:uuid}).strict().parse(req.body); const tenantId=req.user!.tenantId;
    const instruction=(await query('SELECT id,version,status,title,requires_acknowledgement FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,instructionId])).rows[0];
    const employee=(await query(`SELECT e.id FROM employees e
      WHERE e.tenant_id=$1 AND e.id=$2
        AND EXISTS(SELECT 1 FROM employee_object_assignments oa
          WHERE oa.tenant_id=e.tenant_id AND oa.site_id=$3 AND oa.employee_id=e.id
            AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE))`,[tenantId,body.employee_id,siteId])).rows[0];
    if(!instruction||!employee)return res.status(404).json({error:'Instruction or employee not found'});
    if(instruction.status!=='approved')return res.status(409).json({error:'Only approved instructions can be acknowledged'});
    if(!instruction.requires_acknowledgement)return res.status(409).json({error:'This instruction does not require acknowledgement'});
    const latestApproved=(await query("SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND title=$3 AND status='approved' ORDER BY version DESC LIMIT 1",[tenantId,siteId,instruction.title])).rows[0];
    if(latestApproved?.id!==instruction.id)return res.status(409).json({error:'Only the current approved version can be acknowledged'});
    const row=(await query(`INSERT INTO instruction_acknowledgements(tenant_id,instruction_id,employee_id,acknowledged_version)
      SELECT $1,$2,$3,$4
      WHERE EXISTS(
        SELECT 1 FROM site_instructions i
        WHERE i.tenant_id=$1 AND i.site_id=$5 AND i.id=$2 AND i.version=$4 AND i.status='approved' AND i.requires_acknowledgement
          AND NOT EXISTS(SELECT 1 FROM site_instructions newer
            WHERE newer.tenant_id=i.tenant_id AND newer.site_id=i.site_id AND newer.title=i.title AND newer.status='approved' AND newer.version>i.version)
      )
      ON CONFLICT DO NOTHING RETURNING *`,[tenantId,instructionId,body.employee_id,instruction.version,siteId])).rows[0];
    if(!row){
      const existing=(await query('SELECT 1 FROM instruction_acknowledgements WHERE tenant_id=$1 AND instruction_id=$2 AND employee_id=$3 AND acknowledged_version=$4',[tenantId,instructionId,body.employee_id,instruction.version])).rows[0];
      if(existing)return res.status(200).json({acknowledged:true,version:instruction.version});
      return res.status(409).json({error:'Instruction version is no longer current'});
    }
    await recordAudit(tenantId,req.user!.id,'site.instruction.acknowledged','instruction_acknowledgements',instructionId,{site_id:siteId,employee_id:body.employee_id,version:instruction.version});
    res.status(201).json(row);
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
