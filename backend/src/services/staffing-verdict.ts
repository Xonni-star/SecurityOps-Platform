/**
 * Gemeinsame Lade- und Prüflogik für die verbindliche Einsatzprüfung.
 * Leseweg (Einsatzfähigkeit) und Schreibweg (Schichtzuweisung) müssen
 * exakt dieselben Regeln und Reasons verwenden.
 */
import type {PoolClient} from 'pg';
import {recordAudit} from './audit.js';
import {qualificationLocalDate} from './qualification-status.js';
import {
  evaluateShiftEligibility,
  type AbsenceRecord,
  type AvailabilityRecord,
  type EligibilityInput,
  type InstructionRecord,
  type QualificationRecord,
} from './staffing-eligibility.js';

export type QueryFn=(text:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>;
type Row=Record<string,unknown>;
export type ShiftForVerdict={
  site_id:string;
  starts_at:string|Date;
  ends_at:string|Date;
  required_qualification_codes:string[]|string|null;
  profile_parameters?:Record<string,unknown>|string|null;
};
export type Verdict=ReturnType<typeof evaluateShiftEligibility>&{required_qualification_codes:string[]};

/** Harte Sperren entsprechen exakt der Einstufung in staffing-eligibility. */
export function isHardReason(code:string):boolean{
  return !code.endsWith('_restricted')&&code!=='absence_requested';
}
export function hardReasons(verdict:Verdict):Verdict['reasons']{
  return verdict.reasons.filter(reason=>isHardReason(reason.code));
}

const iso=(value:string|Date)=>value instanceof Date?value.toISOString():String(value);
const text=(value:unknown)=>value===null||value===undefined?null:String(value);
const parseCodes=(value:unknown):string[]=>Array.isArray(value)?value.map(String)
  :typeof value==='string'?JSON.parse(value) as string[]:[];
const parseParameters=(value:unknown):Record<string,unknown>=>
  typeof value==='string'?JSON.parse(value) as Record<string,unknown>
    :value&&typeof value==='object'?value as Record<string,unknown>:{};

/**
 * Ermittelt das Urteil für einen Mitarbeiter und eine konkrete Schicht.
 * Alle Abfragen sind mandantenbezogen; die Objektzuordnung wird gegen den
 * Schichtzeitraum geprüft, nicht gegen „heute“.
 */
export async function evaluateShiftAssignment(
  db:QueryFn,
  tenantId:string,
  shift:ShiftForVerdict,
  employeeId:string,
  options:{exclude_assignment_id?:string}={},
):Promise<Verdict>{
  const startsAt=iso(shift.starts_at);
  const endsAt=iso(shift.ends_at);
  const startDay=qualificationLocalDate(new Date(startsAt));
  const endDay=qualificationLocalDate(new Date(endsAt));
  const employee=(await db(
    `SELECT id,name,employment_status,hire_date,termination_date
       FROM employees WHERE tenant_id=$1 AND id=$2`,
    [tenantId,employeeId],
  )).rows[0] as Row|undefined;
  if(!employee)throw Object.assign(new Error('Mitarbeiter nicht gefunden'),{status:404});

  const assignment=(await db(
    `SELECT starts_on,ends_on FROM employee_object_assignments
      WHERE tenant_id=$1 AND employee_id=$2 AND site_id=$3
        AND starts_on<=$4::date AND (ends_on IS NULL OR ends_on>=$5::date)
      ORDER BY starts_on DESC LIMIT 1`,
    [tenantId,employeeId,shift.site_id,startDay,endDay],
  )).rows[0] as Row|undefined;

  const qualificationRows=(await db(
    `SELECT q.id,q.code,q.status,q.valid_from,q.valid_until,q.revoked_at,q.document_id,
        c.active AS catalog_active,c.required_document_type,c.required_documents,
        d.document_status,d.approval_status AS document_approval_status,
        d.valid_from AS document_valid_from,d.valid_until AS document_valid_until,
        dv.lifecycle_state AS document_lifecycle_state
       FROM employee_qualifications q
       LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id
         AND (c.id=q.catalog_id OR (q.catalog_id IS NULL AND c.code=q.code))
       LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
       LEFT JOIN LATERAL (
         SELECT v.lifecycle_state FROM dms_versions v
          WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available'
          ORDER BY v.version_no DESC LIMIT 1
       ) dv ON TRUE
      WHERE q.tenant_id=$1 AND q.employee_id=$2`,
    [tenantId,employeeId],
  )).rows as (QualificationRecord & Row)[];

  const requirementRows=(await db(
    `SELECT c.code FROM site_qualification_requirements r
       JOIN qualification_catalog c ON c.tenant_id=r.tenant_id AND c.id=r.catalog_id
      WHERE r.tenant_id=$1 AND r.site_id=$2 AND r.active=true AND r.required=true`,
    [tenantId,shift.site_id],
  )).rows as {code:string}[];

  const instructionRows=(await db(
    `SELECT DISTINCT ON (i.title) i.id,i.title,i.status,i.version,i.requires_acknowledgement,i.valid_from,i.valid_until
       FROM site_instructions i
      WHERE i.tenant_id=$1 AND i.site_id=$2 AND i.status='approved'
      ORDER BY i.title,i.version DESC`,
    [tenantId,shift.site_id],
  )).rows as (InstructionRecord & Row)[];

  const acknowledgements=(await db(
    `SELECT instruction_id,acknowledged_version FROM instruction_acknowledgements
      WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId,employeeId],
  )).rows;
  const acknowledged=new Map(acknowledgements.map(row=>[String(row.instruction_id),row.acknowledged_version as number]));

  const absenceRows=(await db(
    `SELECT id,starts_at,ends_at,status FROM employee_absences
      WHERE tenant_id=$1 AND employee_id=$2
        AND status IN ('requested','approved') AND starts_at<$3 AND $4<ends_at`,
    [tenantId,employeeId,startsAt,endsAt],
  )).rows as AbsenceRecord[];

  const availabilityRows=(await db(
    `SELECT weekday,starts_time,ends_time,available,valid_from,valid_until
       FROM employee_availability WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId,employeeId],
  )).rows as AvailabilityRecord[];

  // Bei der Reevaluierung ist die geprüfte Zuordnung selbst bereits gespeichert
  // und darf nicht als Überschneidung mit sich selbst gewertet werden.
  const overlapping=(await db(
    `SELECT a.id FROM schedule_assignments a
       JOIN schedule_shifts sh ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
      WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.status='assigned'
        AND sh.starts_at<$3 AND $4<sh.ends_at
        AND ($5::uuid IS NULL OR a.id<>$5::uuid) LIMIT 1`,
    [tenantId,employeeId,endsAt,startsAt,options.exclude_assignment_id??null],
  )).rows[0];

  const shiftCodes=parseCodes(shift.required_qualification_codes);
  const profileCodes=parseCodes(parseParameters(shift.profile_parameters).required_qualification_codes);
  const requiredCodes=[...new Set([...shiftCodes,...profileCodes,...requirementRows.map(row=>row.code)])];

  const input:EligibilityInput={
    employee:{
      id:String(employee.id),name:String(employee.name),employment_status:text(employee.employment_status),
      hire_date:text(employee.hire_date),termination_date:text(employee.termination_date),
      assignment:assignment?{starts_on:String(assignment.starts_on),ends_on:text(assignment.ends_on)}:null,
    },
    shift:{starts_at:startsAt,ends_at:endsAt,required_qualification_codes:requiredCodes},
    qualifications:qualificationRows.map(row=>({...row,required_documents:parseCodes(row.required_documents)})),
    instructions:instructionRows.map(row=>({
      id:String(row.id),title:String(row.title),status:String(row.status),
      requires_acknowledgement:Boolean(row.requires_acknowledgement),version:Number(row.version),
      valid_from:text(row.valid_from),valid_until:text(row.valid_until),
      acknowledged_version:acknowledged.get(String(row.id))??null,
    })),
    absences:absenceRows,
    availability:availabilityRows,
    overlapping_shift:Boolean(overlapping),
  };
  return {...evaluateShiftEligibility(input),required_qualification_codes:requiredCodes};
}

