import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {app}=await import('../src/app.js');
const tenant='00000000-0000-4000-8000-00000000000a';
const customer='00000000-0000-4000-8000-0000000000bb';
const site='00000000-0000-4000-8000-0000000000cc';
const sessionUser={
  id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:['customers:read','customers:write','customer_contacts:read','customer_contacts:write','contracts:read','contracts:write','sites:read','dms:read','dms:write'],
  permission_grants:[],site_ids:[site],is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000dd',
  csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ee',
};
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];

beforeEach(()=>{
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([sessionUser]);
    if(sql.includes('INSERT INTO customers'))return result([{id:customer,tenant_id:tenant,name:'Nordlicht GmbH',customer_status:'active'}]);
    if(sql.includes('FROM customers WHERE'))return result([{id:customer}]);
    return result([]);
  });
});

describe('customer management',()=>{
  it('lists only tenant customers with server-computed relationship counts',async()=>{
    queryMock.mockImplementation(async(sql:string,values:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM customers c'))return result([{id:customer,name:'Nordlicht GmbH',active_sites:2,active_contracts:1,active_contacts:3}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/customers').set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body[0]).toEqual(expect.objectContaining({id:customer,active_sites:2,active_contracts:1}));
    const listing=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM customers c'));
    expect(listing?.[1]).toEqual([tenant]);
    expect(String(listing?.[0])).toContain('WHERE c.tenant_id=$1');
  });

  it('rejects invalid customer records before reaching the database write',async()=>{
    const response=await request(app).post('/api/v1/customers')
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({email:'invalid'});
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO customers'))).toBe(false);
  });

  it('creates a validated customer and records the change',async()=>{
    const response=await request(app).post('/api/v1/customers')
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({name:'Nordlicht GmbH',customer_status:'active'});
    expect(response.status).toBe(201);
    expect(response.body.id).toBe(customer);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO customer_history'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO audit_events'))).toBe(true);
  });

  it('does not assign a contact to an object outside the customer relationship',async()=>{
    const response=await request(app).post(`/api/v1/customers/${customer}/contacts`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value')
      .send({first_name:'Mira',email:'mira@example.invalid',site_ids:[site]});
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('already belong');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO customer_contacts'))).toBe(false);
  });

  it('rejects a contract-site association unless the site belongs to the customer',async()=>{
    const response=await request(app).post(`/api/v1/customers/${customer}/contracts/${site}/sites`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({site_id:site});
    expect(response.status).toBe(400);
    const insert=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO contract_sites'));
    expect(insert?.[1]).toEqual([tenant,customer,site,site]);
  });

  it('hides customer documents from general DMS listings and blocks upload without confidential-document permission',async()=>{
    const listing=await request(app).get('/api/v1/dms/documents').set('Cookie','securityops_session=opaque');
    expect(listing.status).toBe(200);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('d.customer_id IS NULL'))).toBe(true);

    const upload=await request(app).post('/api/v1/dms/documents')
      .set('Cookie',csrf).set('x-csrf-token','csrf-value')
      .send({title:'Security plan',customer_id:customer,customer_document_category:'security_plan',content_type:'text/plain',content_base64:'aGVsbG8=',client_mutation_id:'00000000-0000-4000-8000-0000000000ff'});
    expect(upload.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO dms_documents'))).toBe(false);
  });

  it('limits customer evidence exports to the report sites granted to a site-scoped user',async()=>{
    const siteScopedUser={
      ...sessionUser,
      permissions:['customer_reports:export'],
      permission_grants:[{code:'customer_reports:export',scope:'site'}],
    };
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([siteScopedUser]);
      if(sql.includes('FROM customers WHERE'))return result([{id:customer}]);
      if(sql.includes('FROM customer_sites'))return result([{site_id:site}]);
      if(sql.includes('FROM incidents i'))return result([{id:'incident-1',site_id:site,description:'Alarm response'}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/customer-reports/incidents?customer_id=${customer}`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    const reportQuery=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM incidents i'));
    expect(String(reportQuery?.[0])).toContain('i.site_id=ANY($5)');
    expect(reportQuery?.[1]?.[4]).toEqual([site]);
  });
});
