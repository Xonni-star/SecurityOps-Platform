/** Pure, server-side eligibility rules for a concrete shift. No UI state is trusted. */

export type EligibilityStatus = 'eligible' | 'restricted' | 'ineligible';
export type EligibilityLink = {type:'employee'|'qualification'|'instruction'|'absence';id:string;label:string};
export type EligibilityReason = {code:string;message:string;link:EligibilityLink|null};

export type QualificationRecord = {
  id:string;code:string;status:string;valid_from:string|null;valid_until:string|null;
  revoked_at:string|Date|null;document_id?:string|null;catalog_active?:boolean|null;
};
export type InstructionRecord = {
  id:string;title:string;status:string;requires_acknowledgement:boolean;
  version:number;valid_from:string|null;valid_until:string|null;
  acknowledged_version:number|null;
};
export type AbsenceRecord = {id:string;starts_at:string;ends_at:string;status:string};
export type AvailabilityRecord = {
  weekday:number;starts_time:string;ends_time:string;available:boolean;
  valid_from:string|null;valid_until:string|null;
};
export type EligibilityInput = {
  employee:{id:string;name:string;employment_status:string|null;
    assignment:{starts_on:string;ends_on:string|null}|null};
  shift:{starts_at:string;ends_at:string;required_qualification_codes:string[]};
  qualifications:QualificationRecord[];
  instructions:InstructionRecord[];
  absences:AbsenceRecord[];
  availability:AvailabilityRecord[];
  overlapping_shift:boolean;
};

function day(value:string|Date):number{
  const date=value instanceof Date?value:new Date(value.length<=10?`${value}T00:00:00Z`:value);
  return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());
}
function beforeOrEqual(a:string|Date,b:string|Date){return day(a)<=day(b);}
function overlaps(aStart:string,aEnd:string,bStart:string,bEnd:string){
  return new Date(aStart).getTime()<new Date(bEnd).getTime()&&new Date(bStart).getTime()<new Date(aEnd).getTime();
}
function timeMinutes(value:string){
  const [hours='0',minutes='0']=value.split(':');
  return Number(hours)*60+Number(minutes);
}

function qualificationReason(input:EligibilityInput,code:string):EligibilityReason|null{
  const {starts_at,ends_at}=input.shift;
  const candidates=input.qualifications.filter(item=>item.code===code);
  const usable=candidates.find(item=>{
    if(item.status!=='valid'||item.revoked_at||item.catalog_active===false)return false;
    if(item.valid_from&&!beforeOrEqual(item.valid_from,starts_at))return false;
    if(item.valid_until&&!beforeOrEqual(ends_at,item.valid_until))return false;
    return true;
  });
  if(usable)return null;
  const latest=candidates.sort((a,b)=>String(b.valid_until??'').localeCompare(String(a.valid_until??'')))[0];
  if(latest?.revoked_at||latest?.status==='revoked')return {
    code:'qualification_revoked',message:`Qualifikationsnachweis ${code} ist widerrufen`,
    link:latest.document_id?{type:'qualification',id:latest.document_id,label:`Nachweis ${code}`}:{type:'qualification',id:latest.id,label:`Qualifikation ${code}`},
  };
  if(latest?.status==='expired'||(latest?.valid_until&&day(latest.valid_until)<day(ends_at)))return {
    code:'qualification_expired',message:`Qualifikationsnachweis ${code} ist zum Einsatzzeitpunkt abgelaufen`,
    link:latest.document_id?{type:'qualification',id:latest.document_id,label:`Nachweis ${code}`}:{type:'qualification',id:latest.id,label:`Qualifikation ${code}`},
  };
  if(latest?.status==='invalid'||latest?.catalog_active===false)return {
    code:'qualification_invalid',message:`Qualifikationsnachweis ${code} ist ungültig`,
    link:{type:'qualification',id:latest.id,label:`Qualifikation ${code}`},
  };
  return {code:'qualification_missing',message:`Erforderliche Qualifikation ${code} fehlt`,link:null};
}

