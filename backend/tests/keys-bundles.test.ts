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
  permissions:['keys:return'],permission_grants:[],site_ids:[],is_system_admin:false,
  session_id:'00000000-0000-4000-8000-000000000040',csrf_token:'csrf-value',
  expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-000000000041',
};
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};

beforeEach(()=>queryMock.mockReset());

describe('key bundle return',()=>{
  it('rejects a partial return when any requested member is missing before updating any key',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('INSERT INTO sync_receipts'))return result([{id:'receipt-1'}]);
      if(sql.includes('SELECT * FROM key_bundles'))return result([{id:bundleId,site_id:null,status:'active'}]);
      if(sql.includes('FROM key_bundle_members bm'))return result([{id:keyA,status:'issued',holder_user_id:userId,holder_employee_id:null}]);
      return result([]);
    });

    const response=await request(app).post(`/api/v1/keys/bundles/${bundleId}/return`).set(csrf).send({
      key_ids:[keyA,keyB],
      client_mutation_id:'00000000-0000-4000-8000-000000000050',
    });

    expect(response.status).toBe(404);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE keys'))).toBe(false);
  });
});