/**
 * Reevaluiert bereits geplante, künftige Einsätze nach einer fachlichen Änderung
 * (Qualifikation, Beschäftigungsstatus, Objektanforderung). Es werden weder
 * Zuordnungen gelöscht noch deren Status geändert: ein hartes Urteil wird als
 * Konflikt mit Audit vermerkt, ein zwischenzeitlich wieder gültiges Urteil
 * löst nur die von dieser Prüfung stammenden Konflikte auf.
 * Muss im selben Transaction-Kontext wie die auslösende Änderung laufen.
 */
export const PLANNED_REEVALUATION_CONFLICT_TYPE='ineligible_assignment';
const PLANNED_REEVALUATION_SOURCE='planned_assignment_reevaluation';
export type PlannedReevaluationScope={employee_ids?:string[];site_ids?:string[]};
export type PlannedReevaluationSummary={
  checked:number;conflicts_created:number;conflicts_updated:number;conflicts_resolved:number;
};

function conflictReasonCodes(details:unknown):string[]{
  const parsed=typeof details==='string'?JSON.parse(details) as unknown:details;
  const codes=parsed&&typeof parsed==='object'?(parsed as {reason_codes?:unknown}).reason_codes:undefined;
  return Array.isArray(codes)?codes.map(String):[];
}