export function evaluateShiftEligibility(input:EligibilityInput):{
  status:EligibilityStatus;reasons:EligibilityReason[];matched_qualification_codes:string[];missing_qualification_codes:string[];
}{
  const reasons:EligibilityReason[]=[];
  const {employee,shift}=input;
  if(['terminated','archived'].includes(employee.employment_status??''))reasons.push({
    code:'employment_status',message:`Mitarbeiter ist nicht mehr beschäftigt (${employee.employment_status})`,link:{type:'employee',id:employee.id,label:employee.name},
  });
  else if(employee.employment_status==='leave')reasons.push({
    code:'employment_status',message:'Mitarbeiter befindet sich in Beurlaubung',link:{type:'employee',id:employee.id,label:employee.name},
  });
  else if(employee.employment_status==='probation'||employee.employment_status===null)reasons.push({
    code:'employment_status_restricted',message:'Beschäftigungsstatus erfordert Prüfung',link:{type:'employee',id:employee.id,label:employee.name},
  });
  if(!employee.assignment||!beforeOrEqual(employee.assignment.starts_on,shift.starts_at)
    ||(employee.assignment.ends_on&&day(employee.assignment.ends_on)<day(shift.ends_at)))reasons.push({
    code:'site_assignment',message:'Keine Objektzuordnung für den gesamten Schichtzeitraum',link:{type:'employee',id:employee.id,label:employee.name},
  });
  const matched:string[]=[];const missing:string[]=[];
  for(const code of shift.required_qualification_codes){
    const reason=qualificationReason(input,code);
    if(reason){reasons.push(reason);missing.push(code);}else matched.push(code);
  }
  for(const instruction of input.instructions){
    if(instruction.status!=='approved'||!instruction.requires_acknowledgement)continue;
    if(instruction.valid_from&&!beforeOrEqual(instruction.valid_from,shift.starts_at))continue;
    if(instruction.valid_until&&!beforeOrEqual(shift.ends_at,instruction.valid_until))continue;
    if(instruction.acknowledged_version!==instruction.version)reasons.push({
      code:'instruction_acknowledgement',message:`Unterweisung „${instruction.title}“ nicht in aktueller Version bestätigt`,
      link:{type:'instruction',id:instruction.id,label:instruction.title},
    });
  }
  for(const absence of input.absences){
    if(!['requested','approved'].includes(absence.status))continue;
    if(!overlaps(absence.starts_at,absence.ends_at,shift.starts_at,shift.ends_at))continue;
    reasons.push({
      code:absence.status==='approved'?'absence_approved':'absence_requested',
      message:absence.status==='approved'?'Mitarbeiter ist für die Schicht abwesend':'Abwesenheit beantragt – Freigabe prüfen',
      link:{type:'absence',id:absence.id,label:'Abwesenheit'},
    });
  }
  const shiftDay=new Date(shift.starts_at).getUTCDay();
  const shiftStart=timeMinutes(shift.starts_at.slice(11,19));
  const shiftEnd=timeMinutes(shift.ends_at.slice(11,19));
  if(input.availability.some(item=>!item.available&&item.weekday===shiftDay
    &&(!item.valid_from||beforeOrEqual(item.valid_from,shift.starts_at))
    &&(!item.valid_until||beforeOrEqual(shift.ends_at,item.valid_until))
    &&timeMinutes(item.starts_time)<shiftEnd&&shiftStart<timeMinutes(item.ends_time)))reasons.push({
    code:'availability',message:'Verfügbarkeit schließt den Schichtzeitraum aus',link:null,
  });
  if(input.overlapping_shift)reasons.push({code:'overlapping_shift',message:'Überschneidung mit einer anderen zugewiesenen Schicht',link:null});
  const hard=reasons.some(reason=>!reason.code.endsWith('_restricted')&&reason.code!=='absence_requested');
  return {
    status:hard?'ineligible':reasons.length?'restricted':'eligible',
    reasons,matched_qualification_codes:matched,missing_qualification_codes:missing,
  };
}
