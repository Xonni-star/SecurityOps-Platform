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
const tenant='00000000-0000-4000-8000-00000000000a';
const site='00000000-0000-4000-8000-0000000000aa';
const customer='00000000-0000-4000-8000-0000000000bb';
const sessionUser={id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'admin@example.invalid',role:'admin',permissions:['sites:read','sites:write','customers:read','customers:write','contracts:read'],permission_grants:[],site_ids:[site],is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ad'};
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

beforeEach(()=>{
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([sessionUser]);
    if(sql.includes('FROM sites s'))return result([{id:site,status:'planning'}]);
    if(sql.includes('FROM customers WHERE'))return result([{id:customer}]);
    if(sql.includes('INSERT INTO customer_sites'))return result([{id:'00000000-0000-4000-8000-0000000000cc'}]);
    return result([]);
  });
});

describe('object management',()=>{
  it('keeps object context behind tenant and permission checks',async()=>{
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_sites'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM contract_sites'))).toBe(true);
  });

  it('does not create a CRM link for a customer outside the tenant',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('FROM customers WHERE'))return result([]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/sites/${site}/customer-links`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({customer_id:customer});
    expect(response.status).toBe(404);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO customer_sites'))).toBe(false);
  });
});
