/**
 * Server-side aggregation for the operative control centre.
 *
 * All displayed facts come from existing domain tables. Eligibility and
 * qualification/document classifications are delegated to the central
 * services; this module only aggregates, filters and prioritises them.
 */
import type {Request} from 'express';
import {query} from '../db/pool.js';
import {
  canUsePermission,
  effectivePermissionScope,
  normalizePermissionGrants,
  type AuthorizationContext,
} from '../types/authorization.js';
import {qualificationStatesCte,qualificationStatusSql} from './qualification-status-sql.js';
import {classifyDocument,classifyRequirement} from './dms-document-status.js';
import {derivedKeyStatus,type KeyStatus} from './keys-domain.js';
import {evaluateShiftAssignment,hardReasons,isHardReason} from './staffing-verdict.js';

type Row=Record<string,any>;
export type ControlCenterUser=AuthorizationContext;
export type ControlCenterFilters={
  date:string;
  siteId?:string;
  customerId?:string;
  employeeId?:string;
  page:number;
  pageSize:number;
};

const berlinDate=`(now() AT TIME ZONE 'Europe/Berlin')::date`;
const allowedReadScopes=['tenant','site','system'] as const;
const priorityRank:Record<string,number>={critical:0,high:1,medium:2,low:3};
const qualificationCategoryLabels:Record<string,string>={
  revoked:'Widerrufen',invalid:'Ungültig',expired:'Abgelaufen',not_yet_valid:'Noch nicht gültig',
  missing_evidence:'Nachweis fehlt',awaiting_review:'Freigabe ausstehend',expiring:'Läuft bald ab',valid:'Gültig',
};
const hardQualificationStates=new Set(['revoked','invalid','expired','not_yet_valid','missing_evidence','awaiting_review']);
const reasonLabels:Record<string,string>={
  qualification_missing:'Pflichtqualifikation fehlt',qualification_revoked:'Qualifikation widerrufen',
  qualification_expired:'Qualifikation abgelaufen',qualification_invalid:'Qualifikation ungültig',
  qualification_not_yet_valid:'Qualifikation noch nicht gültig',qualification_evidence_missing:'Nachweis fehlt',
  qualification_evidence_unapproved:'Nachweis nicht freigegeben',employment_not_started:'Beschäftigung noch nicht begonnen',
  employment_ended:'Beschäftigung bereits beendet',employment_status:'Beschäftigungsstatus gesperrt',
  site_assignment:'Keine Objektzuordnung',absence_approved:'Genehmigte Abwesenheit',overlapping_shift:'Zeitliche Überschneidung',
  period_closed:'Zeitraum abgeschlossen',shift_in_past:'Schicht in der Vergangenheit',
};

export function controlCenterUser(req:Request):ControlCenterUser{
  const user=req.user!;
  return {
    userId:user.id,
    tenantId:user.tenantId,
    role:user.role,
    isSystemAdmin:user.isSystemAdmin===true,
    siteIds:user.siteIds??[],
    grants:normalizePermissionGrants(user.permissionGrants,user.permissions),
  };
}

function scope(user:ControlCenterUser,permission:string):string|null{
  if(!canUsePermission(user,permission,[...allowedReadScopes]))return null;
  return effectivePermissionScope(user.grants,permission,user);
}

function siteClause(user:ControlCenterUser,permission:string,alias:string,values:unknown[],column='site_id'):string{
  const readScope=scope(user,permission);
  if(readScope==null)return ' AND FALSE';
  if(readScope==='site'){
    values.push(user.siteIds);
    return ` AND ${alias}.${column} = ANY($${values.length}::uuid[])`;
  }
  return '';
}

function employeeClause(user:ControlCenterUser,alias:string,values:unknown[]):string{
  const readScope=scope(user,'employees:read');
  if(readScope==null)return ' AND FALSE';
  if(readScope==='site'){
    values.push(user.siteIds);
    return ` AND EXISTS (SELECT 1 FROM employee_object_assignments oa
       WHERE oa.tenant_id=${alias}.tenant_id AND oa.employee_id=${alias}.id
         AND oa.site_id=ANY($${values.length}::uuid[]))`;
  }
  return '';
}