export async function reevaluatePlannedAssignments(
  client:PoolClient,
  tenantId:string,
  actorUserId:string|null,
  trigger:string,
  scope:PlannedReevaluationScope,
):Promise<PlannedReevaluationSummary>{
  const summary:PlannedReevaluationSummary={checked:0,conflicts_created:0,conflicts_updated:0,conflicts_resolved:0};
  const employeeIds=[...new Set((scope.employee_ids??[]).filter(Boolean).map(String))];
  const siteIds=[...new Set((scope.site_ids??[]).filter(Boolean).map(String))];
  if(!employeeIds.length&&!siteIds.length)return summary;
  const db:QueryFn=(text,values)=>client.query(text,values);
  const planned=(await db(
    `SELECT a.id assignment_id,a.employee_id,p.id period_id,sh.id shift_id,sh.site_id,sh.starts_at,sh.ends_at,
            sh.required_qualification_codes,r.parameters profile_parameters
       FROM schedule_assignments a
       JOIN schedule_shifts sh ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
       JOIN schedule_periods p ON p.tenant_id=sh.tenant_id AND p.id=sh.period_id
       LEFT JOIN schedule_rule_profiles r ON r.tenant_id=p.tenant_id AND r.id=p.rule_profile_id
      WHERE a.tenant_id=$1 AND a.status='assigned' AND sh.starts_at>=now()
        AND ($2::uuid[] IS NULL OR a.employee_id=ANY($2::uuid[]))
        AND ($3::uuid[] IS NULL OR sh.site_id=ANY($3::uuid[]))`,
    [tenantId,employeeIds.length?employeeIds:null,siteIds.length?siteIds:null],
  )).rows;
  for(const row of planned){
    const assignmentId=String(row.assignment_id);
    const employeeId=String(row.employee_id);
    let verdict:Verdict;
    try{
      verdict=await evaluateShiftAssignment(db,tenantId,{
        site_id:String(row.site_id),starts_at:row.starts_at as string|Date,ends_at:row.ends_at as string|Date,
        required_qualification_codes:row.required_qualification_codes as string[]|string|null,
        profile_parameters:row.profile_parameters as Record<string,unknown>|string|null|undefined,
      },employeeId,{exclude_assignment_id:assignmentId});
    }catch(error){
      // Ein zwischenzeitlich entfernter Mitarbeiter darf die auslösende Änderung nicht scheitern lassen.
      if((error as {status?:number}).status===404)continue;
      throw error;
    }
    summary.checked++;
    const codes=[...new Set(hardReasons(verdict).map(reason=>reason.code))].sort();
    const existing=(await db(
      `SELECT id,details FROM schedule_conflicts
        WHERE tenant_id=$1 AND assignment_id=$2 AND resolved_at IS NULL
          AND conflict_type=$3 AND details->>'source'=$4`,
      [tenantId,assignmentId,PLANNED_REEVALUATION_CONFLICT_TYPE,PLANNED_REEVALUATION_SOURCE],
    )).rows;
    const details={source:PLANNED_REEVALUATION_SOURCE,trigger,reason_codes:codes};
    const audit=(action:string)=>recordAudit(tenantId,actorUserId,'scheduling.planned_assignment_reevaluated',
      'schedule_assignment',assignmentId,{action,trigger,status:verdict.status,reason_codes:codes},client);
    if(codes.length&&verdict.status==='ineligible'){
      if(!existing.length){
        await db(`INSERT INTO schedule_conflicts(tenant_id,period_id,shift_id,assignment_id,conflict_type,severity,details)
          VALUES($1,$2,$3,$4,$5,'error',$6)`,
        [tenantId,String(row.period_id),String(row.shift_id),assignmentId,PLANNED_REEVALUATION_CONFLICT_TYPE,details]);
        summary.conflicts_created++;
        await audit('conflict_created');
      }else if(existing.some(conflict=>JSON.stringify(conflictReasonCodes(conflict.details))!==JSON.stringify(codes))){
        for(const conflict of existing)await db('UPDATE schedule_conflicts SET details=$2,detected_at=now() WHERE tenant_id=$1 AND id=$3',
          [tenantId,details,String(conflict.id)]);
        summary.conflicts_updated++;
        await audit('conflict_updated');
      }
    }else if(existing.length){
      for(const conflict of existing)await db('UPDATE schedule_conflicts SET resolved_at=now() WHERE tenant_id=$1 AND id=$2 AND resolved_at IS NULL',
        [tenantId,String(conflict.id)]);
      summary.conflicts_resolved++;
      await audit('conflict_resolved');
    }
  }
  return summary;
}
