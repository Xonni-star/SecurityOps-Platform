import {Router,type RequestHandler} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {classifyDocument,classifyRequirement,documentStatusCounts,documentWarningCounts} from '../services/dms-document-status.js';
import {withMaintenanceStatus} from '../services/maintenance-domain.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

type ClassifiedObjectDocumentRow={
  id:string;title:string;document_type:string|null;document_status:string|null;approval_status:string|null;
  valid_from:string|null;valid_until:string|null;review_on:string|null;reviewed_at:string|Date|null;
  versions:Array<{lifecycle_state:string|null}>|null;
};

type QualificationRow={
  id:string;employee_id:string;employee_name:string;code:string;qualification_name:string|null;
  valid_from:string|null;valid_until:string|null;status:string;computed_status:string;
  days_until_expiry?:number|null;document_id?:string|null;issuing_authority?:string|null;
  notes?:string|null;revoked_at?:string|Date|null;updated_at?:string|Date|null;
  catalog_active?:boolean|null;evidence_title?:string|null;evidence_document_status?:string|null;
  evidence_approval_status?:string|null;evidence_valid_from?:string|Date|null;
  evidence_valid_until?:string|Date|null;evidence_review_on?:string|Date|null;
  evidence_reviewed_at?:string|Date|null;evidence_lifecycle_state?:string|null;
};
type QualificationIssue={code:string;label:string;detail:string;severity:'critical'|'high'|'medium'};
type EnrichedQualification=QualificationRow&{
  issue:QualificationIssue;evidence_status:string;evidence_label:string;
  evidence_document_id:string|null;evidence_document_title:string|null;
  last_checked_at:string|null;employee_url:string;
};
type PriorityAction={
  id:string;site_id?:string|null;site_name?:string|null;entity_id?:string|null;employee_id?:string|null;
  severity:'critical'|'high'|'medium';priority:'A'|'B'|'C';category:string;title:string;detail:string;
  due_on:string|null;tab:string;permission:string;target:string;
};
function priorityForSeverity(severity:PriorityAction['severity']):PriorityAction['priority']{
  return severity==='critical'?'A':severity==='high'?'B':'C';
}

const evidenceLabels:Record<string,string>={
  gueltig:'Nachweis gültig',lauf_bald_ab:'Nachweis läuft bald ab',
  bald_pruefpflichtig:'Nachweis bald prüfpflichtig',abgelaufen:'Nachweis abgelaufen',
  fehlend:'Nachweis fehlt',nicht_freigegeben:'Nachweis nicht freigegeben',
  pruefung_ausstehend:'Nachweisprüfung ausstehend',noch_nicht_gueltig:'Nachweis noch nicht gültig',
  missing:'Kein Nachweis verknüpft',not_found:'Verknüpfter Nachweis nicht gefunden',
};
const blockingIssueCodes=new Set(['revoked','invalid','expired','expired_evidence','unapproved_evidence','missing_evidence']);
const invalidIssueCodes=new Set(['revoked','invalid','expired','expired_evidence']);
const issueSeverity:Record<string,QualificationIssue['severity']>={
  revoked:'critical',invalid:'critical',expired:'critical',expired_evidence:'critical',
  unapproved_evidence:'high',missing_evidence:'high',expiring:'medium',none:'medium',
};

function asDateValue(value:unknown):string|Date|null{
  if(value===null||value===undefined)return null;
  return value instanceof Date?value:String(value);
}
function utcDayValue(value:unknown,now=new Date()):number{
  const date=value instanceof Date?value:new Date(`${String(value).slice(0,10)}T00:00:00Z`);
  const valid=Number.isNaN(date.getTime())?now:date;
  return Date.UTC(valid.getUTCFullYear(),valid.getUTCMonth(),valid.getUTCDate());
}
function daysUntilValue(value:unknown,now=new Date()):number|null{
  if(value===null||value===undefined||value==='')return null;
  const today=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
  return Math.round((utcDayValue(value,now)-today)/86_400_000);
}
function timestampValue(value:unknown):string|null{
  if(value===null||value===undefined)return null;
  if(value instanceof Date)return value.toISOString();
  const date=new Date(String(value));
  return Number.isNaN(date.getTime())?String(value):date.toISOString();
}
function classifyEvidence(row:QualificationRow,now=new Date()):{status:string;label:string}{
  if(!row.document_id)return {status:'missing',label:evidenceLabels.missing};
  if(!row.evidence_document_status&&!row.evidence_lifecycle_state)return {status:'not_found',label:evidenceLabels.not_found};
  const classification=classifyDocument({
    document_status:row.evidence_document_status,
    approval_status:row.evidence_approval_status,
    valid_from:asDateValue(row.evidence_valid_from),
    valid_until:asDateValue(row.evidence_valid_until),
    review_on:asDateValue(row.evidence_review_on),
    reviewed_at:asDateValue(row.evidence_reviewed_at),
    versions:row.evidence_lifecycle_state?[{lifecycle_state:row.evidence_lifecycle_state}]:[],
  },now);
  return {status:classification.computed_status,label:evidenceLabels[classification.computed_status]??classification.status_label};
}
function qualificationIssue(row:QualificationRow,days:number|null,evidence:{status:string;label:string}):QualificationIssue{
  const status=String(row.status??'');
  if(status==='revoked'||row.revoked_at)return {
    code:'revoked',label:'Widerrufen',detail:row.revoked_at?`Widerrufen am ${timestampValue(row.revoked_at)?.slice(0,10)}`:'Qualifikationsnachweis wurde widerrufen',severity:'critical',
  };
  if(status==='invalid'||row.catalog_active===false)return {
    code:'invalid',label:'Ungültig',detail:'Qualifikation ist ungültig oder im Katalog nicht mehr aktiv',severity:'critical',
  };
  if(status==='expired'||days!==null&&days<0)return {
    code:'expired',label:'Abgelaufen',detail:days!==null?`Seit ${Math.abs(days)} Tagen abgelaufen`:'Qualifikation ist abgelaufen',severity:'critical',
  };
  if(row.computed_status==='expiring'||days!==null&&days<=90)return {
    code:'expiring',label:'Läuft bald ab',detail:days!==null?`Noch ${days} Tage gültig`:'Qualifikation läuft in Kürze ab',severity:'medium',
  };
  if(evidence.status==='missing'||evidence.status==='not_found')return {
    code:'missing_evidence',label:'Nachweis fehlt',detail:evidence.label,severity:'high',
  };
  if(evidence.status==='abgelaufen'||evidence.status==='noch_nicht_gueltig')return {
    code:'expired_evidence',label:'Nachweis nicht gültig',detail:evidence.label,severity:'critical',
  };
  if(['nicht_freigegeben','pruefung_ausstehend'].includes(evidence.status))return {
    code:'unapproved_evidence',label:'Nachweis nicht freigegeben',detail:evidence.label,severity:'high',
  };
  return {code:'none',label:'Gültig',detail:'Keine offene Qualifikationswarnung',severity:'medium'};
}
function enrichQualifications(rows:QualificationRow[],now=new Date()):EnrichedQualification[]{
  return rows.map(row=>{
    const days=row.days_until_expiry??daysUntilValue(row.valid_until,now);
    const evidence=classifyEvidence(row,now);
    return {
      ...row,
      days_until_expiry:days,
      issue:qualificationIssue(row,days,evidence),
      evidence_status:evidence.status,
      evidence_label:evidence.label,
      evidence_document_id:row.document_id??null,
      evidence_document_title:row.evidence_title??null,
      last_checked_at:timestampValue(row.updated_at),
      employee_url:`/employees/${row.employee_id}/qualifikationen`,
    };
  });
}

