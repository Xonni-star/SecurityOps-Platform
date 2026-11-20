export interface TimeWindow {startsAt:string;endsAt:string}
export interface SchedulingProfileParameters {
  max_shift_minutes?:number;
  min_rest_minutes?:number;
  required_qualification_codes?:string[];
  [key:string]:unknown;
}

export interface SchedulingConflict {
  conflict_type:'overlapping_shift'|'missing_qualification'|'absence'|'rule_profile';
  severity:'info'|'warning'|'error';
  details:Record<string,unknown>;
}

export function overlaps(a:TimeWindow,b:TimeWindow){
  return new Date(a.startsAt).getTime()<new Date(b.endsAt).getTime()
    && new Date(b.startsAt).getTime()<new Date(a.endsAt).getTime();
}

export function detectShiftConflicts(
  shift:TimeWindow&{requiredQualificationCodes?:string[]},
  otherShifts:TimeWindow[],
  qualifications:string[],
  absences:TimeWindow[],
  parameters:SchedulingProfileParameters,
):SchedulingConflict[]{
  const conflicts:SchedulingConflict[]=[];
  if(otherShifts.some(other=>overlaps(shift,other))){
    conflicts.push({conflict_type:'overlapping_shift',severity:'warning',details:{reason:'shift_time_overlap'}});
  }
  const required=new Set([
    ...(parameters.required_qualification_codes??[]),
    ...(shift.requiredQualificationCodes??[]),
  ]);
  const missing=[...required].filter(code=>!qualifications.includes(code));
  if(missing.length){
    conflicts.push({conflict_type:'missing_qualification',severity:'error',details:{missing_qualification_codes:missing}});
  }
  if(absences.some(absence=>overlaps(shift,absence))){
    conflicts.push({conflict_type:'absence',severity:'error',details:{reason:'employee_absence_overlap'}});
  }
  const maxMinutes=parameters.max_shift_minutes;
  if(typeof maxMinutes==='number'&&Number.isFinite(maxMinutes)){
    const minutes=(new Date(shift.endsAt).getTime()-new Date(shift.startsAt).getTime())/60000;
    if(minutes>maxMinutes)conflicts.push({conflict_type:'rule_profile',severity:'warning',details:{rule:'max_shift_minutes',configured_value:maxMinutes,observed_value:minutes}});
  }
  return conflicts;
}
