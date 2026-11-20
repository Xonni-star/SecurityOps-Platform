import {describe,expect,it} from '@jest/globals';
import {canonicalPayloadHash,canonicalize,parseSyncConflictStrategy,resolveConflict,runIdempotentMutation} from '../src/services/offline-sync.js';

describe('offline sync contracts',()=>{
  it('hashes equivalent object key orders identically',()=>{
    expect(canonicalize({b:2,a:{d:4,c:3}})).toEqual({a:{c:3,d:4},b:2});
    expect(canonicalPayloadHash({b:2,a:1})).toBe(canonicalPayloadHash({a:1,b:2}));
    expect(canonicalPayloadHash({a:1})).not.toBe(canonicalPayloadHash({a:2}));
  });

  it('exposes explicit conflict resolution strategies',()=>{
    expect(resolveConflict('USE_LOCAL','local','server')).toEqual({strategy:'USE_LOCAL',value:'local'});
    expect(resolveConflict('USE_SERVER','local','server')).toEqual({strategy:'USE_SERVER',value:'server'});
    expect(resolveConflict('RECORD_AS_EXCEPTION','local','server')).toEqual({strategy:'RECORD_AS_EXCEPTION',value:null});
  });

  it('rejects unknown conflict strategies',()=>{
    expect(()=>parseSyncConflictStrategy('MERGE')).toThrow('Ungültige Konfliktstrategie');
  });

  it('replays a completed receipt without applying the mutation twice',async()=>{
    let inserted=true;
    let applied=0;
    const client={
      query:async(sql:string)=>{
        if(sql.includes('ON CONFLICT'))return {rowCount:inserted?1:0,rows:inserted?[{id:'receipt-1'}]:[]};
        if(sql.includes('SELECT action'))return {rowCount:1,rows:[{action:'alarms.panic',payload_hash:canonicalPayloadHash({a:1}),status:'completed',response:{id:'alarm-1'}}]};
        return {rowCount:1,rows:[]};
      },
    } as never;
    const input={tenantId:'tenant-1',userId:'user-1',mutationId:'00000000-0000-0000-0000-000000000001',action:'alarms.panic' as const,payload:{a:1}};
    const created=await runIdempotentMutation(client,input,async()=>{applied++;return {id:'alarm-1'};});
    inserted=false;
    const replay=await runIdempotentMutation(client,input,async()=>{applied++;return {id:'alarm-1'};});
    expect(created.replayed).toBe(false);
    expect(replay).toEqual({replayed:true,response:{id:'alarm-1'}});
    expect(applied).toBe(1);
  });

  it('rejects a hash mismatch for an existing mutation',async()=>{
    const client={
      query:async(sql:string)=>{
        if(sql.includes('ON CONFLICT'))return {rowCount:0,rows:[]};
        return {rowCount:1,rows:[{action:'alarms.panic',payload_hash:canonicalPayloadHash({a:1}),status:'completed',response:{id:'alarm-1'}}]};
      },
    } as never;
    await expect(runIdempotentMutation(client,{tenantId:'tenant-1',userId:'user-1',mutationId:'00000000-0000-0000-0000-000000000001',action:'alarms.panic',payload:{a:2}},async()=>({}))).rejects.toMatchObject({status:409,code:'SYNC_HASH_MISMATCH'});
  });
});