function localWeekdayAndMinute(now:Date){
  const short=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Berlin',weekday:'short'}).format(now);
  const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
  const weekdays:Record<string,number>={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  const [hours='0',minutes='0']=clock.split(':');
  return {weekday:weekdays[short]??0,minute:Number(hours)*60+Number(minutes)};
}

function isAvailableNow(availability:Row[],now:Date):boolean{
  const current=localWeekdayAndMinute(now);
  const relevant=availability.filter(item=>{
    const from=item.valid_from?String(item.valid_from):null;
    const until=item.valid_until?String(item.valid_until):null;
    return (!from||from<=now.toISOString().slice(0,10))&&(!until||until>=now.toISOString().slice(0,10));
  });
  if(!relevant.length)return true;
  return relevant.some(item=>{
    if(item.available===false)return false;
    const start=String(item.starts_time).split(':').map(Number);
    const end=String(item.ends_time).split(':').map(Number);
    const startMinute=(start[0]??0)*60+(start[1]??0);
    const endMinute=(end[0]??0)*60+(end[1]??0);
    const weekday=Number(item.weekday);
    if(endMinute>startMinute)return weekday===current.weekday&&current.minute>=startMinute&&current.minute<endMinute;
    if(endMinute===startMinute)return false;
    return (weekday===current.weekday&&current.minute>=startMinute)
      ||((weekday+1)%7===current.weekday&&current.minute<endMinute);
  });
}

function priority(value:string):string{
  return value in priorityRank?value:'medium';
}

function detectedAt(...values:Array<string|null|undefined>):string{
  const parsed=values.filter(Boolean).map(value=>new Date(String(value)).getTime()).filter(Number.isFinite);
  return parsed.length?new Date(Math.min(...parsed)).toISOString():new Date().toISOString();
}

export async function getControlCenter(user:ControlCenterUser,filters:ControlCenterFilters){
  const tenant=user.tenantId;
  const now=new Date();
  const page=Math.max(1,Math.floor(filters.page)||1);
  const pageSize=Math.min(100,Math.max(5,Math.floor(filters.pageSize)||25));
  const sections={
    kpi:scope(user,'nsl:read')!=null,
    shifts:scope(user,'scheduling:read')!=null,
    employees:scope(user,'employees:read')!=null,
    sites:scope(user,'sites:read')!=null,
    qualifications:scope(user,'qualifications:read')!=null,
    documents:scope(user,'dms:read')!=null,
    devices:scope(user,'nfc_devices:read')!=null,
    keys:scope(user,'keys:read')!=null,
    measures:scope(user,'operations_measures:read')!=null,
    alarms:scope(user,'alarms:read')!=null,
  };
  // Bereiche ohne Leserecht werden gar nicht erst abgefragt; leere Arrays sind
  // damit das Ergebnis fehlender Berechtigung, nicht einer leeren Fachdatenbank.
  const noRows=()=>Promise.resolve({rows:[]} as unknown as Awaited<ReturnType<typeof query<Row>>>);

  // Der Tagesfilter belegt $2; Scope- und Objektfilter müssen daher ab $3 nummeriert werden.
  const siteValues:unknown[]=[tenant,filters.date];
  let siteWhere=sections.sites?siteClause(user,'sites:read','s',siteValues,'id'):' AND FALSE';
  if(filters.siteId){siteValues.push(filters.siteId);siteWhere+=` AND s.id=$${siteValues.length}`;}
  if(filters.customerId){siteValues.push(filters.customerId);siteWhere+=` AND c.id=$${siteValues.length}`;}
  if(filters.employeeId){siteValues.push(filters.employeeId);siteWhere+=` AND EXISTS (SELECT 1 FROM employee_object_assignments oa WHERE oa.tenant_id=s.tenant_id AND oa.site_id=s.id AND oa.employee_id=$${siteValues.length})`;} 
  const siteRows=sections.sites?query<Row>(
    `SELECT s.id,s.name,s.site_number,s.status,s.required_staff_count,s.city,
       c.id customer_id,c.name customer_name,
       (SELECT count(*)::int FROM schedule_shifts sh
         WHERE sh.tenant_id=s.tenant_id AND sh.site_id=s.id
           AND (sh.starts_at AT TIME ZONE 'Europe/Berlin')::date <= $2::date
           AND (sh.ends_at AT TIME ZONE 'Europe/Berlin')::date >= $2::date) today_shifts,
       (SELECT count(*)::int FROM schedule_shifts sh
         WHERE sh.tenant_id=s.tenant_id AND sh.site_id=s.id
           AND (sh.starts_at AT TIME ZONE 'Europe/Berlin')::date <= $2::date
           AND (sh.ends_at AT TIME ZONE 'Europe/Berlin')::date >= $2::date
           AND NOT EXISTS (SELECT 1 FROM schedule_assignments a
             WHERE a.tenant_id=sh.tenant_id AND a.shift_id=sh.id AND a.status='assigned')) open_shifts,
       (SELECT count(DISTINCT a.employee_id)::int FROM schedule_assignments a
         JOIN schedule_shifts sh ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
         WHERE sh.tenant_id=s.tenant_id AND sh.site_id=s.id AND a.status='assigned'
           AND (sh.starts_at AT TIME ZONE 'Europe/Berlin')::date <= $2::date
           AND (sh.ends_at AT TIME ZONE 'Europe/Berlin')::date >= $2::date) assigned_today,
       GREATEST(
         COALESCE((SELECT max(updated_at) FROM sites WHERE tenant_id=s.tenant_id AND id=s.id),s.updated_at),
         COALESCE((SELECT max(updated_at) FROM dms_documents WHERE tenant_id=s.tenant_id AND site_id=s.id),s.updated_at),
         COALESCE((SELECT max(created_at) FROM audit_events WHERE tenant_id=s.tenant_id AND entity_id=s.id),s.updated_at)
       ) last_activity_at
     FROM sites s
     LEFT JOIN customer_sites cs ON cs.tenant_id=s.tenant_id AND cs.site_id=s.id
       AND cs.relationship_status='active' AND cs.is_primary=true
     LEFT JOIN customers c ON c.tenant_id=s.tenant_id AND c.id=cs.customer_id
     WHERE s.tenant_id=$1${siteWhere}
     ORDER BY s.name`,siteValues):noRows();

  const shiftValues:unknown[]=[tenant,filters.date];
  const shiftSiteFilter=sections.shifts?siteClause(user,'scheduling:read','sh',shiftValues):' AND FALSE';
  const shiftCustomerFilter=filters.customerId?` AND c.id=$${shiftValues.length+1}`:'';
  if(filters.customerId)shiftValues.push(filters.customerId);
  const shiftSiteIdFilter=filters.siteId?` AND sh.site_id=$${shiftValues.length+1}`:'';
  if(filters.siteId)shiftValues.push(filters.siteId);
  const shiftEmployeeFilter=filters.employeeId?` AND EXISTS (SELECT 1 FROM schedule_assignments af
       WHERE af.tenant_id=sh.tenant_id AND af.shift_id=sh.id AND af.employee_id=$${shiftValues.length+1})`:'';
  if(filters.employeeId)shiftValues.push(filters.employeeId);
  const shiftRows=sections.shifts?query<Row>(
    `SELECT sh.*,s.name site_name,s.required_staff_count,s.site_number,
       c.id customer_id,c.name customer_name,
       COALESCE((SELECT json_agg(json_build_object('id',a.id,'employee_id',a.employee_id,'employee_name',e.name,'status',a.status))
         FROM schedule_assignments a LEFT JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id
         WHERE a.tenant_id=sh.tenant_id AND a.shift_id=sh.id),'[]'::json) assignments,
       COALESCE((SELECT json_agg(json_build_object('id',cf.id,'type',cf.conflict_type,'severity',cf.severity,'details',cf.details,'detected_at',cf.detected_at))
         FROM schedule_conflicts cf WHERE cf.tenant_id=sh.tenant_id AND cf.shift_id=sh.id AND cf.resolved_at IS NULL),'[]'::json) conflicts
     FROM schedule_shifts sh
     JOIN sites s ON s.tenant_id=sh.tenant_id AND s.id=sh.site_id
     LEFT JOIN customer_sites cs ON cs.tenant_id=s.tenant_id AND cs.site_id=s.id
       AND cs.relationship_status='active' AND cs.is_primary=true
     LEFT JOIN customers c ON c.tenant_id=s.tenant_id AND c.id=cs.customer_id
     WHERE sh.tenant_id=$1
       AND (sh.starts_at AT TIME ZONE 'Europe/Berlin')::date <= $2::date
       AND (sh.ends_at AT TIME ZONE 'Europe/Berlin')::date >= $2::date
       ${shiftSiteFilter}${shiftCustomerFilter}${shiftSiteIdFilter}${shiftEmployeeFilter}
     ORDER BY sh.starts_at,sh.role_code`,shiftValues):noRows();

  const employeeValues:unknown[]=[tenant];
  const employeeWhere=sections.employees?employeeClause(user,'e',employeeValues):' AND FALSE';
  const employeeFilter=filters.employeeId?` AND e.id=$${employeeValues.length+1}`:'';
  if(filters.employeeId)employeeValues.push(filters.employeeId);
  const employeeRows=sections.employees?query<Row>(
    `${qualificationStatesCte()}
     SELECT e.id,e.name,e.employment_status,e.position,e.email,
       COALESCE((SELECT s.name FROM employee_object_assignments oa
         JOIN sites s ON s.tenant_id=oa.tenant_id AND s.id=oa.site_id
         WHERE oa.tenant_id=e.tenant_id AND oa.employee_id=e.id
           AND oa.starts_on<=${berlinDate} AND (oa.ends_on IS NULL OR oa.ends_on>=${berlinDate})
         ORDER BY oa.primary_assignment DESC,oa.starts_on DESC LIMIT 1),'') site_name,
       COALESCE((SELECT array_agg(DISTINCT st.computed_status) FROM states st WHERE st.employee_id=e.id),'{}'::text[]) qualification_states,
       COALESCE((SELECT json_agg(json_build_object('id',ab.id,'type',ab.absence_type,'status',ab.status,'starts_at',ab.starts_at,'ends_at',ab.ends_at))
         FROM employee_absences ab WHERE ab.tenant_id=e.tenant_id AND ab.employee_id=e.id
           AND ab.status IN ('requested','approved') AND ab.starts_at<now()+INTERVAL '7 days' AND ab.ends_at>=now()),'[]'::json) absences,
       COALESCE((SELECT json_agg(json_build_object('weekday',av.weekday,'starts_time',av.starts_time,'ends_time',av.ends_time,'available',av.available,'valid_from',av.valid_from,'valid_until',av.valid_until))
         FROM employee_availability av WHERE av.tenant_id=e.tenant_id AND av.employee_id=e.id),'[]'::json) availability,
       COALESCE((SELECT count(*)::int FROM schedule_assignments a
         JOIN schedule_shifts sh ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
         WHERE a.tenant_id=e.tenant_id AND a.employee_id=e.id AND a.status='assigned'
           AND sh.starts_at<now()+INTERVAL '7 days' AND sh.ends_at>=now()),0) upcoming_assignments
     FROM employees e WHERE e.tenant_id=$1${employeeWhere}${employeeFilter}
     ORDER BY e.name`,employeeValues):noRows();

  const qualificationValues:unknown[]=[tenant];
  const qualificationWhere=sections.qualifications?employeeClause(user,'e',qualificationValues):' AND FALSE';
  const qualificationRows=sections.qualifications?query<Row>(
    `${qualificationStatesCte()}
     SELECT e.id employee_id,e.name employee_name,q.id qualification_id,q.code,q.catalog_id,q.valid_from,q.valid_until,
       st.computed_status,
       COALESCE((SELECT json_agg(json_build_object('id',r.id,'site_id',r.site_id,'site_name',s.name))
         FROM site_qualification_requirements r JOIN sites s ON s.tenant_id=r.tenant_id AND s.id=r.site_id
         WHERE r.tenant_id=q.tenant_id AND r.catalog_id=q.catalog_id AND r.active=true AND r.required=true),'[]'::json) sites
     FROM states st
     JOIN employees e ON e.tenant_id=$1 AND e.id=st.employee_id
     LEFT JOIN employee_qualifications q ON q.tenant_id=$1 AND q.id=st.qualification_id
     WHERE st.computed_status<>'valid'${qualificationWhere}
     ORDER BY CASE st.computed_status
       WHEN 'revoked' THEN 1 WHEN 'invalid' THEN 2 WHEN 'expired' THEN 3
       WHEN 'missing_evidence' THEN 4 WHEN 'awaiting_review' THEN 5
       WHEN 'not_yet_valid' THEN 6 ELSE 7 END, q.valid_until NULLS LAST,e.name`,
    qualificationValues):noRows();

  const documentValues:unknown[]=[tenant];
  const documentWhere=sections.documents?siteClause(user,'dms:read','d',documentValues):' AND FALSE';
  const documentRows=sections.documents?query<Row>(
    `SELECT d.id,d.title,d.document_type,d.site_id,d.employee_id,d.customer_id,d.document_status,d.approval_status,
       d.valid_from,d.valid_until,d.review_on,d.reviewed_at,d.created_at,d.updated_at,
       COALESCE(json_agg(json_build_object('id',v.id,'version_no',v.version_no,'lifecycle_state',v.lifecycle_state,'created_at',v.created_at))
         FILTER (WHERE v.id IS NOT NULL),'[]'::json) versions
     FROM dms_documents d LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
     WHERE d.tenant_id=$1 AND d.document_status='active'${documentWhere}
     GROUP BY d.id ORDER BY d.updated_at DESC LIMIT 500`,documentValues):noRows();

  const requirementValues:unknown[]=[tenant];
  const requirementWhere=sections.documents?siteClause(user,'dms:read','r',requirementValues):' AND FALSE';
  const requirementRows=sections.documents?query<Row>(
    `SELECT r.id,r.site_id,s.name site_name,r.document_type,r.required,
       COALESCE(json_agg(json_build_object('id',d.id,'title',d.title,'document_type',d.document_type,
         'document_status',d.document_status,'approval_status',d.approval_status,'valid_from',d.valid_from,
         'valid_until',d.valid_until,'review_on',d.review_on,'reviewed_at',d.reviewed_at,
         'versions',COALESCE((SELECT json_agg(json_build_object('lifecycle_state',v.lifecycle_state))
           FROM dms_versions v WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id),'[]'::json)))
         FILTER (WHERE d.id IS NOT NULL),'[]'::json) documents
     FROM dms_document_requirements r
     JOIN sites s ON s.tenant_id=r.tenant_id AND s.id=r.site_id
     LEFT JOIN dms_documents d ON d.tenant_id=r.tenant_id AND d.site_id=r.site_id
       AND d.document_type=r.document_type AND d.document_status='active'
     WHERE r.tenant_id=$1 AND r.required=true${requirementWhere} GROUP BY r.id,s.name ORDER BY s.name,r.document_type`,requirementValues):noRows();

  const deviceValues:unknown[]=[tenant];
  const deviceWhere=sections.devices?siteClause(user,'nfc_devices:read','n',deviceValues):' AND FALSE';
  const deviceRows=sections.devices?query<Row>(
    `SELECT n.id,n.identifier,n.device_type,n.status,n.employee_id,n.site_id,n.control_point_id,
       n.archived_at,n.recovered_at,n.replaced_at,n.blocked_at,n.lost_at,n.event_reason,n.updated_at,
       e.name employee_name,s.name site_name
     FROM nfc_devices n LEFT JOIN employees e ON e.tenant_id=n.tenant_id AND e.id=n.employee_id
     LEFT JOIN sites s ON s.tenant_id=n.tenant_id AND s.id=n.site_id
     WHERE n.tenant_id=$1${deviceWhere}
     ORDER BY CASE n.status WHEN 'lost' THEN 1 WHEN 'blocked' THEN 2 WHEN 'replaced' THEN 3 ELSE 4 END,n.updated_at DESC
     LIMIT 300`,deviceValues):noRows();

  const keyValues:unknown[]=[tenant];
  const keyWhere=sections.keys?siteClause(user,'keys:read','k',keyValues):' AND FALSE';
  const keyRows=sections.keys?query<Row>(
    `SELECT k.id,k.key_code,k.label,k.status,k.site_id,k.holder_employee_id,k.due_at,k.lost_at,k.deactivated_at,
       CASE WHEN k.status='issued' AND k.due_at<now() THEN 'overdue' ELSE k.status END display_status,
       s.name site_name,e.name holder_name,
       (SELECT l.status FROM key_loss_reports l WHERE l.tenant_id=k.tenant_id AND l.key_id=k.id ORDER BY l.created_at DESC LIMIT 1) loss_report_status
     FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
     LEFT JOIN employees e ON e.tenant_id=k.tenant_id AND e.id=k.holder_employee_id
     WHERE k.tenant_id=$1${keyWhere}
     ORDER BY CASE WHEN k.status='issued' AND k.due_at<now() THEN 1 WHEN k.status='lost' THEN 2
       WHEN k.status='blocked' THEN 3 ELSE 4 END,k.due_at NULLS LAST,k.label LIMIT 300`,keyValues):noRows();

  const alarmValues:unknown[]=[tenant];
  const alarmWhere=scope(user,'alarms:read')!=null?siteClause(user,'alarms:read','a',alarmValues):' AND FALSE';
  const alarmRows=sections.alarms?query<Row>(
    `SELECT a.id,a.message,a.description,a.severity,a.status,a.triggered_at,a.site_id,a.employee_id,
       s.name site_name,e.name employee_name
     FROM alarms a LEFT JOIN sites s ON s.tenant_id=a.tenant_id AND s.id=a.site_id
     LEFT JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id
     WHERE a.tenant_id=$1 AND a.status IN ('open','acknowledged','escalated')${alarmWhere}
     ORDER BY CASE a.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,a.triggered_at DESC
     LIMIT 200`,alarmValues):noRows();

  const hazardValues:unknown[]=[tenant];
  const hazardWhere=sections.sites?siteClause(user,'sites:read','h',hazardValues):' AND FALSE';
  const hazardRows=sections.sites?query<Row>(
    `SELECT h.id,h.title,h.category,h.likelihood,h.impact,h.risk_score,h.status,h.due_on,h.site_id,s.name site_name
     FROM object_hazards h JOIN sites s ON s.tenant_id=h.tenant_id AND s.id=h.site_id
     WHERE h.tenant_id=$1 AND h.status<>'closed'${hazardWhere}
     ORDER BY h.risk_score DESC NULLS LAST,h.due_on NULLS LAST LIMIT 200`,hazardValues):noRows();

  const measureValues:unknown[]=[tenant];
  const measureWhere=sections.measures?siteClause(user,'operations_measures:read','m',measureValues):' AND FALSE';
  const measureRows=sections.measures?query<Row>(
    `SELECT m.*,s.name site_name,e.name assigned_employee_name,
       (SELECT count(*)::int FROM operations_measures c
          WHERE c.tenant_id=m.tenant_id AND c.incident_id=m.incident_id AND c.status NOT IN ('done','cancelled')) open_siblings
     FROM operations_measures m
     LEFT JOIN sites s ON s.tenant_id=m.tenant_id AND s.id=m.site_id
     LEFT JOIN employees e ON e.tenant_id=m.tenant_id AND e.id=m.assigned_employee_id
     WHERE m.tenant_id=$1${measureWhere}
     ORDER BY CASE m.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'on_hold' THEN 3 ELSE 4 END,
       m.due_at NULLS LAST,m.created_at DESC LIMIT 300`,measureValues):noRows();

  const [siteResult,shiftResult,employeeResult,qualificationResult,documentResult,requirementResult,
    deviceResult,keyResult,alarmResult,hazardResult,measureResult]=await Promise.all([
      siteRows,shiftRows,employeeRows,qualificationRows,documentRows,requirementRows,
      deviceRows,keyRows,alarmRows,hazardRows,measureRows,
    ]);

  const sites=siteResult.rows;
  const shifts=shiftResult.rows;
  const employees=employeeResult.rows;
  const qualificationIssues=qualificationResult.rows;
  const documents=documentResult.rows.map((row:Row)=>({...row,...classifyDocument(row,now)}));
  const requirements=requirementResult.rows.map((row:Row)=>{
    const classified=classifyRequirement({id:row.id,document_type:row.document_type,required:row.required},row.documents??[],now);
    return {...row,...classified};
  });
  const devices=deviceResult.rows;
  const keys=keyResult.rows;
  const alarms=alarmResult.rows;
  const hazards=hazardResult.rows;
  const measures=measureResult.rows;

  // Verbindliche Urteile für die sichtbaren Schichten über die zentrale Prüfung.
  const visibleShiftIds=shifts.map((shift:Row)=>String(shift.id));
  const verdicts=new Map<string,{status:string;reasons:string[];required_qualification_codes:string[]}>();
  if(visibleShiftIds.length){
    for(let offset=0;offset<visibleShiftIds.length;offset+=25){
      const chunk=visibleShiftIds.slice(offset,offset+25);
      const placeholders=chunk.map((_,index)=>`$${index+2}`).join(',');
      const assignments=(await query<Row>(
        `SELECT a.id assignment_id,a.shift_id,a.employee_id,p.site_id,sh.starts_at,sh.ends_at,
           sh.required_qualification_codes,r.parameters profile_parameters
         FROM schedule_assignments a
         JOIN schedule_shifts sh ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
         JOIN schedule_periods p ON p.tenant_id=sh.tenant_id AND p.id=sh.period_id
         JOIN schedule_rule_profiles r ON r.tenant_id=p.tenant_id AND r.id=p.rule_profile_id
         WHERE a.tenant_id=$1 AND a.status='assigned' AND a.shift_id IN (${placeholders})`,[tenant,...chunk],
      )).rows;
      await Promise.all(assignments.map(async(row:Row)=>{
        const verdict=await evaluateShiftAssignment(query,tenant,{
          site_id:row.site_id,starts_at:row.starts_at,ends_at:row.ends_at,
          required_qualification_codes:row.required_qualification_codes,
          profile_parameters:row.profile_parameters,
        },row.employee_id,{exclude_assignment_id:row.assignment_id});
        verdicts.set(row.assignment_id,{
          status:verdict.status,
          reasons:verdict.reasons.map(reason=>reason.code),
          required_qualification_codes:verdict.required_qualification_codes,
        });
      }));
    }
  }

  const shiftViews=shifts.map((shift:Row)=>{
    const assignments:Row[]=parseJsonArraySafe(shift.assignments);
    const conflicts:Row[]=parseJsonArraySafe(shift.conflicts);
    const assignmentVerdicts=assignments.map((assignment:Row)=>verdicts.get(String(assignment.id)))
      .filter((value:unknown):value is {status:string;reasons:string[];required_qualification_codes:string[]}=>Boolean(value));
    const hard=assignmentVerdicts.flatMap(value=>hardReasons({...value,reasons:value.reasons.map(code=>({code,message:reasonLabels[code]??code,link:null}))} as any));
    const restricted=assignmentVerdicts.some(value=>value.status==='restricted');
    const target=Math.max(1,Number(shift.required_staff_count??1));
    const actual=assignments.filter((assignment:Row)=>assignment.status==='assigned').length;
    const started=new Date(shift.starts_at).getTime()<=now.getTime();
    const finished=new Date(shift.ends_at).getTime()<now.getTime();
    const running=started&&!finished;
    const conflictCodes=[...new Set(hard.map(reason=>reason.code))];
    let status='geplant';
    if(conflictCodes.length||conflicts.some(item=>item.severity==='error'))status='konflikt';
    else if(!actual)status=started?'unbesetzt':'geplant';
    else if(actual<target)status='unterbesetzt';
    else if(running)status='laufend';
    else if(finished)status='abgeschlossen';
    else status='besetzt';
    const notes=[...conflicts.map(item=>String(item.type)),...conflictCodes.map(code=>reasonLabels[code]??code)];
    return {
      id:String(shift.id),site_id:String(shift.site_id),site_name:String(shift.site_name),
      customer_id:shift.customer_id?String(shift.customer_id):null,customer_name:shift.customer_name?String(shift.customer_name):'Kein Kunde hinterlegt',
      role_code:String(shift.role_code),starts_at:String(shift.starts_at),ends_at:String(shift.ends_at),
      target,actual,status,
      qualification_status:conflictCodes.length?'konflikt':restricted?'eingeschraenkt':actual?'geprueft':'offen',
      reason_codes:conflictCodes,notes:[...new Set(notes)],
      assignments,conflicts,
    };
  });

  const eligibleToday=new Set<string>();
  const scheduledToday=new Set<string>();
  const onDutyNow=new Set<string>();
  for(const shift of shiftViews){
    for(const assignment of shift.assignments){
      if(assignment.status!=='assigned')continue;
      scheduledToday.add(String(assignment.employee_id));
      if(new Date(shift.starts_at).getTime()<=now.getTime()&&new Date(shift.ends_at).getTime()>now.getTime())onDutyNow.add(String(assignment.employee_id));
    }
  }
  const absenceByEmployee=new Map<string,Row[]>();
  for(const employee of employees){
    const absences:Row[]=parseJsonArraySafe(employee.absences);
    absenceByEmployee.set(String(employee.id),absences);
    const active=employee.employment_status==='active'||employee.employment_status==='probation';
    const absent=absences.some(item=>item.status==='approved'&&new Date(item.starts_at).getTime()<=now.getTime()&&new Date(item.ends_at).getTime()>now.getTime());
    const states:string[]=Array.isArray(employee.qualification_states)?employee.qualification_states.map(String):[];
    const blocked=states.some(state=>hardQualificationStates.has(state));
    if(active&&!absent&&!blocked&&isAvailableNow(parseJsonArraySafe(employee.availability),now))eligibleToday.add(String(employee.id));
  }

  const employeeViews=employees.map((employee:Row)=>{
    const absences:Row[]=parseJsonArraySafe(employee.absences);
    const states:string[]=Array.isArray(employee.qualification_states)?employee.qualification_states.map(String):[];
    const absent=absences.some(item=>item.status==='approved'&&new Date(item.starts_at).getTime()<=now.getTime()&&new Date(item.ends_at).getTime()>now.getTime());
    const blocked=states.some(state=>hardQualificationStates.has(state));
    const scheduled=scheduledToday.has(String(employee.id));
    const status=absent?'abwesend':blocked?'nicht_qualifiziert':scheduled?'eingeplant':eligibleToday.has(String(employee.id))?'verfuegbar':'nicht_verfuegbar';
    return {
      id:String(employee.id),name:String(employee.name),position:employee.position??null,email:employee.email??null,
      site_name:employee.site_name||'–',status,absences,
      qualification_states:states.map(state=>qualificationCategoryLabels[state]??state),
      upcoming_assignments:Number(employee.upcoming_assignments??0),
      available_now:eligibleToday.has(String(employee.id)),
    };
  });

  const siteViews=sites.map((site:Row)=>{
    const target=Math.max(1,Number(site.required_staff_count??1));
    const actual=Number(site.assigned_today??0);
    const todayShifts=Number(site.today_shifts??0);
    const openShifts=Number(site.open_shifts??0);
    const siteQualificationIssues=qualificationIssues.filter((issue:Row)=>
      parseJsonArraySafe(issue.sites).some((entry:Row)=>String(entry.site_id)===String(site.id))&&hardQualificationStates.has(String(issue.computed_status))).length;
    const siteAlarms=alarms.filter((alarm:Row)=>String(alarm.site_id)===String(site.id)).length;
    return {
      id:String(site.id),name:String(site.name),site_number:site.site_number??null,
      customer_id:site.customer_id?String(site.customer_id):null,customer_name:site.customer_name??'Kein Kunde hinterlegt',
      status:String(site.status),target,actual,coverage:target?Math.round(actual/target*100):0,
      today_shifts:todayShifts,open_shifts:openShifts,
      qualification_issues:siteQualificationIssues,alarms:siteAlarms,
      last_activity_at:site.last_activity_at?String(site.last_activity_at):null,
      attention:openShifts>0||actual<target||siteQualificationIssues>0||siteAlarms>0,
    };
  });

  const qualificationViews=qualificationIssues.map((issue:Row)=>({
    employee_id:String(issue.employee_id),employee_name:String(issue.employee_name),
    qualification_id:String(issue.qualification_id),code:String(issue.code),
    status:String(issue.computed_status),status_label:qualificationCategoryLabels[String(issue.computed_status)]??String(issue.computed_status),
    valid_from:issue.valid_from?String(issue.valid_from):null,valid_until:issue.valid_until?String(issue.valid_until):null,
    sites:parseJsonArraySafe(issue.sites),
  }));

  const documentViews=documents.filter((document:Row)=>document.computed_status!=='gueltig').map((document:Row)=>({
    id:String(document.id),title:String(document.title),document_type:document.document_type??null,
    site_id:document.site_id?String(document.site_id):null,employee_id:document.employee_id?String(document.employee_id):null,
    computed_status:String(document.computed_status),status_label:String(document.status_label),
    days_until_expiry:document.days_until_expiry,review_state:String(document.review_state),
    versions:document.versions,
  }));
  const requirementViews=requirements.filter((requirement:Row)=>requirement.missing||!requirement.is_currently_valid)
    .map((requirement:Row)=>({
      id:String(requirement.id),site_id:String(requirement.site_id),site_name:String(requirement.site_name),
      document_type:String(requirement.document_type),status_label:String(requirement.status_label),
      matching_document_id:requirement.matching_document_id?String(requirement.matching_document_id):null,
      missing:Boolean(requirement.missing),
      is_currently_valid:Boolean(requirement.is_currently_valid),
    }));

  const deviceViews=devices.map((device:Row)=>({
    id:String(device.id),identifier:String(device.identifier),device_type:String(device.device_type),
    status:String(device.status),site_id:device.site_id?String(device.site_id):null,site_name:device.site_name??null,
    employee_name:device.employee_name??null,archived_at:device.archived_at?String(device.archived_at):null,
    recovered_at:device.recovered_at?String(device.recovered_at):null,updated_at:String(device.updated_at),
    assignable:String(device.status)==='active'&&!device.archived_at&&!device.employee_id&&!device.site_id&&!device.control_point_id,
    attention:['lost','blocked','replaced'].includes(String(device.status))||Boolean(device.archived_at),
  }));
  const keyViews=keys.map((key:Row)=>({
    id:String(key.id),key_code:String(key.key_code),label:String(key.label),status:String(key.status),
    display_status:String(key.display_status),site_id:key.site_id?String(key.site_id):null,site_name:key.site_name??null,
    holder_name:key.holder_name??null,due_at:key.due_at?String(key.due_at):null,
    loss_report_status:key.loss_report_status??null,
    attention:['overdue','lost','blocked','deactivated'].includes(String(key.display_status))
      ||['review','security_measure_required','replacement_required'].includes(String(key.loss_report_status??'')),
  }));

  const alerts:Row[]=[];
  const push=(input:{priority:string;code:string;title:string;description:string;recommendation:string;
    site_id?:string|null;site_name?:string|null;employee_id?:string|null;employee_name?:string|null;
    shift_id?:string|null;period?:string|null;detected_at?:string|null;link:string;source_key:string})=>{
    alerts.push({...input,priority:priority(input.priority),detected_at:detectedAt(input.detected_at),
      site_id:input.site_id??null,site_name:input.site_name??null,employee_id:input.employee_id??null,
      employee_name:input.employee_name??null,shift_id:input.shift_id??null,period:input.period??null});
  };
  for(const shift of shiftViews){
    if(shift.status==='konflikt'){
      push({priority:'critical',code:'assignment_conflict',title:'Einsatzkonflikt',description:`${shift.site_name}: ${shift.reason_codes.map(code=>reasonLabels[code]??code).join(', ')||'Konflikt im Einsatz'}`,
        recommendation:'Einsatzprüfung öffnen und Besetzung fachgerecht korrigieren.',site_id:shift.site_id,site_name:shift.site_name,
        shift_id:shift.id,period:`${shift.starts_at} – ${shift.ends_at}`,detected_at:shift.conflicts[0]?.detected_at,link:`/scheduling?shift=${shift.id}`,
        source_key:`shift:${shift.id}:conflict`});
    } else if(shift.status==='unbesetzt'){
      const imminent=new Date(shift.starts_at).getTime()-now.getTime()<2*3_600_000;
      push({priority:imminent?'critical':'high',code:'shift_unstaffed',title:'Schicht nicht besetzt',
        description:`${shift.site_name}: ${shift.role_code} ist ohne Besetzung.`,
        recommendation:'Geeigneten Mitarbeiter prüfen und Schicht in der Dienstplanung besetzen.',
        site_id:shift.site_id,site_name:shift.site_name,shift_id:shift.id,period:`${shift.starts_at} – ${shift.ends_at}`,
        detected_at:shift.starts_at,link:`/scheduling?shift=${shift.id}`,source_key:`shift:${shift.id}:unstaffed`});
    } else if(shift.status==='unterbesetzt'){
      push({priority:'high',code:'shift_understaffed',title:'Schicht unterbesetzt',
        description:`${shift.site_name}: ${shift.actual} von ${shift.target} Personen eingeplant.`,
        recommendation:'Besetzung prüfen und bei Bedarf Ersatz disponieren.',site_id:shift.site_id,site_name:shift.site_name,
        shift_id:shift.id,period:`${shift.starts_at} – ${shift.ends_at}`,detected_at:shift.starts_at,
        link:`/scheduling?shift=${shift.id}`,source_key:`shift:${shift.id}:understaffed`});
    }
  }
  for(const site of siteViews.filter(site=>site.actual<site.target)){
    push({priority:'high',code:'site_undercovered',title:'Objekt unterbesetzt',
      description:`${site.name}: ${site.actual} von ${site.target} Personen heute eingeplant.`,
      recommendation:'Soll-Ist-Abweichung prüfen und Maßnahme ergreifen.',site_id:site.id,site_name:site.name,
      period:filters.date,link:`/sites/${site.id}/dienstplanung`,source_key:`site:${site.id}:${filters.date}:undercovered`});
  }
  for(const qualification of qualificationViews){
    const critical=['revoked','expired','invalid','missing_evidence','awaiting_review'].includes(qualification.status);
    push({priority:critical?'high':'medium',code:`qualification_${qualification.status}`,
      title:`Qualifikation: ${qualification.status_label}`,
      description:`${qualification.employee_name} – ${qualification.code}${qualification.valid_until?` (gültig bis ${qualification.valid_until})`:''}`,
      recommendation:critical?'Einsatz sperren und Nachweis klären.':'Verlängerung oder Nachweis rechtzeitig einleiten.',
      employee_id:qualification.employee_id,employee_name:qualification.employee_name,
      site_id:qualification.sites[0]?.site_id??null,site_name:qualification.sites[0]?.site_name??null,
      detected_at:qualification.valid_until,link:`/employees/${qualification.employee_id}/qualifikationen`,
      source_key:`qualification:${qualification.qualification_id}:${qualification.status}`});
  }
  for(const document of documentViews){
    push({priority:document.computed_status==='nicht_freigegeben'?'high':'medium',code:`document_${document.computed_status}`,
      title:`Dokument: ${document.status_label}`,description:`${document.title} benötigt eine Prüfung oder Freigabe.`,
      recommendation:'Dokument im DMS prüfen; Freigabe ausschließlich über den DMS-Workflow erteilen.',
      site_id:document.site_id,employee_id:document.employee_id,detected_at:null,link:`/dms?document=${document.id}`,
      source_key:`document:${document.id}:${document.computed_status}`});
  }
  for(const requirement of requirementViews){
    push({priority:requirement.missing?'high':'medium',code:'required_document_missing',title:'Pflichtnachweis fehlt',
      description:`${requirement.site_name}: ${requirement.document_type} – ${requirement.status_label}.`,
      recommendation:'Pflichtnachweis im DMS bereitstellen und freigeben.',site_id:requirement.site_id,
      site_name:requirement.site_name,detected_at:null,link:`/dms`,source_key:`requirement:${requirement.site_id}:${requirement.document_type}`});
  }
  for(const alarm of alarms){
    push({priority:alarm.severity==='critical'?'critical':'high',code:'active_alarm',title:`Aktiver Alarm (${alarm.severity})`,
      description:alarm.description||alarm.message,recommendation:'Alarm annehmen und Ursache bearbeiten; Quittieren beseitigt die Ursache nicht.',
      site_id:alarm.site_id,site_name:alarm.site_name,employee_id:alarm.employee_id,employee_name:alarm.employee_name,
      detected_at:alarm.triggered_at,link:`/alarms?alarm=${alarm.id}`,source_key:`alarm:${alarm.id}`});
  }
  for(const hazard of hazards.filter(hazard=>Number(hazard.risk_score??0)>=8)){
    push({priority:'high',code:'object_hazard',title:'Objektgefährdung',description:`${hazard.site_name}: ${hazard.title} (Risiko ${hazard.risk_score}).`,
      recommendation:'Schutzmaßnahmen prüfen und Verantwortliche benennen.',site_id:hazard.site_id,site_name:hazard.site_name,
      detected_at:hazard.due_on,link:`/sites/${hazard.site_id}/gefaehrdungen`,source_key:`hazard:${hazard.id}`});
  }
  for(const device of deviceViews.filter(device=>device.attention)){
    push({priority:device.status==='lost'?'high':'medium',code:`nfc_${device.status}`,title:`NFC-Gerät: ${device.status}`,
      description:`${device.identifier}${device.site_name?` – ${device.site_name}`:''}`,
      recommendation:'Gerätestatus prüfen und ggf. sperren oder ersetzen.',site_id:device.site_id,site_name:device.site_name,
      detected_at:device.updated_at,link:`/nfc-devices/${device.id}`,source_key:`nfc:${device.id}:${device.status}`});
  }
  for(const key of keyViews.filter(key=>key.attention)){
    push({priority:key.display_status==='overdue'||key.status==='lost'?'high':'medium',code:`key_${key.display_status}`,
      title:`Schlüssel: ${key.display_status}`,description:`${key.label} (${key.key_code})${key.site_name?` – ${key.site_name}`:''}`,
      recommendation:'Rückgabe oder Sperrung veranlassen und Schlüsselbewegung prüfen.',site_id:key.site_id,site_name:key.site_name,
      detected_at:key.due_at,link:`/keys/${key.id}`,source_key:`key:${key.id}:${key.display_status}`});
  }
  for(const employee of employeeViews){
    const approved=employee.absences.find((absence:Row)=>absence.status==='approved');
    if(approved){
      push({priority:'medium',code:'absence',title:'Abwesenheit gemeldet',description:`${employee.name} ist abwesend.`,
        recommendation:'Betroffene Schichten prüfen und Ersatz planen.',employee_id:employee.id,employee_name:employee.name,
        detected_at:approved.starts_at,link:`/employees/${employee.id}/abwesenheiten`,source_key:`absence:${approved.id}`});
    }
  }
  for(const measure of measures.filter((measure:Row)=>measure.status!=='done'&&measure.status!=='cancelled'
      &&measure.due_at&&new Date(measure.due_at).getTime()<now.getTime())){
    push({priority:priority(String(measure.priority)),code:'measure_overdue',title:'Maßnahme überfällig',description:String(measure.title),
      recommendation:'Maßnahme bearbeiten oder mit Begründung zurückstellen.',site_id:measure.site_id?String(measure.site_id):null,
      employee_id:measure.assigned_employee_id?String(measure.assigned_employee_id):null,detected_at:String(measure.due_at),
      link:'/operative-leitstelle?bereich=massnahmen',source_key:`measure:${measure.id}:overdue`});
  }
  alerts.sort((left,right)=>(priorityRank[left.priority]??9)-(priorityRank[right.priority]??9)
    ||String(right.detected_at).localeCompare(String(left.detected_at)));

  const openShifts=shiftViews.filter(shift=>shift.actual===0).length;
  const understaffedSites=siteViews.filter(site=>site.actual<site.target).length;
  const missingDocuments=documentViews.filter(document=>document.computed_status!=='gueltig').length+requirementViews.length;
  const activeDisruptions=alerts.filter(alert=>['active_alarm','object_hazard','nfc_lost','nfc_blocked','key_lost','key_overdue','assignment_conflict'].includes(String(alert.code))).length;
  const measuresOpen=measures.filter((measure:Row)=>!['done','cancelled'].includes(String(measure.status))).length;
  const measuresOverdue=measures.filter((measure:Row)=>!['done','cancelled'].includes(String(measure.status))
    &&measure.due_at&&new Date(measure.due_at).getTime()<now.getTime()).length;

  const kpis=[
    {key:'employees_total',label:'Mitarbeiter insgesamt',value:employees.length,link:'/employees',definition:'Mitarbeiter des Mandanten einschließlich aktiver, Probezeit- und beurlaubter Beschäftigter.'},
    {key:'available_today',label:'Heute verfügbar',value:eligibleToday.size,link:'/operative-leitstelle?bereich=verfuegbarkeit',definition:'Beschäftigt, keine genehmigte Abwesenheit, Verfügbarkeit berücksichtigt, keine harten Qualifikationsprobleme; nicht gleichbedeutend mit „nicht eingeplant“.'},
    {key:'scheduled_today',label:'Heute eingeplant',value:scheduledToday.size,link:'/scheduling',definition:'Mitarbeiter mit mindestens einer Zuordnung in einer Schicht des gewählten Tages.'},
    {key:'on_duty_now',label:'Aktuell im Dienst',value:onDutyNow.size,link:'/operative-leitstelle?bereich=einsaetze',definition:'Mitarbeiter mit Zuordnungen in aktuell laufenden Schichten des gewählten Tages.'},
    {key:'open_shifts',label:'Offene Schichten',value:openShifts,link:'/scheduling',definition:'Schichten des Tages ohne aktive Zuordnung.'},
    {key:'understaffed_sites',label:'Unterbesetzte Objekte',value:understaffedSites,link:'/sites',definition:'Objekte mit weniger heutigen Zuordnungen als required_staff_count.'},
    {key:'qualification_gaps',label:'Mitarbeiter mit Qualifikationsproblemen',value:new Set(qualificationViews.filter(item=>hardQualificationStates.has(item.status)).map(item=>item.employee_id)).size,link:'/qualifications',definition:'Eindeutige Mitarbeiter mit mindestens einem harten Qualifikationszustand gemäß zentraler Statuslogik.'},
    {key:'expiring_qualifications',label:'Bald ablaufende Qualifikationen',value:qualificationViews.filter(item=>item.status==='expiring').length,link:'/qualifications',definition:'Qualifikationen mit Gültigkeitsende innerhalb von 90 Tagen gemäß zentraler Statuslogik.'},
    {key:'document_issues',label:'Fehlende oder nicht freigegebene Dokumente',value:missingDocuments,link:'/dms',definition:'Dokumente ohne gültigen Status plus fehlende oder nicht aktuelle Pflichtnachweise.'},
    {key:'active_disruptions',label:'Aktive operative Störungen',value:activeDisruptions,link:'/einsatz',definition:'Aktive Alarme, kritische Gefährdungen, Geräte-/Schlüsselstörungen und Einsatzkonflikte.'},
  ];

  return {
    generated_at:now.toISOString(),date:filters.date,sections,
    operational_status:alerts.some(alert=>alert.priority==='critical')?'kritisch'
      :alerts.some(alert=>alert.priority==='high')?'erhöht':'stabil',
    kpis,alerts,
    shifts:shiftViews.slice((page-1)*pageSize,page*pageSize),
    shifts_total:shiftViews.length,page,page_size:pageSize,
    employees:employeeViews,sites:siteViews,
    qualifications:qualificationViews,documents:documentViews,document_requirements:requirementViews,
    devices:deviceViews,keys:keyViews,alarms:alarms.map((alarm:Row)=>({...alarm,id:String(alarm.id)})),
    hazards:hazardResult.rows,
    measures:measures.map((measure:Row)=>({...measure,id:String(measure.id)})),
    summary:{open_shifts:openShifts,understaffed_sites:understaffedSites,
      missing_documents:missingDocuments,active_disruptions:activeDisruptions,
      measures_open:measuresOpen,measures_overdue:measuresOverdue,
      unacknowledged_alarms:alarms.filter((alarm:Row)=>alarm.status==='open').length},
    filter_options:{
      sites:sites.map((site:Row)=>({id:String(site.id),name:String(site.name)})),
      customers:[...new Map(sites.filter((site:Row)=>site.customer_id)
        .map((site:Row)=>[String(site.customer_id),{id:String(site.customer_id),name:String(site.customer_name)}])).values()],
      employees:employees.map((employee:Row)=>({id:String(employee.id),name:String(employee.name)})),
    },
  };
}

function parseJsonArraySafe(value:unknown):Row[]{
  if(Array.isArray(value))return value as Row[];
  if(typeof value==='string'){
    try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed as Row[]:[];}catch{return [];}
  }
  return [];
}

