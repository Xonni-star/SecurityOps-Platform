import crypto from 'node:crypto';

export type HandoverParticipantInput={userId?:string|null;employeeId?:string|null};

export function participantIdentityIsValid(input:HandoverParticipantInput){
  return (input.userId!=null)!==(input.employeeId!=null);
}

export function canConfirmParticipant(input:{actorUserId:string;participantUserId:string|null;participantEmployeeId:string|null;actorEmployeeId?:string|null;operator:boolean}){
  if(input.operator)return true;
  return input.participantUserId===input.actorUserId;
}

export function canonicalEventHash(input:{handoverId:string;sequenceNo:number;eventType:string;payload:unknown;actorUserId:string;sessionId:string;previousEventHash:string|null}){
  return crypto.createHash('sha256').update(JSON.stringify({
    handoverId:input.handoverId,
    sequenceNo:input.sequenceNo,
    eventType:input.eventType,
    payload:input.payload,
    actorUserId:input.actorUserId,
    sessionId:input.sessionId,
    previousEventHash:input.previousEventHash,
  })).digest('hex');
}

export function verifyEventChain(events:Array<{handover_id:string;sequence_no:number;event_type:string;payload:unknown;actor_user_id:string;session_id:string;previous_event_hash:string|null;event_hash:string}>){
  let previous:string|null=null;
  for(const event of events){
    if(event.previous_event_hash!==previous)return {valid:false,reason:'previous_hash_mismatch',sequenceNo:event.sequence_no};
    const expected=canonicalEventHash({handoverId:event.handover_id,sequenceNo:event.sequence_no,eventType:event.event_type,payload:event.payload,actorUserId:event.actor_user_id,sessionId:event.session_id,previousEventHash:previous});
    if(expected!==event.event_hash)return {valid:false,reason:'event_hash_mismatch',sequenceNo:event.sequence_no};
    previous=event.event_hash;
  }
  return {valid:true,reason:null,sequenceNo:null};
}

export function latestConfirmation<T extends {confirmed_at:string}>(rows:T[]){
  return rows.slice().sort((a,b)=>new Date(b.confirmed_at).getTime()-new Date(a.confirmed_at).getTime())[0]??null;
}
