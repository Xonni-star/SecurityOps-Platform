/** Pure, server-side eligibility rules for a concrete shift. No UI state is trusted. */
import {evidenceStatusOf,qualificationDayNumber} from './qualification-status.js';

export type EligibilityStatus = 'eligible' | 'restricted' | 'ineligible';
export type EligibilityLink = {type:'employee'|'qualification'|'instruction'|'absence';id:string;label:string};
export type EligibilityReason = {code:string;message:string;link:EligibilityLink|null};

export type QualificationRecord = {
  id:string;code:string;status:string;valid_from:string|null;valid_until:string|null;
  revoked_at:string|Date|null;document_id?:string|null;catalog_active?:boolean|null;
  document_status?:string|null;document_approval_status?:string|null;document_lifecycle_state?:string|null;
  document_valid_from?:string|Date|null;document_valid_until?:string|Date|null;
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
    hire_date?:string|null;termination_date?:string|null;
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
type Interval={day:number;weekday:number;start:number;end:number};

function asDate(value:string|Date):Date{
  return value instanceof Date?value:new Date(value.length<=10?`${value}T00:00:00Z`:value);
}
function localDay(value:string|Date):number|null{
  return qualificationDayNumber(value);
}
function beforeOrEqual(a:string|Date,b:string|Date){
  const left=localDay(a);const right=localDay(b);
  return left!==null&&right!==null&&left<=right;
}
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
/** Berliner Tagesabschnitte einer Schicht; Nachtschichten werden am Mitternacht geteilt. */
function shiftIntervals(startsAt:string,endsAt:string):Interval[]{
  const start=shiftTime(startsAt);
  const end=shiftTime(endsAt);
  const startDay=localDay(startsAt);
  const endDay=localDay(endsAt);
  if(startDay===null||endDay===null)return [];
  const intervals:Interval[]=[];
  for(let current=startDay;current<=endDay;current+=86_400_000){
    const weekday=new Date(current).getUTCDay();
    const from=current===startDay?start.minutes:0;
    const to=current===endDay?end.minutes:1_440;
    if(to>from)intervals.push({day:current,weekday,start:from,end:to});
  }
  return intervals;
}
/** Ein Verfügbarkeitsfenster mit Ende <= Beginn läuft über Mitternacht. */
function availabilityIntervals(item:AvailabilityRecord):Array<{weekday:number;start:number;end:number}>{
  const start=timeMinutes(item.starts_time);
  const end=timeMinutes(item.ends_time);
  if(end>start)return [{weekday:item.weekday,start,end}];
  if(end===start)return [];
  return [{weekday:item.weekday,start,end:1_440},{weekday:(item.weekday+1)%7,start:0,end}];
}
function evidenceRequired(item:QualificationRecord):boolean{
  return Boolean(item.required_document_type)||Boolean(item.required_documents?.length);
}
type EvidenceProblem='missing'|'unapproved'|'expired'|'not_yet_valid'|'invalid_date'|null;
function evidenceProblem(item:QualificationRecord,now:Date):EvidenceProblem{
  if(!evidenceRequired(item))return null;
  const status=evidenceStatusOf({
    document_id:item.document_id,
    evidence_document_status:item.document_status??null,
    evidence_approval_status:item.document_approval_status??null,
    evidence_lifecycle_state:item.document_lifecycle_state??null,
    evidence_valid_from:item.document_valid_from??null,
    evidence_valid_until:item.document_valid_until??null,
  },now);
  if(!status||status==='gueltig'||status==='lauf_bald_ab')return null;
  if(status==='missing'||status==='not_found')return 'missing';
  if(status==='abgelaufen')return 'expired';
  if(status==='noch_nicht_gueltig')return 'not_yet_valid';
  if(status==='invalid_date')return 'invalid_date';
  return 'unapproved';
}
/** Nachweise gelten bis zum Ablauf des lokalen Schichtstarts, auch bei Nachtschichten. */
function relevantDay(startsAt:string,endsAt:string):number|null{
  const start=localDay(startsAt);
  const end=localDay(endsAt);
  if(start===null||end===null)return null;
  return end>start?start:end;
}
function invalidQualificationDate(item:QualificationRecord):boolean{
  return (item.valid_from!==null&&localDay(item.valid_from)===null)
    ||(item.valid_until!==null&&localDay(item.valid_until)===null);
}
function coversShift(item:QualificationRecord,startsAt:string,endsAt:string):boolean{
  if(invalidQualificationDate(item))return false;
  const start=localDay(startsAt);
  const relevant=relevantDay(startsAt,endsAt);
  if(start===null||relevant===null)return false;
  if(item.valid_from&&localDay(item.valid_from)!>start)return false;
  if(item.valid_until&&localDay(item.valid_until)!<relevant)return false;
  return true;
}
function qualificationLink(code:string,item:QualificationRecord):EligibilityLink{
  return item.document_id
    ?{type:'qualification',id:item.document_id,label:`Nachweis ${code}`}
    :{type:'qualification',id:item.id,label:`Qualifikation ${code}`};
}

function qualificationReason(input:EligibilityInput,code:string):EligibilityReason|null{
  const {starts_at,ends_at}=input.shift;
  const evidenceDay=relevantDay(starts_at,ends_at)??localDay(starts_at);
  // 12:00 UTC liegt in Berlin immer am selben Kalendertag. Nachweise werden
  // daher gegen den Schichttag geprüft, nicht gegen das aktuelle Datum.
  const evidenceNow=evidenceDay===null?new Date():new Date(evidenceDay+43_200_000);
  const candidates=input.qualifications.filter(item=>item.code===code);
  const usable=candidates.find(item=>{
    if(!['valid','expiring'].includes(item.status)||item.revoked_at||item.catalog_active===false)return false;
    return coversShift(item,starts_at,ends_at)&&evidenceProblem(item,evidenceNow)===null;
  });
  if(usable)return null;
  const latest=[...candidates].sort((a,b)=>String(b.valid_until??'').localeCompare(String(a.valid_until??'')))[0];
  if(latest?.revoked_at||latest?.status==='revoked')return {
    code:'qualification_revoked',message:`Qualifikationsnachweis ${code} ist widerrufen`,
    link:qualificationLink(code,latest),
  };
  const relevant=relevantDay(starts_at,ends_at);
  const startDay=localDay(starts_at);
  const validFromDay=latest?.valid_from?localDay(latest.valid_from):null;
  const evidence=latest?evidenceProblem(latest,evidenceNow):null;
  if(latest?.status==='expired'||evidence==='expired'
    ||(latest?.valid_until&&relevant!==null&&localDay(latest.valid_until)!<relevant))return {
    code:'qualification_expired',message:`Qualifikationsnachweis ${code} ist zum Einsatzzeitpunkt abgelaufen`,
    link:qualificationLink(code,latest),
  };
  if(latest?.status==='invalid'||latest?.catalog_active===false||evidence==='invalid_date')return {
    code:'qualification_invalid',message:`Qualifikationsnachweis ${code} ist ungültig`,
    link:{type:'qualification',id:latest.id,label:`Qualifikation ${code}`},
  };
  if((validFromDay!==null&&startDay!==null&&validFromDay>startDay)||evidence==='not_yet_valid')return {
    code:'qualification_not_yet_valid',message:`Qualifikationsnachweis ${code} ist zum Einsatzzeitpunkt noch nicht gültig`,
    link:qualificationLink(code,latest),
  };
  if(latest&&evidence==='missing')return {
    code:'qualification_evidence_missing',message:`Zur Qualifikation ${code} fehlt der verknüpfte Nachweis`,
    link:{type:'qualification',id:latest.id,label:`Qualifikation ${code}`},
  };
  if(latest&&evidence==='unapproved')return {
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
  const statusBlocked=['terminated','archived','leave'].includes(employee.employment_status??'');
  if(['terminated','archived'].includes(employee.employment_status??''))reasons.push({
    code:'employment_status',message:`Mitarbeiter ist nicht mehr beschäftigt (${employee.employment_status})`,link:{type:'employee',id:employee.id,label:employee.name},
  });
  else if(employee.employment_status==='leave')reasons.push({
    code:'employment_status',message:'Mitarbeiter befindet sich in Beurlaubung',link:{type:'employee',id:employee.id,label:employee.name},
  });
  else if(employee.employment_status==='probation'||employee.employment_status===null)reasons.push({
    code:'employment_status_restricted',message:'Beschäftigungsstatus erfordert Prüfung',link:{type:'employee',id:employee.id,label:employee.name},
  });
  // Beschäftigungszeitraum: Eintritt und Austritt werden gegen den Schichtzeitraum
  // geprüft. Bereits statusbedingt gesperrte Mitarbeiter erhalten keine Doppelwarnung.
  const shiftStartDay=localDay(shift.starts_at);
  const shiftEndDay=localDay(shift.ends_at);
  if(!statusBlocked&&employee.hire_date){
    const hireDay=localDay(employee.hire_date);
    if(hireDay===null||(shiftStartDay!==null&&hireDay>shiftStartDay))reasons.push({
      code:'employment_not_started',message:'Mitarbeiter ist zum Schichtbeginn noch nicht eingestellt',
      link:{type:'employee',id:employee.id,label:employee.name},
    });
  }
  if(!statusBlocked&&employee.termination_date){
    const terminationDay=localDay(employee.termination_date);
    if(terminationDay===null||(shiftEndDay!==null&&terminationDay<shiftEndDay))reasons.push({
      code:'employment_ended',message:'Mitarbeiter ist zum Schichtende nicht mehr beschäftigt',
      link:{type:'employee',id:employee.id,label:employee.name},
    });
  }
  const assignmentEndsOn=employee.assignment?.ends_on??null;
  const assignmentEnd=assignmentEndsOn===null?null:localDay(assignmentEndsOn);
  if(!employee.assignment||!beforeOrEqual(employee.assignment.starts_on,shift.starts_at)
    ||(assignmentEndsOn!==null&&(assignmentEnd===null||shiftEndDay===null||assignmentEnd<shiftEndDay)))reasons.push({
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
  const intervals=shiftIntervals(shift.starts_at,shift.ends_at);
  const availabilityBlocked=input.availability.some(item=>{
    if(item.available)return false;
    const validityFrom=item.valid_from?localDay(item.valid_from):null;
    const validityUntil=item.valid_until?localDay(item.valid_until):null;
    if(item.valid_from&&validityFrom===null)return false;
    if(item.valid_until&&validityUntil===null)return false;
    return availabilityIntervals(item).some(window=>intervals.some(interval=>
      interval.weekday===window.weekday&&window.start<interval.end&&interval.start<window.end
      &&(validityFrom===null||validityFrom<=interval.day)
      &&(validityUntil===null||validityUntil>=interval.day)));
  });
  if(availabilityBlocked)reasons.push({
    code:'availability',message:'Verfügbarkeit schließt den Schichtzeitraum aus',link:null,
  });
  if(input.overlapping_shift)reasons.push({code:'overlapping_shift',message:'Überschneidung mit einer anderen zugewiesenen Schicht',link:null});
  const hard=reasons.some(reason=>!reason.code.endsWith('_restricted')&&reason.code!=='absence_requested');
  return {
    status:hard?'ineligible':reasons.length?'restricted':'eligible',
    reasons,matched_qualification_codes:matched,missing_qualification_codes:missing,
  };
}