export async function findEligibleCandidates(user:ControlCenterUser,shiftId:string){
  if(!canUsePermission(user,'scheduling:read',[...allowedReadScopes]))throw Object.assign(new Error('Kein Zugriff auf Dienstplanung'),{status:403});
  const shift=(await query<Row>(
    `SELECT sh.id,sh.site_id,sh.starts_at,sh.ends_at,sh.required_qualification_codes,r.parameters profile_parameters
     FROM schedule_shifts sh JOIN schedule_periods p ON p.tenant_id=sh.tenant_id AND p.id=sh.period_id
     JOIN schedule_rule_profiles r ON r.tenant_id=p.tenant_id AND r.id=p.rule_profile_id
     WHERE sh.tenant_id=$1 AND sh.id=$2`,[user.tenantId,shiftId])).rows[0];
  if(!shift)throw Object.assign(new Error('Schicht nicht gefunden'),{status:404});
  if(scope(user,'scheduling:read')==='site'&&!user.siteIds.includes(String(shift.site_id)))throw Object.assign(new Error('Kein Zugriff auf Objekt'),{status:403});
  const candidates=(await query<Row>(
    `SELECT e.id,e.name FROM employees e
     WHERE e.tenant_id=$1 AND e.employment_status IN ('active','probation')
       AND EXISTS (SELECT 1 FROM employee_object_assignments oa WHERE oa.tenant_id=e.tenant_id
         AND oa.employee_id=e.id AND oa.site_id=$2
         AND oa.starts_on<=$3::date AND (oa.ends_on IS NULL OR oa.ends_on>=$4::date))
       AND NOT EXISTS (SELECT 1 FROM employee_absences ab WHERE ab.tenant_id=e.tenant_id AND ab.employee_id=e.id
         AND ab.status='approved' AND ab.starts_at<$5 AND $6<ab.ends_at)
       AND NOT EXISTS (SELECT 1 FROM schedule_assignments a JOIN schedule_shifts sh
         ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
         WHERE a.tenant_id=e.tenant_id AND a.employee_id=e.id AND a.status='assigned'
           AND sh.starts_at<$5 AND $6<sh.ends_at)
     ORDER BY e.name LIMIT 25`,
    [user.tenantId,shift.site_id,shift.starts_at,shift.ends_at,shift.ends_at,shift.starts_at],
  )).rows;
  const result=[];
  for(const candidate of candidates){
    const verdict=await evaluateShiftAssignment(query,user.tenantId,{
      site_id:shift.site_id,starts_at:shift.starts_at,ends_at:shift.ends_at,
      required_qualification_codes:shift.required_qualification_codes,profile_parameters:shift.profile_parameters,
    },String(candidate.id));
    if(verdict.status==='ineligible')continue;
    result.push({id:String(candidate.id),name:String(candidate.name),status:verdict.status,
      reasons:verdict.reasons.map(reason=>reason.message)});
  }
  return result.sort((left,right)=>(left.status==='eligible'?-1:1)-(right.status==='eligible'?-1:1)||left.name.localeCompare(right.name));
}

