import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const tenant='00000000-0000-4000-8000-000000000010';
const userId='00000000-0000-4000-8000-000000000001';
const bundleId='00000000-0000-4000-8000-000000000020';
const keyA='00000000-0000-4000-8000-000000000030';
const keyB='00000000-0000-4000-8000-000000000031';
const session={
  id:userId,tenantId:tenant,email:'operator@example.invalid',role:'operator',
  permissions:['keys:bundle_read','keys:bundle_return','keys:bundle_history_read'],
  permission_grants:[
    {code:'keys:bundle_read',scope:'tenant'},
    {code:'keys:bundle_return',scope:'tenant'},
    {code:'keys:bundle_history_read',scope:'tenant'},
  ],
  site_ids:[],is_system_admin:false,
  session_id:'00000000-0000-4000-8000-000000000040',csrf_token:'csrf-value',
  expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-000000000041',
};
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};
const bundle={id:bundleId,site_id:null,status:'issued',holder_user_id:userId,holder_employee_id:null};
const item=(id:string)=>({id,site_id:null,status:'issued',holder_user_id:userId,holder_employee_id:null,due_at:null});

function baseMock(items:unknown[]){
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([session]);
    if(sql.includes('INSERT INTO sync_receipts'))return result([{id:'receipt-1'}],1);
    if(sql.includes('UPDATE sync_receipts'))return result([],1);
    if(sql.includes('SELECT * FROM key_bundles'))return result([bundle]);
    if(sql.includes('FROM key_bundle_items i JOIN keys k'))return result(items);
    if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}],1);
    return result([]);
  });
}

beforeEach(()=>queryMock.mockReset());

describe('key bundle return',()=>{
  it('rejects a partial return when any requested member is missing before updating any key',async()=>{
    baseMock([item(keyA)]);

    const response=await request(app).post(`/api/v1/key-bundles/${bundleId}/return`).set(csrf).send({
      key_ids:[keyA,keyB],
      client_mutation_id:'00000000-0000-4000-8000-000000000050',
    });

    expect(response.status).toBe(404);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE keys'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO key_bundle_movements'))).toBe(false);
  });

  it('records an append-only partial_return movement and marks the bundle partial',async()=>{
    baseMock([item(keyA),item(keyB)]);
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('INSERT INTO sync_receipts'))return result([{id:'receipt-1'}],1);
      if(sql.includes('UPDATE sync_receipts'))return result([],1);
      if(sql.includes('SELECT * FROM key_bundles'))return result([bundle]);
      if(sql.includes('FROM key_bundle_items i JOIN keys k'))return result([item(keyA),item(keyB)]);
      if(sql.startsWith('UPDATE keys'))return result([{...item(keyA),status:'available',holder_user_id:null}],1);
      if(sql.startsWith('INSERT INTO key_movements'))return result([{id:'movement-1'}],1);
      if(sql.startsWith('UPDATE key_bundles'))return result([{...bundle,status:'partial'}],1);
      if(sql.includes('INSERT INTO key_bundle_movements'))return result([{id:'bundle-movement-1',movement_type:'partial_return'}],1);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}],1);
      return result([]);
    });

    const response=await request(app).post(`/api/v1/key-bundles/${bundleId}/return`).set(csrf).send({
      key_ids:[keyA],
      client_mutation_id:'00000000-0000-4000-8000-000000000051',
      reason:'Teilrückgabe',
    });

    expect(response.status).toBe(200);
    expect(response.body.bundle.status).toBe('partial');
    expect(response.body.movement.movement_type).toBe('partial_return');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE keys'))).toBe(true);
    const bundleMovementCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO key_bundle_movements'));
    expect(bundleMovementCall?.[1]).toContain('partial_return');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).startsWith('DELETE FROM key_bundle_movements'))).toBe(false);
  });

  it('serves bundle history only with keys:bundle_history_read',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('SELECT * FROM key_bundles'))return result([{...bundle,status:'partial'}]);
      if(sql.includes('FROM key_bundle_movements'))return result([{id:'bm-1',movement_type:'partial_return',total_count:1}]);
      return result([]);
    });

    const response=await request(app).get(`/api/v1/key-bundles/${bundleId}/history`).set(csrf);

    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('1');
    expect(response.body[0].movement_type).toBe('partial_return');
  });
});