function sortPriorityActions(actions:PriorityAction[],limit=40):PriorityAction[]{
  const rank:Record<PriorityAction['severity'],number>={critical:0,high:1,medium:2};
  return actions.sort((left,right)=>rank[left.severity]-rank[right.severity]
    ||String(left.due_on??'9999-12-31').localeCompare(String(right.due_on??'9999-12-31'))
    ||left.title.localeCompare(right.title)).slice(0,limit);
}

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
      const qualificationSiteIds=employeeSiteIds.filter(siteId=>canReadSiteData('qualifications:read',siteId));
      const documentSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('dms:read',siteId));
      const watchbookSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('watchbook:read',siteId));
      const scheduleSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('scheduling:read',siteId));
      const deviceSiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('devices:read',siteId));
      const keySiteIds=visibleSiteIds.filter(siteId=>canReadSiteData('keys:read',siteId));
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
        required_staff_count:number;understaffed:boolean;available_document_count:number|null;
        valid_document_count:number|null;unapproved_document_count:number|null;expired_document_count:number|null;
        expiring_7d_document_count:number|null;expiring_30d_document_count:number|null;review_due_document_count:number|null;
        missing_requirement_count:number|null;open_maintenance_count:number|null;overdue_maintenance_count:number|null;last_activity:string|null;
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
         ), maintenance_summary AS (
           SELECT m.site_id,
             count(*) FILTER (WHERE m.status IN ('planned','open','in_progress'))::int AS open_maintenance_count,
             count(*) FILTER (WHERE m.status IN ('planned','open','in_progress') AND m.due_on<CURRENT_DATE)::int AS overdue_maintenance_count
           FROM maintenance_orders m
           WHERE m.tenant_id=$1 AND m.site_id=ANY($11::uuid[])
           GROUP BY m.site_id
         ), latest_document_versions AS (
           SELECT DISTINCT ON (v.document_id) v.document_id,v.lifecycle_state
           FROM dms_versions v JOIN dms_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
           WHERE v.tenant_id=$1 AND d.site_id=ANY($7::uuid[]) AND d.document_status='active'
           ORDER BY v.document_id,v.version_no DESC
         ), document_summary AS (
           SELECT d.site_id,
             count(*) FILTER (WHERE latest.lifecycle_state='available')::int AS available_document_count,
             count(*) FILTER (WHERE latest.lifecycle_state='available' AND d.approval_status='approved'
               AND (d.valid_from IS NULL OR d.valid_from<=CURRENT_DATE)
               AND (d.valid_until IS NULL OR d.valid_until>=CURRENT_DATE))::int AS valid_document_count,
             count(*) FILTER (WHERE latest.lifecycle_state IS DISTINCT FROM 'available' OR d.approval_status<>'approved')::int AS unapproved_document_count,
             count(*) FILTER (WHERE latest.lifecycle_state='available' AND d.approval_status='approved' AND d.valid_until<CURRENT_DATE)::int AS expired_document_count,
             count(*) FILTER (WHERE latest.lifecycle_state='available' AND d.approval_status='approved'
               AND d.valid_until>=CURRENT_DATE AND d.valid_until<=CURRENT_DATE+7)::int AS expiring_7d_document_count,
             count(*) FILTER (WHERE latest.lifecycle_state='available' AND d.approval_status='approved'
               AND d.valid_until>CURRENT_DATE+7 AND d.valid_until<=CURRENT_DATE+30)::int AS expiring_30d_document_count,
             count(*) FILTER (WHERE d.review_on IS NOT NULL AND d.review_on<=CURRENT_DATE+30)::int AS review_due_document_count,
             (SELECT count(*)::int FROM dms_document_requirements r
               WHERE r.tenant_id=d.tenant_id AND r.site_id=d.site_id AND r.required
                 AND NOT EXISTS (
                   SELECT 1 FROM dms_documents doc JOIN latest_document_versions lv ON lv.document_id=doc.id
                   WHERE doc.tenant_id=r.tenant_id AND doc.site_id=r.site_id AND doc.document_type=r.document_type
                     AND doc.document_status='active' AND doc.approval_status='approved' AND lv.lifecycle_state='available'
                     AND (doc.valid_from IS NULL OR doc.valid_from<=CURRENT_DATE)
                     AND (doc.valid_until IS NULL OR doc.valid_until>=CURRENT_DATE)
                 ))::int AS missing_requirement_count
           FROM dms_documents d LEFT JOIN latest_document_versions latest ON latest.document_id=d.id
           WHERE d.tenant_id=$1 AND d.site_id=ANY($7::uuid[]) AND d.document_status='active'
           GROUP BY d.site_id,d.tenant_id
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
           CASE WHEN s.id=ANY($7::uuid[]) THEN COALESCE(documents.valid_document_count,0) ELSE NULL END AS valid_document_count,
           CASE WHEN s.id=ANY($7::uuid[]) THEN COALESCE(documents.unapproved_document_count,0) ELSE NULL END AS unapproved_document_count,
           CASE WHEN s.id=ANY($7::uuid[]) THEN COALESCE(documents.expired_document_count,0) ELSE NULL END AS expired_document_count,
           CASE WHEN s.id=ANY($7::uuid[]) THEN COALESCE(documents.expiring_7d_document_count,0) ELSE NULL END AS expiring_7d_document_count,
           CASE WHEN s.id=ANY($7::uuid[]) THEN COALESCE(documents.expiring_30d_document_count,0) ELSE NULL END AS expiring_30d_document_count,
           CASE WHEN s.id=ANY($7::uuid[]) THEN COALESCE(documents.review_due_document_count,0) ELSE NULL END AS review_due_document_count,
           CASE WHEN s.id=ANY($7::uuid[]) THEN COALESCE(documents.missing_requirement_count,0) ELSE NULL END AS missing_requirement_count,
           CASE WHEN s.id=ANY($11::uuid[]) THEN COALESCE(maintenance.open_maintenance_count,0) ELSE NULL END AS open_maintenance_count,
           CASE WHEN s.id=ANY($11::uuid[]) THEN COALESCE(maintenance.overdue_maintenance_count,0) ELSE NULL END AS overdue_maintenance_count,
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
         LEFT JOIN maintenance_summary maintenance ON maintenance.site_id=s.id
         LEFT JOIN activity_summary activity ON activity.site_id=s.id
         WHERE s.tenant_id=$1 AND s.id=ANY($2::uuid[])
         ORDER BY s.name,s.id`,
        [user.tenantId,visibleSiteIds,customerSiteIds,contractSiteIds,employeeSiteIds,visibleSiteIds,documentSiteIds,watchbookSiteIds,taskSiteIds,scheduleSiteIds,deviceSiteIds],
      )).rows;
      const sum=(field:'active_contract_count'|'expiring_contract_count'|'assigned_employee_count'|'open_hazard_count'|'critical_hazard_count'|'overdue_measure_count'|'open_task_count'|'overdue_task_count'|'open_shift_count'|'undercovered_shift_count'|'available_document_count'|'valid_document_count'|'unapproved_document_count'|'expired_document_count'|'expiring_7d_document_count'|'expiring_30d_document_count'|'review_due_document_count'|'missing_requirement_count'|'open_maintenance_count'|'overdue_maintenance_count',authorized:boolean)=>
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
        valid_documents:sum('valid_document_count',hasDocumentRead),
        expired_documents:sum('expired_document_count',hasDocumentRead),
        documents_expiring_7d:sum('expiring_7d_document_count',hasDocumentRead),
        documents_expiring_30d:sum('expiring_30d_document_count',hasDocumentRead),
        documents_review_due:sum('review_due_document_count',hasDocumentRead),
        unapproved_documents:sum('unapproved_document_count',hasDocumentRead),
        missing_required_documents:sum('missing_requirement_count',hasDocumentRead),
        open_maintenance:sum('open_maintenance_count',deviceSiteIds.length>0),
        overdue_maintenance:sum('overdue_maintenance_count',deviceSiteIds.length>0),
      };
      const keyMetrics=keySiteIds.length?(await query<Record<string,number>>(
        `SELECT COUNT(*)::int total_keys,
          COUNT(*) FILTER (WHERE k.status='available')::int available_keys,
          COUNT(*) FILTER (WHERE k.status='issued')::int issued_keys,
          COUNT(*) FILTER (WHERE k.status='issued' AND k.due_at<now())::int overdue_keys,
          COUNT(*) FILTER (WHERE k.status='lost')::int lost_keys,
          COUNT(*) FILTER (WHERE k.status='blocked')::int blocked_keys,
          COUNT(*) FILTER (WHERE k.status='deactivated')::int deactivated_keys,
          COUNT(*) FILTER (WHERE k.due_at>=now() AND k.due_at<now()+INTERVAL '7 days')::int due_7_days_keys,
          COUNT(*) FILTER (WHERE k.due_at>=now() AND k.due_at<now()+INTERVAL '30 days')::int due_30_days_keys
         FROM keys k WHERE k.tenant_id=$1 AND k.site_id=ANY($2::uuid[])`,
        [user.tenantId,keySiteIds],
      )).rows[0]??null:null;
      if(keyMetrics)Object.assign(metrics,keyMetrics);
      const keyActionRows=keySiteIds.length?(await query<{id:string;site_id:string;label:string;status:string;due_at:string|null;holder_user_id:string|null;holder_employee_id:string|null;location:string|null}>(
        `SELECT k.id,k.site_id,k.label,k.status,k.due_at,k.holder_user_id,k.holder_employee_id,k.location
         FROM keys k WHERE k.tenant_id=$1 AND k.site_id=ANY($2::uuid[])
           AND (k.status IN ('lost','blocked') OR (k.status='issued' AND k.due_at<now())
             OR (k.status='issued' AND k.holder_user_id IS NULL AND k.holder_employee_id IS NULL)
             OR (k.due_at>=now() AND k.due_at<now()+INTERVAL '7 days') OR k.location IS NULL)
         ORDER BY k.status,k.due_at NULLS LAST LIMIT 40`,
        [user.tenantId,keySiteIds],
      )).rows:[];
      const priorityActions=(await query<PriorityAction>(
        `WITH action_source AS (
          SELECT h.site_id,
            CASE WHEN h.risk_score>=20 THEN 'critical'::text ELSE 'high'::text END AS severity,
            'Gefährdungen'::text AS category,
            'Kritische Gefährdung: '||h.title AS title,
            'Risikoscore '||h.risk_score||COALESCE(' · '||l.name,'') AS detail,
            h.due_on::date AS due_on,'gefaehrdungen'::text AS tab,'sites:read'::text AS permission,
            h.id::text AS entity_id,NULL::text AS employee_id
          FROM object_hazards h
          LEFT JOIN object_locations l ON l.tenant_id=h.tenant_id AND l.id=h.location_id
          WHERE h.tenant_id=$1 AND h.site_id=ANY($2::uuid[]) AND h.status='open' AND h.risk_score>=15
          UNION ALL
          SELECT m.site_id,'high'::text,'Maßnahmen',
            'Überfällige Maßnahme: '||m.title,
            COALESCE('Gefährdung: '||h.title,'Maßnahme ohne verknüpfte Gefährdung'),
            m.due_on::date,'gefaehrdungen','sites:read',m.id::text,NULL::text
          FROM object_hazard_measures m
          LEFT JOIN object_hazards h ON h.tenant_id=m.tenant_id AND h.id=m.hazard_id
          WHERE m.tenant_id=$1 AND m.site_id=ANY($2::uuid[])
            AND m.status IN ('open','in_progress') AND m.due_on<CURRENT_DATE
          UNION ALL
          SELECT i.site_id,'high'::text,'Dienstanweisungen',
            'Freigabe ausstehend: '||i.title,'Version '||i.version,i.valid_until,'anweisungen','watchbook:read',i.id::text,NULL::text
          FROM site_instructions i
          WHERE i.tenant_id=$1 AND i.site_id=ANY($3::uuid[]) AND i.status='pending_approval'
          UNION ALL
          SELECT i.site_id,'high'::text,'Dienstanweisungen',
            'Dienstanweisung abgelaufen: '||i.title,'Version '||i.version,i.valid_until,'anweisungen','watchbook:read',i.id::text,NULL::text
          FROM site_instructions i
          WHERE i.tenant_id=$1 AND i.site_id=ANY($3::uuid[]) AND i.status='approved'
            AND i.valid_until IS NOT NULL AND i.valid_until<CURRENT_DATE
          UNION ALL
          SELECT i.site_id,'medium'::text,'Dienstanweisungen',
            'Kenntnisnahme ausstehend: '||i.title,
            count(DISTINCT oa.employee_id)||' zugeordnete Mitarbeitende ohne Bestätigung',
            i.valid_until,'anweisungen','watchbook:read',i.id::text,NULL::text
          FROM site_instructions i
          JOIN employee_object_assignments oa ON oa.tenant_id=i.tenant_id AND oa.site_id=i.site_id
            AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
          WHERE i.tenant_id=$1 AND i.site_id=ANY($9::uuid[]) AND i.status='approved' AND i.requires_acknowledgement
            AND NOT EXISTS (
              SELECT 1 FROM instruction_acknowledgements ia
              WHERE ia.tenant_id=i.tenant_id AND ia.instruction_id=i.id
                AND ia.employee_id=oa.employee_id AND ia.acknowledged_version=i.version
            )
          GROUP BY i.id,i.site_id,i.title,i.version,i.valid_until
          UNION ALL
          SELECT r.site_id,'high'::text,'Dokumente',
            'Pflichtdokument fehlt: '||r.document_type,
            COALESCE(e.name,'Keine verantwortliche Person hinterlegt'),NULL::date,'dokumente','dms:read',r.id::text,NULL::text
          FROM dms_document_requirements r
          LEFT JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.responsible_employee_id
          WHERE r.tenant_id=$1 AND r.site_id=ANY($4::uuid[]) AND r.required
            AND NOT EXISTS (
              SELECT 1 FROM dms_documents d
              JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available'
              WHERE d.tenant_id=r.tenant_id AND d.site_id=r.site_id AND d.document_type=r.document_type
                AND d.document_status='active' AND d.approval_status='approved'
                AND (d.valid_from IS NULL OR d.valid_from<=CURRENT_DATE)
                AND (d.valid_until IS NULL OR d.valid_until>=CURRENT_DATE)
            )
          UNION ALL
          SELECT d.site_id,'high'::text,'Dokumente',
            'Dokument abgelaufen: '||d.title,'Ablaufdatum '||d.valid_until::text,d.valid_until::date,'dokumente','dms:read',d.id::text,NULL::text
          FROM dms_documents d
          WHERE d.tenant_id=$1 AND d.site_id=ANY($4::uuid[]) AND d.document_status='active'
            AND d.approval_status='approved' AND d.valid_until<CURRENT_DATE
            AND EXISTS (SELECT 1 FROM dms_versions v WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available')
          UNION ALL
          SELECT d.site_id,'high'::text,'Dokumente',
            'Dokumentfreigabe ausstehend: '||d.title,'Freigabe und/oder verfügbare Version prüfen',d.valid_until::date,'dokumente','dms:read',d.id::text,NULL::text
          FROM dms_documents d
          WHERE d.tenant_id=$1 AND d.site_id=ANY($4::uuid[]) AND d.document_status='active'
            AND (d.approval_status<>'approved' OR NOT EXISTS (
              SELECT 1 FROM dms_versions v WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available'
            ))
          UNION ALL
          SELECT d.site_id,'high'::text,'Dokumente',
            'Dokumentprüfung fällig: '||d.title,'Prüffrist '||d.review_on::text,d.review_on,'dokumente','dms:read',d.id::text,NULL::text
          FROM dms_documents d
          WHERE d.tenant_id=$1 AND d.site_id=ANY($4::uuid[]) AND d.document_status='active'
            AND d.review_on<CURRENT_DATE
            AND (d.reviewed_at IS NULL OR d.reviewed_at::date<d.review_on)
          UNION ALL
          SELECT o.site_id,'high'::text,'Technik & Wartung',
            'Überfälliger Wartungsauftrag: '||o.order_number,
            COALESCE(d.name,'Gerät nicht zugeordnet')||' · '||o.description,o.due_on::date,'technik','devices:read',o.id::text,NULL::text
          FROM maintenance_orders o
          LEFT JOIN devices d ON d.tenant_id=o.tenant_id AND d.id=o.device_id
          WHERE o.tenant_id=$1 AND o.site_id=ANY($5::uuid[])
            AND o.status IN ('planned','open','in_progress') AND o.due_on<CURRENT_DATE
          UNION ALL
          SELECT cs.site_id,'high'::text,'Aufgaben',
            'Überfällige Aufgabe: '||ct.title,'Kunde: '||c.name,ct.due_at::date,'aufgaben','customers:read',ct.id::text,NULL::text
          FROM customer_tasks ct
          JOIN customer_sites cs ON cs.tenant_id=ct.tenant_id AND cs.customer_id=ct.customer_id AND cs.relationship_status='active'
          JOIN customers c ON c.tenant_id=ct.tenant_id AND c.id=ct.customer_id
          WHERE ct.tenant_id=$1 AND cs.site_id=ANY($6::uuid[]) AND ct.status='open' AND ct.due_at<now()
          UNION ALL
          SELECT sh.site_id,'medium'::text,'Dienstplanung',
            'Schicht ohne Besetzung: '||sh.role_code,'Planung: '||p.name,sh.starts_at::date,'dienstplanung','scheduling:read',sh.id::text,NULL::text
          FROM schedule_shifts sh
          JOIN schedule_periods p ON p.tenant_id=sh.tenant_id AND p.id=sh.period_id
          WHERE sh.tenant_id=$1 AND sh.site_id=ANY($7::uuid[]) AND p.status='published' AND sh.ends_at>=now()
            AND NOT EXISTS (
              SELECT 1 FROM schedule_assignments sa WHERE sa.tenant_id=sh.tenant_id AND sa.shift_id=sh.id AND sa.status='assigned'
            )
          UNION ALL
          SELECT oa.site_id,
            CASE WHEN q.status IN ('revoked','invalid','expired') OR q.valid_until<CURRENT_DATE THEN 'critical'::text
                 WHEN q.document_id IS NULL THEN 'high'::text ELSE 'medium'::text END,
            'Personal','Qualifikation prüfen: '||e.name||' · '||COALESCE(c.name,q.code),
            CASE WHEN q.status='revoked' THEN 'Qualifikation widerrufen'
                 WHEN q.status='invalid' OR c.active=false THEN 'Qualifikation ungültig oder Katalogeintrag inaktiv'
                 WHEN q.valid_until<CURRENT_DATE THEN 'Qualifikation abgelaufen'
                 WHEN q.document_id IS NULL THEN 'Kein Nachweis verknüpft'
                 ELSE 'Qualifikation läuft bald ab' END,
            q.valid_until,'personal','qualifications:read',q.id::text,q.employee_id::text
          FROM employee_qualifications q
          JOIN employee_object_assignments oa ON oa.tenant_id=q.tenant_id AND oa.employee_id=q.employee_id
            AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
          JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
          LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.code=q.code
          WHERE q.tenant_id=$1 AND oa.site_id=ANY($8::uuid[])
            AND (q.status IN ('revoked','invalid','expired') OR q.valid_until<CURRENT_DATE
              OR q.valid_until<=CURRENT_DATE+INTERVAL '90 days' OR q.document_id IS NULL)
        )
        SELECT a.*,s.name AS site_name,
          CASE WHEN a.severity='critical' THEN 'A' WHEN a.severity='high' THEN 'B' ELSE 'C' END AS priority,
          CASE
            WHEN a.employee_id IS NOT NULL THEN '/employees/'||a.employee_id||'/qualifikationen?qualification='||a.entity_id
            WHEN a.tab='gefaehrdungen' AND a.category='Maßnahmen' THEN '/sites/'||a.site_id||'/gefaehrdungen?measure='||a.entity_id
            WHEN a.tab='gefaehrdungen' THEN '/sites/'||a.site_id||'/gefaehrdungen?hazard='||a.entity_id
            WHEN a.tab='anweisungen' THEN '/sites/'||a.site_id||'/anweisungen?instruction='||a.entity_id
            WHEN a.tab='dokumente' AND a.title LIKE 'Pflichtdokument%' THEN '/sites/'||a.site_id||'/dokumente?requirement='||a.entity_id
            WHEN a.tab='dokumente' THEN '/sites/'||a.site_id||'/dokumente?document='||a.entity_id
            WHEN a.tab='technik' THEN '/sites/'||a.site_id||'/technik?maintenance_order='||a.entity_id
            WHEN a.tab='aufgaben' THEN '/sites/'||a.site_id||'/aufgaben?task='||a.entity_id
            WHEN a.tab='dienstplanung' THEN '/sites/'||a.site_id||'/dienstplanung?shift='||a.entity_id
            ELSE '/sites/'||a.site_id||'/'||a.tab END AS target
        FROM action_source a
        JOIN sites s ON s.tenant_id=$1 AND s.id=a.site_id
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
          a.due_on ASC NULLS LAST,a.title ASC
        LIMIT 40`,
        [user.tenantId,visibleSiteIds,watchbookSiteIds,documentSiteIds,deviceSiteIds,taskSiteIds,scheduleSiteIds,
          qualificationSiteIds,employeeSiteIds.filter(siteId=>watchbookSiteIds.includes(siteId))],
      )).rows;
      const siteNames=new Map(sites.map(site=>[site.id,site.name]));
      const keyPriorityActions:PriorityAction[]=keyActionRows.map(row=>{
        const missingHolder=!row.holder_user_id&&!row.holder_employee_id;
        const overdue=row.status==='issued'&&row.due_at!==null&&new Date(row.due_at).getTime()<Date.now();
        const severity:PriorityAction['severity']=row.status==='lost'||overdue||row.status==='issued'&&missingHolder
          ?'critical':row.status==='blocked'||row.due_at!==null?'high':'medium';
        const detail=row.status==='lost'?'Schlüssel als verloren gemeldet'
          :overdue?`Rückgabe überfällig seit ${row.due_at?.slice(0,10)}`
          :row.status==='blocked'?'Schlüssel technisch gesperrt'
          :missingHolder?'Ausgegebener Schlüssel ohne Halter'
          :row.due_at!==null?`Rückgabe fällig am ${row.due_at.slice(0,10)}`
          :'Kein Standort hinterlegt';
        return {
          id:`key:${row.id}`,site_id:row.site_id,site_name:siteNames.get(row.site_id)??null,entity_id:row.id,
          employee_id:null,severity,priority:priorityForSeverity(severity),category:'Schlüssel',
          title:`Schlüssel prüfen: ${row.label}`,detail,due_on:row.due_at?row.due_at.slice(0,10):null,
          tab:'schluessel',permission:'keys:read',target:`/sites/${row.site_id}/schluessel?key=${row.id}`,
        };
      });
      res.json({sites,metrics,priorityActions:sortPriorityActions([...priorityActions,...keyPriorityActions]).map(action=>({...action,priority:action.priority??priorityForSeverity(action.severity)}))});
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
      const documents=canReadDocuments?(await query<ClassifiedObjectDocumentRow>(
        `SELECT d.id,d.title,d.description,d.document_status,d.created_at,d.deleted_at,
          d.document_number,d.document_type,d.responsible_employee_id,d.valid_from,d.valid_until,d.review_on,
          d.reviewed_at,d.approved_by,d.approved_at,d.approval_status,d.location_id,
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
      )).rows.map(row=>({...row,...classifyDocument(row)})):null;
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
      const qualifications=canReadStaffing&&canReadSiteData('qualifications:read')?(await query<QualificationRow>(
        `SELECT q.id,q.employee_id,e.name AS employee_name,q.code,c.name AS qualification_name,
          q.valid_from,q.valid_until,q.status,q.document_id,q.issuing_authority,q.notes,q.revoked_at,q.updated_at,
          c.active AS catalog_active,
          d.title AS evidence_title,d.document_status AS evidence_document_status,
          d.approval_status AS evidence_approval_status,d.valid_from AS evidence_valid_from,
          d.valid_until AS evidence_valid_until,d.review_on AS evidence_review_on,d.reviewed_at AS evidence_reviewed_at,
          latest.lifecycle_state AS evidence_lifecycle_state,
          CASE WHEN q.status IN ('revoked','invalid') THEN q.status
            WHEN q.valid_until IS NULL THEN 'valid'
            WHEN q.valid_until<CURRENT_DATE THEN 'expired'
            WHEN q.valid_until<=CURRENT_DATE+INTERVAL '90 days' THEN 'expiring'
            ELSE 'valid' END AS computed_status,
           CASE WHEN q.status IN ('revoked','invalid') OR q.valid_until IS NULL THEN NULL
             ELSE (q.valid_until::date - CURRENT_DATE)::int END AS days_until_expiry
         FROM employee_qualifications q
         JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
         LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.code=q.code
          LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
          LEFT JOIN LATERAL (
            SELECT v.lifecycle_state FROM dms_versions v
            WHERE v.tenant_id=q.tenant_id AND v.document_id=q.document_id
            ORDER BY v.version_no DESC LIMIT 1
          ) latest ON true
         WHERE q.tenant_id=$1 AND EXISTS (
           SELECT 1 FROM employee_object_assignments oa
           WHERE oa.tenant_id=q.tenant_id AND oa.employee_id=q.employee_id AND oa.site_id=$2
             AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
         )
         ORDER BY e.name,c.name,q.valid_until NULLS LAST LIMIT 200`,
        [user.tenantId,id],
      )).rows:null;
      const enrichedQualifications=qualifications?enrichQualifications(qualifications):null;
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
      const requirementRows=canReadDocuments?(await query<{id:string;document_type:string;required:boolean|null;responsible_employee_name:string|null}>(
        `SELECT r.id,r.document_type,r.required,r.responsible_employee_id,e.name AS responsible_employee_name,r.created_at,r.updated_at
         FROM dms_document_requirements r
         LEFT JOIN employees e ON e.tenant_id=r.tenant_id AND e.id=r.responsible_employee_id
         WHERE r.tenant_id=$1 AND r.site_id=$2
         ORDER BY r.document_type`,
        [user.tenantId,id],
      )).rows:[];
      const maintenanceOrders=canReadSiteData('devices:read')?(await query(
        `SELECT o.*,d.name AS device_name,d.asset_number,e.name AS responsible_employee_name,
          COALESCE(json_agg(json_build_object('id',link.id,'document_id',link.document_id,'document_title',ld.title,'document_status',ld.document_status) ORDER BY link.created_at) FILTER (WHERE link.id IS NOT NULL),'[]') AS documents
         FROM maintenance_orders o
         LEFT JOIN devices d ON d.tenant_id=o.tenant_id AND d.id=o.device_id AND d.device_kind='operational'
         LEFT JOIN employees e ON e.tenant_id=o.tenant_id AND e.id=o.responsible_employee_id
         LEFT JOIN maintenance_order_documents link ON link.tenant_id=o.tenant_id AND link.order_id=o.id
         LEFT JOIN dms_documents ld ON ld.tenant_id=link.tenant_id AND ld.id=link.document_id
         WHERE o.tenant_id=$1 AND o.site_id=$2
         GROUP BY o.id,d.name,d.asset_number,e.name
         ORDER BY o.due_on ASC NULLS LAST,o.created_at DESC LIMIT 50`,
        [user.tenantId,id],
      )).rows.map((row):Record<string,unknown>=>{
        const order=withMaintenanceStatus(row as Record<string,unknown>) as Record<string,unknown>;
        const links=Array.isArray(order.documents)?order.documents as Array<Record<string,unknown>>:[];
        return {...order,documents:links.map(link=>{
          const classified=documents?.find(document=>document.id===link.document_id);
          return {
            ...link,
            document_status:classified?.status_label??link.document_status??null,
            computed_status:classified?.computed_status??null,
          };
        })};
      }):null;
      const documentRequirements=canReadDocuments?requirementRows.map(row=>({
        ...row,
        ...classifyRequirement(row,(documents??[]).filter(document=>document.document_type===row.document_type)),
      })):null;
      // One general personnel overview, explicitly distinct from the binding
      // per-shift verdict delivered by the staffing module.
      const enriched=enrichedQualifications??[];
      const issueRank:Record<QualificationIssue['severity'],number>={critical:0,high:1,medium:2};
      const expiringQualifications=enriched.filter(qualification=>qualification.issue.code==='expiring');
      const invalidQualifications=enriched.filter(qualification=>invalidIssueCodes.has(qualification.issue.code));
      const qualificationIssues=enriched.filter(qualification=>qualification.issue.code!=='none')
        .sort((left,right)=>issueRank[left.issue.severity]-issueRank[right.issue.severity]
          ||left.employee_name.localeCompare(right.employee_name));
      const staffingById=new Map((staffing??[]).map(assignment=>[assignment.employee_id as string,assignment]));
      const staffIds=new Set(staffingById.keys());
      const missingAcknowledgements=(instructions??[]).flatMap(instruction=>{
        if(instruction.status!=='approved'||instruction.requires_acknowledgement!==true)return [];
        const acknowledged=new Set((instruction.acknowledgements??[]).map((acknowledgement:{employee_id:string})=>acknowledgement.employee_id));
        const missing=[...staffingById.values()].filter(assignment=>!acknowledged.has(assignment.employee_id as string));
        return missing.length?[{
          instruction_id:instruction.id,title:instruction.title,version:instruction.version,
          target:`/sites/${id}/anweisungen`,
          missing_employee_ids:missing.map(assignment=>assignment.employee_id),
          missing_employees:missing.map(assignment=>({
            employee_id:assignment.employee_id,
            employee_name:assignment.employee_name,
            employee_url:`/employees/${assignment.employee_id}`,
          })),
        }]:[];
      });
      const personnelSummary=canReadStaffing?{
        assigned_employee_count:staffIds.size,
        expiring_qualification_count:expiringQualifications.length,
        invalid_qualification_count:invalidQualifications.length,
        qualification_issue_count:qualificationIssues.length,
        blocking_qualification_issue_count:qualificationIssues.filter(qualification=>blockingIssueCodes.has(qualification.issue.code)).length,
        expiring_qualifications:expiringQualifications,
        invalid_qualifications:invalidQualifications,
        qualification_issues:qualificationIssues,
        pending_acknowledgement_count:missingAcknowledgements.length,
        missing_acknowledgements:missingAcknowledgements,
      }:null;
      const recentPersonnelChanges=canReadStaffing?(await query(
        `SELECT a.created_at AS occurred_at,a.event_type,a.entity_id,
           NULLIF(a.details->>'employee_id','') AS employee_id,
           e.name AS employee_name,u.email AS actor_email,a.details
          FROM audit_events a
          LEFT JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=NULLIF(a.details->>'employee_id','')::uuid
          LEFT JOIN users u ON u.tenant_id=a.tenant_id AND u.id=a.actor_user_id
          WHERE a.tenant_id=$1
            AND (a.details->>'site_id'=$3 OR EXISTS (
              SELECT 1 FROM employee_object_assignments oa
              WHERE oa.tenant_id=a.tenant_id AND oa.site_id=$2
                AND oa.employee_id::text=a.details->>'employee_id'))
            AND a.event_type IN ('employee.object_assignment.created','employee.object_assignment.ended',
              'employee.profile.updated','employee.absence.created','employee.absence.updated',
              'employee.absence.cancelled','qualification.employee.updated','qualification.employee.deleted')
          ORDER BY a.created_at DESC LIMIT 20`,
        [user.tenantId,id,id],
      )).rows:null;
      const statusCounts=documents?documentStatusCounts(documents):null;
      const warningCounts=documents?documentWarningCounts(documents):null;
      const maintenanceStatusCounts=maintenanceOrders?maintenanceOrders.reduce<Record<string,number>>((counts,order)=>{
        const computed=withMaintenanceStatus(order).computed_status;
        counts[computed]=(counts[computed]??0)+1;
        return counts;
      },{planned:0,open:0,in_progress:0,overdue:0,completed:0,cancelled:0}):null;
      const now=new Date();
      const today=now.toISOString().slice(0,10);
      const day=(value:unknown):string|null=>{
        if(value===null||value===undefined||value==='')return null;
        return value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
      };
      const sectionTarget=(tab:string,param?:string,recordId?:string|null)=>`/sites/${id}/${tab}${param&&recordId?`?${param}=${recordId}`:''}`;
      const action=(input:Omit<PriorityAction,'priority'>):PriorityAction=>({...input,priority:priorityForSeverity(input.severity)});
      const actions:PriorityAction[]=[];
      for(const hazard of hazards??[]){
        if(hazard.status==='open'&&hazard.risk_score>=15)actions.push(action({
          id:`hazard-${hazard.id}`,site_id:id,entity_id:hazard.id,
          severity:hazard.risk_score>=20?'critical':'high',category:'Gefährdungen',
          title:`Kritische Gefährdung: ${hazard.title}`,
          detail:`Risikoscore ${hazard.risk_score}${hazard.location_name?` · ${hazard.location_name}`:''}`,
          due_on:day(hazard.due_on),tab:'gefaehrdungen',permission:'sites:read',target:sectionTarget('gefaehrdungen','hazard',hazard.id),
        }));
        for(const measure of hazard.measures??[]){
          if(['open','in_progress'].includes(measure.status)&&measure.due_on&&day(measure.due_on)!<today)actions.push(action({
            id:`measure-${measure.id}`,site_id:id,entity_id:measure.id,severity:'high',category:'Maßnahmen',
            title:`Überfällige Maßnahme: ${measure.title}`,detail:`Gefährdung: ${hazard.title}`,
            due_on:day(measure.due_on),tab:'gefaehrdungen',permission:'sites:read',target:sectionTarget('gefaehrdungen','measure',measure.id),
          }));
        }
      }
      for(const instruction of instructions??[]){
        const instructionTarget=sectionTarget('anweisungen','instruction',instruction.id);
        if(instruction.status==='pending_approval')actions.push(action({
          id:`instruction-approval-${instruction.id}`,site_id:id,entity_id:instruction.id,severity:'high',category:'Dienstanweisungen',
          title:`Freigabe ausstehend: ${instruction.title}`,detail:`Version ${instruction.version}`,
          due_on:day(instruction.valid_until),tab:'anweisungen',permission:'watchbook:read',target:instructionTarget,
        }));
        if(instruction.status==='approved'&&instruction.valid_until&&day(instruction.valid_until)!<today)actions.push(action({
          id:`instruction-expired-${instruction.id}`,site_id:id,entity_id:instruction.id,severity:'high',category:'Dienstanweisungen',
          title:`Dienstanweisung abgelaufen: ${instruction.title}`,detail:`Version ${instruction.version}`,
          due_on:day(instruction.valid_until),tab:'anweisungen',permission:'watchbook:read',target:instructionTarget,
        }));
      }
      for(const acknowledgement of missingAcknowledgements)actions.push(action({
        id:`acknowledgement-${acknowledgement.instruction_id}`,site_id:id,entity_id:acknowledgement.instruction_id,
        severity:'medium',category:'Dienstanweisungen',
        title:`Kenntnisnahme ausstehend: ${acknowledgement.title}`,
        detail:acknowledgement.missing_employees.map(employee=>employee.employee_name).join(', '),
        due_on:null,tab:'anweisungen',permission:'watchbook:read',target:sectionTarget('anweisungen','instruction',acknowledgement.instruction_id),
      }));
      for(const requirement of documentRequirements??[]){
        if(!requirement.missing)continue;
        actions.push(action({
          id:`requirement-${requirement.id}`,site_id:id,entity_id:requirement.id,severity:'high',category:'Dokumente',
          title:`Pflichtdokument fehlt: ${requirement.document_type}`,
          detail:requirement.responsible_employee_name??'Keine verantwortliche Person hinterlegt',
          due_on:null,tab:'dokumente',permission:'dms:read',target:sectionTarget('dokumente','requirement',requirement.id),
        }));
      }
      for(const document of documents??[]){
        const documentTarget=sectionTarget('dokumente','document',document.id);
        if(document.computed_status==='abgelaufen')actions.push(action({
          id:`document-expired-${document.id}`,site_id:id,entity_id:document.id,severity:'high',category:'Dokumente',
          title:`Dokument abgelaufen: ${document.title}`,detail:day(document.valid_until)?`Ablaufdatum ${day(document.valid_until)}`:'Ablaufdatum nicht hinterlegt',
          due_on:day(document.valid_until),tab:'dokumente',permission:'dms:read',target:documentTarget,
        }));
        if(document.computed_status==='nicht_freigegeben')actions.push(action({
          id:`document-unapproved-${document.id}`,site_id:id,entity_id:document.id,severity:'high',category:'Dokumente',
          title:`Dokumentfreigabe ausstehend: ${document.title}`,detail:'Freigabe und/oder verfügbare Version prüfen',
          due_on:day(document.valid_until),tab:'dokumente',permission:'dms:read',target:documentTarget,
        }));
        if(document.review_state==='overdue')actions.push(action({
          id:`document-review-${document.id}`,site_id:id,entity_id:document.id,severity:'high',category:'Dokumente',
          title:`Dokumentprüfung fällig: ${document.title}`,detail:day(document.review_on)?`Prüffrist ${day(document.review_on)}`:'Prüffrist überfällig',
          due_on:day(document.review_on),tab:'dokumente',permission:'dms:read',target:documentTarget,
        }));
      }
      for(const order of maintenanceOrders??[]){
        const computed=String(order.computed_status??order.status??'');
        if(!['planned','open','in_progress','overdue'].includes(computed))continue;
        actions.push(action({
          id:`maintenance-${String(order.id)}`,site_id:id,entity_id:String(order.id),severity:computed==='overdue'?'critical':'medium',
          category:'Technik & Wartung',title:`${computed==='overdue'?'Überfälliger':'Offener'} Wartungsauftrag: ${String(order.order_number??'')}`,
          detail:`${String(order.device_name??'Gerät nicht zugeordnet')} · ${String(order.description??'')}`,
          due_on:day(order.due_on as string|null|undefined),tab:'technik',permission:'devices:read',target:sectionTarget('technik','maintenance_order',String(order.id)),
        }));
      }
      for(const task of customerTasks??[]){
        if(task.status!=='open'||!task.due_at||new Date(String(task.due_at)).getTime()>=now.getTime())continue;
        actions.push(action({
          id:`task-${task.id}`,site_id:id,entity_id:task.id,severity:'high',category:'Aufgaben',
          title:`Überfällige Aufgabe: ${task.title}`,detail:`Kunde: ${task.customer_name??'unbekannt'}`,
          due_on:day(task.due_at),tab:'aufgaben',permission:'customers:read',target:sectionTarget('aufgaben','task',task.id),
        }));
      }
      for(const shift of shifts??[]){
        if(shift.period_status!=='published'||shift.assigned_count>0||new Date(String(shift.ends_at)).getTime()<now.getTime())continue;
        actions.push(action({
          id:`shift-${shift.id}`,site_id:id,entity_id:shift.id,severity:'medium',category:'Dienstplanung',
          title:`Schicht ohne Besetzung: ${shift.role_code}`,detail:`Planung: ${shift.period_name}`,
          due_on:day(shift.starts_at),tab:'dienstplanung',permission:'scheduling:read',target:sectionTarget('dienstplanung','shift',shift.id),
        }));
      }
      for(const qualification of qualificationIssues)actions.push(action({
        id:`qualification-${qualification.id}`,site_id:id,entity_id:qualification.id,employee_id:qualification.employee_id,
        severity:issueSeverity[qualification.issue.code]??'medium',category:'Personal',
        title:`Qualifikation prüfen: ${qualification.employee_name} · ${qualification.qualification_name??qualification.code}`,
        detail:`${qualification.issue.detail} · ${qualification.evidence_label}`,
        due_on:day(qualification.valid_until),tab:'personal',permission:'qualifications:read',
        target:`${qualification.employee_url}?qualification=${qualification.id}${qualification.evidence_document_id&&!['missing','not_found'].includes(qualification.evidence_status)?`&document=${qualification.evidence_document_id}`:''}`,
      }));
      res.json({site,customers,contracts,locations,hazards,instructions,journal,staffing,assignmentHistory,shifts,patrols,keys,keyBundles,documents,documentStatusCounts:statusCounts,documentWarningCounts:warningCounts,documentRequirements,alarms,incidents,customerTasks,maintenance,maintenanceOrders,maintenanceStatusCounts,qualifications:enrichedQualifications,personnelSummary,recentPersonnelChanges,handovers,devices,priorityActions:sortPriorityActions(actions,12)});
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid site id'});next(error);}
  },
);

