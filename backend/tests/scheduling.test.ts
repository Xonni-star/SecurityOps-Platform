import {describe,expect,it,jest} from '@jest/globals';
import {detectShiftConflicts,overlaps} from '../src/services/scheduling.js';
import {canonicalPayloadHash,runIdempotentMutation} from '../src/services/offline-sync.js';

describe('dienstplanung conflict findings',()=>{
  const shift={startsAt:'2026-11-20T08:00:00Z',endsAt:'2026-11-20T18:00:00Z',requiredQualificationCodes:['armed']};
  it('detects overlapping windows without treating touching shifts as overlap',()=>{
    expect(overlaps(shift,{startsAt:'2026-11-20T17:00:00Z',endsAt:'2026-11-20T19:00:00Z'})).toBe(true);
    expect(overlaps(shift,{startsAt:'2026-11-20T18:00:00Z',endsAt:'2026-11-20T20:00:00Z'})).toBe(false);
    expect(detectShiftConflicts(shift,[{startsAt:'2026-11-20T17:00:00Z',endsAt:'2026-11-20T19:00:00Z'}],[],[],{})).toEqual(expect.arrayContaining([expect.objectContaining({conflict_type:'overlapping_shift'})]));
  });
  it('reports missing qualification and absence as explicit findings',()=>{
    const conflicts=detectShiftConflicts(shift,[],[],[{startsAt:'2026-11-20T10:00:00Z',endsAt:'2026-11-20T12:00:00Z'}],{});
    expect(conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({conflict_type:'missing_qualification',severity:'error'}),
      expect.objectContaining({conflict_type:'absence',severity:'error'}),
    ]));
  });
  it('uses versioned profile parameters without embedding legal defaults',()=>{
    const conflicts=detectShiftConflicts(shift,[],['armed'],[],{max_shift_minutes:480});
    expect(conflicts).toEqual(expect.arrayContaining([expect.objectContaining({conflict_type:'rule_profile'})]));
    expect(detectShiftConflicts(shift,[],['armed'],[],{})).not.toEqual(expect.arrayContaining([expect.objectContaining({conflict_type:'rule_profile'})]));
  });
  it('replays a scheduling mutation with the stored response',async()=>{
    const payload={name:'Operations',version:1};
    const client={query:jest.fn()
      .mockResolvedValueOnce({rowCount:1,rows:[{id:'receipt-1'}]})
      .mockResolvedValueOnce({rowCount:1,rows:[]})
      .mockResolvedValueOnce({rowCount:0,rows:[]})
      .mockResolvedValueOnce({rowCount:1,rows:[{action:'scheduling.rule_profile',payload_hash:canonicalPayloadHash(payload),status:'completed',response:{id:'profile-1'}}]})};
    const apply=jest.fn().mockResolvedValue({id:'profile-1'});
    const first=await runIdempotentMutation(client as never,{tenantId:'tenant-1',userId:'user-1',mutationId:'11111111-1111-4111-8111-111111111111',action:'scheduling.rule_profile',payload},apply);
    expect(first.replayed).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    const second=await runIdempotentMutation(client as never,{tenantId:'tenant-1',userId:'user-1',mutationId:'11111111-1111-4111-8111-111111111111',action:'scheduling.rule_profile',payload},apply);
    expect(second).toEqual({response:{id:'profile-1'},replayed:true});
  });
});