export async function sourceStillOpen(user:ControlCenterUser,sourceType:string|null,sourceId:string|null):Promise<boolean>{
  if(!sourceType||!sourceId)return false;
  const tenant=user.tenantId;
  const one=async(sql:string,values:unknown[])=>(await query<Row>(sql,[tenant,...values])).rows.length>0;
  switch(sourceType){
    case 'shift':return one(`SELECT 1 FROM schedule_shifts sh WHERE sh.tenant_id=$1 AND sh.id=$2
      AND NOT EXISTS (SELECT 1 FROM schedule_assignments a WHERE a.tenant_id=sh.tenant_id AND a.shift_id=sh.id AND a.status='assigned')`,[sourceId]);
    case 'site':return one(`SELECT 1 FROM sites s WHERE s.tenant_id=$1 AND s.id=$2
      AND COALESCE(s.required_staff_count,1)>(SELECT count(DISTINCT a.employee_id) FROM schedule_assignments a
        JOIN schedule_shifts sh ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
        WHERE sh.tenant_id=s.tenant_id AND sh.site_id=s.id AND a.status='assigned'
          AND sh.starts_at<=now() AND sh.ends_at>=now())`,[sourceId]);
    case 'qualification':{
      // Dieselbe SQL-Statusdomäne wie in allen Qualifikationsansichten.
      const row=(await query<Row>(
        `SELECT ${qualificationStatusSql()} computed_status FROM employee_qualifications q
         LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND (
           (q.catalog_id IS NOT NULL AND c.id=q.catalog_id) OR (q.catalog_id IS NULL AND c.code=q.code))
         LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
         LEFT JOIN LATERAL (SELECT v.lifecycle_state FROM dms_versions v
           WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available'
           ORDER BY v.version_no DESC LIMIT 1) dv ON TRUE
         WHERE q.tenant_id=$1 AND q.id=$2`,[tenant,sourceId])).rows[0];
      return row?hardQualificationStates.has(String(row.computed_status)):false;
    }
    case 'document':{
      // Freigabe, Fassung und Prüffrist werden ausschließlich vom DMS-Statusdienst bewertet.
      const row=(await query<Row>(
        `SELECT d.*,COALESCE(json_agg(json_build_object('lifecycle_state',v.lifecycle_state))
           FILTER (WHERE v.id IS NOT NULL),'[]'::json) versions
         FROM dms_documents d LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
         WHERE d.tenant_id=$1 AND d.id=$2 GROUP BY d.id`,[tenant,sourceId])).rows[0];
      return row?!classifyDocument(row).is_currently_valid:false;
    }
    case 'nfc_device':return one(`SELECT 1 FROM nfc_devices n WHERE n.tenant_id=$1 AND n.id=$2
       AND (n.status IN ('lost','blocked','replaced') OR n.archived_at IS NOT NULL
         OR n.event_reason ILIKE '%defekt%' OR n.notes ILIKE '%defekt%')`,[sourceId]);
    case 'key':{
      const row=(await query<Row>('SELECT status,due_at FROM keys WHERE tenant_id=$1 AND id=$2',[tenant,sourceId])).rows[0];
      return row?['lost','blocked','deactivated','overdue'].includes(derivedKeyStatus(String(row.status) as KeyStatus,row.due_at as string|null)):false;
    }
    case 'alarm':return one(`SELECT 1 FROM alarms a WHERE a.tenant_id=$1 AND a.id=$2 AND a.status<>'resolved'`,[sourceId]);
    case 'conflict':return one(`SELECT 1 FROM schedule_conflicts c WHERE c.tenant_id=$1 AND c.id=$2 AND c.resolved_at IS NULL`,[sourceId]);
    default:return false;
  }
}

export function isHardReasonCode(code:string){return isHardReason(code);}
