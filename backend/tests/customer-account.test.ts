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
const customer='00000000-0000-4000-8000-0000000000bb';
const sessionUser={
  id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'admin@example.invalid',
  role:'admin',permissions:['customers:read'],permission_grants:[],site_ids:[],
  is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',
  csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ad',
};
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

beforeEach(()=>{
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([sessionUser]);
    if(sql.includes('FROM customers c'))return result([{id:customer,name:'Acme Security',customer_status:'active'}]);
    return result([]);
  });
});

describe('customer 360 account',()=>{
  it('returns tenant-scoped customer, relationships and audit timeline',async()=>{
    const response=await request(app).get(`/api/v1/customers/${customer}/360`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.customer.id).toBe(customer);
    expect(response.body).toEqual(expect.objectContaining({contacts:[],sites:[],contracts:[],services:[],timeline:[]}));
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('ae.tenant_id=$1'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('customer_contacts'))).toBe(true);
  });

  it('does not disclose a customer from another tenant',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM customers c'))return result([]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/customers/${customer}/360`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(404);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('customer_contacts'))).toBe(false);
  });

  it('rejects malformed customer ids before querying CRM data',async()=>{
    const response=await request(app).get('/api/v1/customers/not-a-uuid/360').set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customers c'))).toBe(false);
  });
});
