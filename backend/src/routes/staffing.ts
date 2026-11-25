import {Router,type RequestHandler} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requirePermission} from '../middleware/auth.js';
import {evaluateShiftEligibility,type AbsenceRecord,type AvailabilityRecord,type EligibilityInput,type InstructionRecord,type QualificationRecord} from '../services/staffing-eligibility.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();

function canRead(req:Parameters<RequestHandler>[0],permission:string,siteId:string){
  const user=req.user!;
  const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
  const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  return scope!==null&&canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},scope,{tenantId:user.tenantId,siteId});
}

export const staffingRouter=Router();

/** Authoritative per-shift verdict; schedule conflicts remain advisory findings by design. */
staffingRouter.get('/sites/:id/shifts/:shiftId/eligibility',requireAuth,requirePermission('scheduling:read',{allowedScopes:['tenant','site','own','system']}),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id));
    const shiftId=uuid.parse(String(req.params.shiftId));
    if(!canRead(req,'scheduling:read',siteId)||!canRead(req,'employees:read',siteId)||!canRead(req,'qualifications:read',siteId)){
      return res.status(403).json({error:'Insufficient permissions for this site'});
    }
    const tenantId=req.user!.tenantId;
    const shift=(await query<{
      id:string;site_id:string;starts_at:string;ends_at:string;
      required_qualification_codes:string[]|string|null;profile_parameters:Record<string,unknown>|string|null;
    }>(
      `SELECT sh.id,p.site_id,sh.starts_at,sh.ends_at,sh.required_qualification_codes,r.parameters AS profile_parameters
       FROM schedule_shifts sh
       JOIN schedule_periods p ON p.tenant_id=sh.tenant_id AND p.id=sh.period_id
       JOIN schedule_rule_profiles r ON r.tenant_id=p.tenant_id AND r.id=p.rule_profile_id
       WHERE sh.tenant_id=$1 AND sh.id=$2 AND p.site_id=$3`,
      [tenantId,shiftId,siteId],
    )).rows[0];
    if(!shift)return res.status(404).json({error:'Shift not found at this object'});
    const employees=(await query<{
      id:string;name:string;employment_status:string|null;starts_on:string;ends_on:string|null;
    }>(
      `SELECT DISTINCT ON (e.id) e.id,e.name,e.employment_status,oa.starts_on,oa.ends_on
       FROM employee_object_assignments oa
       JOIN employees e ON e.tenant_id=oa.tenant_id AND e.id=oa.employee_id
       WHERE oa.tenant_id=$1 AND oa.site_id=$2 AND oa.starts_on<=$3::date
         AND (oa.ends_on IS NULL OR oa.ends_on>=$4::date)
       ORDER BY e.id,oa.starts_on DESC`,
      [tenantId,siteId,shift.starts_at.slice(0,10),shift.ends_at.slice(0,10)],
    )).rows;
    const employeeIds=employees.map(employee=>employee.id);
    const qualificationRows=employeeIds.length?(await query<QualificationRecord & {employee_id:string}>(
      `SELECT q.id,q.employee_id,q.code,q.status,q.valid_from,q.valid_until,q.revoked_at,q.document_id,c.active AS catalog_active
       FROM employee_qualifications q
       LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.code=q.code
       WHERE q.tenant_id=$1 AND q.employee_id=ANY($2::uuid[])`,
      [tenantId,employeeIds],
    )).rows:[];
    const instructionRows=(await query<InstructionRecord>(
      `SELECT DISTINCT ON (i.title) i.id,i.title,i.status,i.version,i.requires_acknowledgement,i.valid_from,i.valid_until
       FROM site_instructions i
       WHERE i.tenant_id=$1 AND i.site_id=$2 AND i.status='approved'
       ORDER BY i.title,i.version DESC`,
      [tenantId,siteId],
    )).rows;
    const acknowledgementRows=employeeIds.length?(await query<{instruction_id:string;employee_id:string;acknowledged_version:number}>(
      `SELECT instruction_id,employee_id,acknowledged_version FROM instruction_acknowledgements
       WHERE tenant_id=$1 AND employee_id=ANY($2::uuid[])`,
      [tenantId,employeeIds],
    )).rows:[];
    const acknowledged=new Map(acknowledgementRows.map(row=>[`${row.instruction_id}:${row.employee_id}`,row.acknowledged_version]));
    const absenceRows=employeeIds.length?(await query<AbsenceRecord & {employee_id:string}>(
      `SELECT id,employee_id,starts_at,ends_at,status FROM employee_absences
       WHERE tenant_id=$1 AND employee_id=ANY($2::uuid[])
         AND status IN ('requested','approved') AND starts_at<$4 AND $3<ends_at`,
      [tenantId,employeeIds,shift.starts_at,shift.ends_at],
    )).rows:[];
    const availabilityRows=employeeIds.length?(await query<AvailabilityRecord & {employee_id:string}>(
      `SELECT employee_id,weekday,starts_time,ends_time,available,valid_from,valid_until
       FROM employee_availability WHERE tenant_id=$1 AND employee_id=ANY($2::uuid[])`,
      [tenantId,employeeIds],
    )).rows:[];
    const overlappingRows=employeeIds.length?(await query<{employee_id:string}>(
      `SELECT a.employee_id FROM schedule_assignments a
       JOIN schedule_shifts sh ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
       WHERE a.tenant_id=$1 AND a.employee_id=ANY($2::uuid[]) AND a.status='assigned' AND sh.id<>$3
         AND sh.starts_at<$5 AND $4<sh.ends_at`,
      [tenantId,employeeIds,shiftId,shift.starts_at,shift.ends_at],
    )).rows:[];
    const shiftCodes=Array.isArray(shift.required_qualification_codes)?shift.required_qualification_codes
      :typeof shift.required_qualification_codes==='string'?JSON.parse(shift.required_qualification_codes):[];
    const parameters=typeof shift.profile_parameters==='string'?JSON.parse(shift.profile_parameters):shift.profile_parameters??{};
    const profileCodes=Array.isArray(parameters.required_qualification_codes)?parameters.required_qualification_codes:[];
    const requiredCodes=[...new Set([...shiftCodes,...profileCodes])];
    const overlappingIds=new Set(overlappingRows.map(row=>row.employee_id));
    const verdicts=employees.map(employee=>{
      const input:EligibilityInput={
        employee:{id:employee.id,name:employee.name,employment_status:employee.employment_status,
          assignment:{starts_on:employee.starts_on,ends_on:employee.ends_on}},
        shift:{starts_at:shift.starts_at,ends_at:shift.ends_at,required_qualification_codes:requiredCodes},
        qualifications:qualificationRows.filter(row=>row.employee_id===employee.id),
        instructions:instructionRows.map(row=>({
          id:row.id,title:row.title,status:row.status,requires_acknowledgement:row.requires_acknowledgement,
          version:row.version,valid_from:row.valid_from,valid_until:row.valid_until,
          acknowledged_version:acknowledged.get(`${row.id}:${employee.id}`)??null,
        })),
        absences:absenceRows.filter(row=>row.employee_id===employee.id),
        availability:availabilityRows.filter(row=>row.employee_id===employee.id),
        overlapping_shift:overlappingIds.has(employee.id),
      };
      return {employee_id:employee.id,employee_name:employee.name,...evaluateShiftEligibility(input)};
    });
    res.json({shift_id:shift.id,site_id:siteId,required_qualification_codes:requiredCodes,employees:verdicts});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid shift or site id'});next(error);}
});
