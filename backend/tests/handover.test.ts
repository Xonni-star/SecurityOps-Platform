import {describe,expect,it} from '@jest/globals';
import {canAccessResource} from '../src/types/authorization.js';
import {canConfirmParticipant,canonicalEventHash,participantIdentityIsValid,verifyEventChain} from '../src/services/handover-domain.js';

describe('handover protocol domain',()=>{
  it('keeps tenant and site access isolated',()=>{
    const context={userId:'u1',tenantId:'t1',role:'operator',isSystemAdmin:false,siteIds:['s1'],grants:[]};
    expect(canAccessResource(context,'site',{tenantId:'t1',siteId:'s1'})).toBe(true);
    expect(canAccessResource(context,'site',{tenantId:'t1',siteId:'s2'})).toBe(false);
    expect(canAccessResource(context,'site',{tenantId:'t2',siteId:'s1'})).toBe(false);
  });

  it('requires exactly one participant identity and binds confirmation to that user',()=>{
    expect(participantIdentityIsValid({userId:'u1',employeeId:null})).toBe(true);
    expect(participantIdentityIsValid({userId:null,employeeId:'e1'})).toBe(true);
    expect(participantIdentityIsValid({userId:'u1',employeeId:'e1'})).toBe(false);
    expect(canConfirmParticipant({actorUserId:'u1',participantUserId:'u1',participantEmployeeId:null,operator:false})).toBe(true);
    expect(canConfirmParticipant({actorUserId:'u2',participantUserId:'u1',participantEmployeeId:null,operator:false})).toBe(false);
    expect(canConfirmParticipant({actorUserId:'u2',participantUserId:null,participantEmployeeId:'e1',operator:false})).toBe(false);
  });

  it('detects replay/hash mismatches in append-only event history',()=>{
    const first={handover_id:'h1',sequence_no:1,event_type:'created',payload:{title:'Night'},actor_user_id:'u1',session_id:'s1',previous_event_hash:null};
    const firstHash=canonicalEventHash({handoverId:first.handover_id,sequenceNo:first.sequence_no,eventType:first.event_type,payload:first.payload,actorUserId:first.actor_user_id,sessionId:first.session_id,previousEventHash:first.previous_event_hash});
    const second={handover_id:'h1',sequence_no:2,event_type:'confirmation_recorded',payload:{participant_id:'p1'},actor_user_id:'u1',session_id:'s1',previous_event_hash:firstHash};
    const secondHash=canonicalEventHash({handoverId:second.handover_id,sequenceNo:second.sequence_no,eventType:second.event_type,payload:second.payload,actorUserId:second.actor_user_id,sessionId:second.session_id,previousEventHash:second.previous_event_hash});
    expect(verifyEventChain([{...first,event_hash:firstHash},{...second,event_hash:secondHash}])).toMatchObject({valid:true});
    expect(verifyEventChain([{...first,event_hash:firstHash},{...second,payload:{participant_id:'tampered'},event_hash:secondHash}])).toMatchObject({valid:false,reason:'event_hash_mismatch'});
    expect(verifyEventChain([{...first,event_hash:firstHash},{...second,previous_event_hash:'0'.repeat(64),event_hash:secondHash}])).toMatchObject({valid:false,reason:'previous_hash_mismatch'});
  });
});
