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
    if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
    if(sql.includes('FROM customers WHERE'))return result([{id:customer}]);
    if(sql.includes('INSERT INTO customer_sites'))return result([{id:'00000000-0000-4000-8000-0000000000cc'}]);
    return result([]);
  });
});

describe('object management',()=>{
  it('creates a site with a placeholder for every value including the tenant',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('INSERT INTO sites'))return result([{id:site,name:'Headquarters'}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/sites')
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({name:'Headquarters',site_number:null,address:null,status:'planning'});
    expect(response.status).toBe(201);
    const insert=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO sites'));
    expect(insert?.[0]).toContain('VALUES ($1,$2,$3,$4,$5)');
    expect(insert?.[1]).toEqual([tenant,'Headquarters',null,null,'planning']);
  });

  it('keeps object context behind tenant and permission checks',async()=>{
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({locations:[],hazards:[],instructions:[],journal:null}));
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_sites'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM contract_sites'))).toBe(true);
  });

  it('rejects a site-scoped user outside their assigned sites before reading or writing',async()=>{
    const scoped={...sessionUser,permission_grants:[{code:'sites:read',scope:'site'},{code:'sites:write',scope:'site'}],site_ids:[]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):result([]));
    const read=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    const write=await request(app).post(`/api/v1/sites/${site}/hazards`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({title:'Fire',category:'fire',description:'Risk',likelihood:1,impact:1});
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM sites'))).toBe(false);
  });

  it('requires ownership for own-scoped object context',async()=>{
    const scoped={...sessionUser,permission_grants:[{code:'sites:read',scope:'own'}]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):result([]));
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM resource_owners'))).toBe(true);
  });

  it('does not expose CRM data through a narrower customer permission',async()=>{
    const scoped={...sessionUser,permission_grants:[{code:'customers:read',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):result([]));
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_sites'))).toBe(false);
  });

  it('returns journal entries only with watchbook permission for the site',async()=>{
    const scoped={...sessionUser,permission_grants:[{code:'watchbook:read',scope:'site'}],site_ids:[site]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM watchbook_entries'))return result([{id:'entry'}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.journal).toEqual([{id:'entry'}]);
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

  it('rejects a hierarchy parent that is not part of the same site',async()=>{
    const response=await request(app).post(`/api/v1/sites/${site}/locations`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({name:'North building',location_type:'building',parent_id:customer});
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Parent location');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO object_locations'))).toBe(false);
  });

  it('creates a location with a tenant-validated responsible employee and audit event',async()=>{
    const employee='00000000-0000-4000-8000-0000000000dd';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('FROM employees WHERE'))return result([{id:employee}]);
      if(sql.includes('INSERT INTO object_locations'))return result([{id:'00000000-0000-4000-8000-0000000000de',responsible_employee_id:employee}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/sites/${site}/locations`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({name:'North building',location_type:'building',responsible_employee_id:employee});
    expect(response.status).toBe(201);
    expect(response.body.responsible_employee_id).toBe(employee);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM employees WHERE'))?.[1]).toEqual([tenant,employee]);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.location.created')).toBe(true);
  });

  it('creates an approved instruction and records employee acknowledgement by version',async()=>{
    const instruction='00000000-0000-4000-8000-0000000000df';
    const employee='00000000-0000-4000-8000-0000000000dd';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('SELECT id,version,status FROM site_instructions'))return result([{id:instruction,version:2,status:'approved'}]);
      if(sql.includes('SELECT id FROM employees WHERE'))return result([{id:employee}]);
      if(sql.includes('INSERT INTO instruction_acknowledgements'))return result([{instruction_id:instruction,employee_id:employee,acknowledged_version:2}]);
      if(sql.includes('INSERT INTO site_instructions'))return result([{id:instruction,version:2,status:'approved'}]);
      return result([]);
    });
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const create=await request(app).post(`/api/v1/sites/${site}/instructions`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Evacuation',content:'Use the marked exit.',version:2,status:'approved',requires_acknowledgement:true});
    expect(create.status).toBe(201);
    const acknowledged=await request(app).post(`/api/v1/sites/${site}/instructions/${instruction}/acknowledgements`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({employee_id:employee});
    expect(acknowledged.status).toBe(201);
    expect(acknowledged.body.acknowledged_version).toBe(2);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO instruction_acknowledgements')&&values?.[0]===tenant&&values?.[3]===2)).toBe(true);
  });

  it('validates hazard scoring inputs server-side',async()=>{
    const response=await request(app).post(`/api/v1/sites/${site}/hazards`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({title:'Fire loading bay',category:'fire',description:'Combustible storage',likelihood:6,impact:3});
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO object_hazards'))).toBe(false);
  });
});