objectManagementRouter.post('/sites/:id/document-requirements',requireAuth,requireCsrf,requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('dms:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id));
    const body=z.object({document_type:nonempty.max(160),required:z.boolean().default(true),responsible_employee_id:uuid.nullable().optional()}).strict().parse(req.body);
    if(body.responsible_employee_id&&!await employeeAssignedToSite(req.user!.tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    const row=(await query(
      `INSERT INTO dms_document_requirements(tenant_id,site_id,document_type,required,responsible_employee_id,created_by)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(tenant_id,site_id,document_type) DO UPDATE SET required=EXCLUDED.required,responsible_employee_id=EXCLUDED.responsible_employee_id,updated_at=now()
       RETURNING *`,
      [req.user!.tenantId,siteId,body.document_type,body.required,body.responsible_employee_id??null,req.user!.id],
    )).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'site.document_requirement.saved','dms_document_requirement',row.id,{site_id:siteId,document_type:body.document_type,required:body.required});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid document requirement'});next(error);}
});

objectManagementRouter.patch('/sites/:id/document-requirements/:requirementId',requireAuth,requireCsrf,requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('dms:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id));
    const requirementId=uuid.parse(String(req.params.requirementId));
    const body=z.object({required:z.boolean(),responsible_employee_id:uuid.nullable().optional()}).strict().parse(req.body);
    if(body.responsible_employee_id&&!await employeeAssignedToSite(req.user!.tenantId,siteId,body.responsible_employee_id))return res.status(400).json({error:'Responsible employee must be assigned to this site'});
    const row=(await query(
      `UPDATE dms_document_requirements SET required=$4,responsible_employee_id=$5,updated_at=now()
       WHERE tenant_id=$1 AND site_id=$2 AND id=$3 RETURNING *`,
      [req.user!.tenantId,siteId,requirementId,body.required,body.responsible_employee_id??null],
    )).rows[0];
    if(!row)return res.status(404).json({error:'Document requirement not found'});
    await recordAudit(req.user!.tenantId,req.user!.id,'site.document_requirement.updated','dms_document_requirement',requirementId,{site_id:siteId,required:body.required});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid document requirement'});next(error);}
});

objectManagementRouter.delete('/sites/:id/document-requirements/:requirementId',requireAuth,requireCsrf,requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('dms:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id));
    const requirementId=uuid.parse(String(req.params.requirementId));
    const row=(await query('DELETE FROM dms_document_requirements WHERE tenant_id=$1 AND site_id=$2 AND id=$3 RETURNING id',[req.user!.tenantId,siteId,requirementId])).rows[0];
    if(!row)return res.status(404).json({error:'Document requirement not found'});
    await recordAudit(req.user!.tenantId,req.user!.id,'site.document_requirement.deleted','dms_document_requirement',requirementId,{site_id:siteId});
    res.status(204).send();
  }catch(error){next(error);}
});

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
