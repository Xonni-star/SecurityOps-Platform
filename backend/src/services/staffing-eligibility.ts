/** Pure, server-side eligibility rules for a concrete shift. No UI state is trusted. */

export type EligibilityStatus = 'eligible' | 'restricted' | 'ineligible';
export type EligibilityLink = {type:'employee'|'qualification'|'instruction'|'absence';id:string;label:string};
export type EligibilityReason = {code:string;message:string;link:EligibilityLink|null};

export type QualificationRecord = {
  id:string;code:string;status:string;valid_from:string|null;valid_until:string|null;
  revoked_at:string|Date|null;document_id?:string|null;catalog_active?:boolean|null;
  document_approval_status?:string|null;document_lifecycle_state?:string|null;
  required_document_type?:string|null;required_documents?:string[]|null;
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

const timeZone='Europe/Berlin';
const weekdayNumbers:Record<string,number>={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};

function asDate(value:string|Date):Date{
  return value instanceof Date?value:new Date(value.length<=10?`${value}T00:00:00Z`:value);
}
function localDayString(value:string|Date):string{
  return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(asDate(value));
}
function day(value:string|Date):number{
  const [year,month,date]=localDayString(value).split('-').map(Number);
  return Date.UTC(year,month-1,date);
}
function beforeOrEqual(a:string|Date,b:string|Date){return day(a)<=day(b);}
function overlaps(aStart:string,aEnd:string,bStart:string,bEnd:string){
  return new Date(aStart).getTime()<new Date(bEnd).getTime()&&new Date(bStart).getTime()<new Date(aEnd).getTime();
}
function shiftTime(value:string|Date):{weekday:number;minutes:number}{
  const date=asDate(value);
  const weekday=new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short'}).format(date);
  const clock=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
  const [hours='0',minutes='0']=clock.split(':');
  return {weekday:weekdayNumbers[weekday]??0,minutes:Number(hours)*60+Number(minutes)};
}
function timeMinutes(value:string):number{
  const [hours='0',minutes='0']=value.split(':');
  return Number(hours)*60+Number(minutes);
}
function evidenceRequired(item:QualificationRecord):boolean{
  return Boolean(item.required_document_type)||Boolean(item.required_documents?.length);
}
function evidenceProblem(item:QualificationRecord):'missing'|'unapproved'|null{
  if(!evidenceRequired(item))return null;
  if(!item.document_id)return 'missing';
  if(item.document_approval_status!=='approved')return 'unapproved';
  if(item.document_lifecycle_state&&item.document_lifecycle_state!=='available')return 'unapproved';
  return null;
}
function qualificationLink(code:string,item:QualificationRecord):EligibilityLink{
  return item.document_id
    ?{type:'qualification',id:item.document_id,label:`Nachweis ${code}`}
    :{type:'qualification',id:item.id,label:`Qualifikation ${code}`};
}

function qualificationReason(input:EligibilityInput,code:string):EligibilityReason|null{
  const {starts_at,ends_at}=input.shift;
  const candidates=input.qualifications.filter(item=>item.code===code);
  const usable=candidates.find(item=>{
    if(item.status!=='valid'||item.revoked_at||item.catalog_active===false)return false;
    if(item.valid_from&&!beforeOrEqual(item.valid_from,starts_at))return false;
    if(item.valid_until&&!beforeOrEqual(ends_at,item.valid_until))return false;
    return evidenceProblem(item)===null;
  });
  if(usable)return null;
  const latest=[...candidates].sort((a,b)=>String(b.valid_until??'').localeCompare(String(a.valid_until??'')))[0];
  if(latest?.revoked_at||latest?.status==='revoked')return {
    code:'qualification_revoked',message:`Qualifikationsnachweis ${code} ist widerrufen`,
    link:qualificationLink(code,latest),
  };
  if(latest?.status==='expired'||(latest?.valid_until&&day(latest.valid_until)<day(ends_at)))return {
    code:'qualification_expired',message:`Qualifikationsnachweis ${code} ist zum Einsatzzeitpunkt abgelaufen`,
    link:qualificationLink(code,latest),
  };
  if(latest?.status==='invalid'||latest?.catalog_active===false)return {
    code:'qualification_invalid',message:`Qualifikationsnachweis ${code} ist ungültig`,
    link:{type:'qualification',id:latest.id,label:`Qualifikation ${code}`},
  };
  if(latest?.valid_from&&!beforeOrEqual(latest.valid_from,starts_at))return {
    code:'qualification_not_yet_valid',message:`Qualifikationsnachweis ${code} ist zum Einsatzzeitpunkt noch nicht gültig`,
    link:qualificationLink(code,latest),
  };
  if(latest&&evidenceProblem(latest)==='missing')return {
    code:'qualification_evidence_missing',message:`Zur Qualifikation ${code} fehlt der verknüpfte Nachweis`,
    link:{type:'qualification',id:latest.id,label:`Qualifikation ${code}`},
  };
  if(latest&&evidenceProblem(latest)==='unapproved')return {
    code:'qualification_evidence_unapproved',message:`Der Nachweis für Qualifikation ${code} ist nicht freigegeben`,
    link:qualificationLink(code,latest),
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
  const shiftStart=shiftTime(shift.starts_at);
  const shiftEnd=shiftTime(shift.ends_at);
  if(input.availability.some(item=>!item.available&&item.weekday===shiftStart.weekday
    &&(!item.valid_from||beforeOrEqual(item.valid_from,shift.starts_at))
    &&(!item.valid_until||beforeOrEqual(shift.ends_at,item.valid_until))
    &&timeMinutes(item.starts_time)<shiftEnd.minutes&&shiftStart.minutes<timeMinutes(item.ends_time)))reasons.push({
    code:'availability',message:'Verfügbarkeit schließt den Schichtzeitraum aus',link:null,
  });
  if(input.overlapping_shift)reasons.push({code:'overlapping_shift',message:'Überschneidung mit einer anderen zugewiesenen Schicht',link:null});
  const hard=reasons.some(reason=>!reason.code.endsWith('_restricted')&&reason.code!=='absence_requested');
  return {
    status:hard?'ineligible':reasons.length?'restricted':'eligible',
    reasons,matched_qualification_codes:matched,missing_qualification_codes:missing,
  };
}
