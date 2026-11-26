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
  permissions:['customers:read','customers:write','customers:export','customer_contacts:read','customer_contacts:write','contracts:read','contracts:write','customer_tasks:read','customer_tasks:write','audit:read','sites:read','dms:read','dms:write'],
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
    queryMock.mockImplementation(async(sql:string,_values:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM customers c'))return result([{id:customer,name:'Nordlicht GmbH',active_sites:2,active_contracts:1,active_contacts:3,total_count:1}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/customers').set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body[0]).toEqual(expect.objectContaining({id:customer,active_sites:2,active_contracts:1}));
    expect(response.headers['x-total-count']).toBe('1');
    const listing=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM customers c'));
    expect(listing?.[1]).toEqual([tenant,10,0]);
    expect(String(listing?.[0])).toContain('WHERE c.tenant_id=$1');
    expect(String(listing?.[0])).toContain('LIMIT $2 OFFSET $3');
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

  it('applies combined server-side filters, sorting and pagination',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM customers c'))return result([{id:customer,total_count:23}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/customers')
      .query({q:'Nordlicht',customer_status:'active',risk_classification:'high',priority:'critical',account_manager_employee_id:site,contract_status:'active',sort:'next_contract_deadline',dir:'desc',page:2,pageSize:5})
      .set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('23');
    expect(response.headers['x-page-count']).toBe('5');
    const listing=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM customers c'));
    const sql=String(listing?.[0]);
    const values=listing?.[1] as unknown[];
    expect(values?.[0]).toBe(tenant);
    expect(values?.slice(1,-2)).toEqual(['%Nordlicht%','active','high','critical',site,'active']);
    expect(values?.slice(-2)).toEqual([5,5]);
    expect(sql).toContain('ILIKE $');
    expect(sql).toContain('ESCAPE');
    expect(sql).toContain('next_contract_deadline NULLS LAST DESC');
  });

  it('exports server-filtered customers only with the export permission',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM customers c'))return result([{id:customer,customer_number:'K-100',name:'Nordlicht GmbH',customer_status:'active',priority:'normal',risk_classification:'low',active_sites:2,active_contracts:1}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/customers/export?customer_status=active').set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('kunden.csv');
    expect(response.text).toContain('Nordlicht GmbH');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO audit_events'))).toBe(true);

    const restricted={...sessionUser,permissions:['customers:read']};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([restricted]):result([]));
    const denied=await request(app).get('/api/v1/customers/export').set('Cookie','securityops_session=opaque');
    expect(denied.status).toBe(403);
  });

  it('archives a validated selection in one tenant-scoped transaction',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('SELECT id FROM customers WHERE tenant_id'))return result([{id:customer}]);
      if(sql.includes('UPDATE customers SET customer_status'))return result([{id:customer}],1);
      return result([]);
    });
    const response=await request(app).post('/api/v1/customers/bulk')
      .set('Cookie',csrf).set('x-csrf-token','csrf-value')
      .send({ids:[customer],action:'archive'});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({updated:1,foreign:false});
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE customers SET customer_status'));
    expect(update?.[1]).toEqual(['archived',tenant,[customer]]);

    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      return result([]);
    });
    const foreign=await request(app).post('/api/v1/customers/bulk')
      .set('Cookie',csrf).set('x-csrf-token','csrf-value')
      .send({ids:[customer],action:'archive'});
    expect(foreign.status).toBe(404);
  });

  it('opens the customer file with customers:read alone and hides unauthorized sections',async()=>{
    const restricted={...sessionUser,permissions:['customers:read']};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([restricted]);
      if(sql.includes('FROM customers c LEFT JOIN employees'))return result([{id:customer,name:'Nordlicht GmbH',customer_status:'active'}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/customers/${customer}/profile`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.customer.id).toBe(customer);
    expect(response.body.visible_sections).toEqual({contacts:false,sites:false,contracts:false,documents:false,tasks:false,history:false});
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_contacts cc'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM contracts co WHERE'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM dms_documents d'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_history h'))).toBe(false);
  });

  it('separates task permissions from customer write access',async()=>{
    const restricted={...sessionUser,permissions:['customers:read','customers:write']};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([restricted]):result([]));
    const denied=await request(app).post(`/api/v1/customers/${customer}/tasks`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({title:'Wiedervorlage'});
    expect(denied.status).toBe(403);

    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM customers WHERE'))return result([{id:customer}]);
      if(sql.includes('INSERT INTO customer_tasks'))return result([{id:'00000000-0000-4000-8000-0000000000f1',title:'Wiedervorlage',priority:'critical'}]);
      return result([]);
    });
    const created=await request(app).post(`/api/v1/customers/${customer}/tasks`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({title:'Wiedervorlage',priority:'critical'});
    expect(created.status).toBe(201);
    expect(created.body.priority).toBe('critical');

    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('UPDATE customer_tasks SET'))return result([{id:'00000000-0000-4000-8000-0000000000f1',status:'completed',priority:'low'}]);
      return result([]);
    });
    const updated=await request(app).patch(`/api/v1/customers/${customer}/tasks/00000000-0000-4000-8000-0000000000f1`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({priority:'low',status:'completed'});
    expect(updated.status).toBe(200);
    const patch=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE customer_tasks SET'));
    expect(patch?.[1]).toEqual(['low','completed',tenant,customer,'00000000-0000-4000-8000-0000000000f1']);
  });

  it('derives unique A/B/C actions and contract reminders from live records',async()=>{
    const soon=new Date();soon.setUTCDate(soon.getUTCDate()+10);
    const overdue=new Date();overdue.setUTCHours(overdue.getUTCHours()-2);
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM customers c WHERE c.tenant_id=$1 AND c.customer_status'))return result([{
        id:customer,name:'Nordlicht GmbH',customer_status:'active',risk_classification:'critical',created_at:new Date().toISOString(),
        last_activity:null,open_tasks:1,active_contracts:1,active_sites:1,incomplete_contracts:0,primary_contacts:0,
        decision_contacts:0,security_contacts:0,billing_contacts:0,emergency_contacts:0,
      }]);
      if(sql.includes('FROM contracts co JOIN customers c'))return result([{
        id:site,contract_number:'V-1',ends_on:soon.toISOString().slice(0,10),customer_id:customer,customer_name:'Nordlicht GmbH',
      }]);
      if(sql.includes('FROM customer_tasks t JOIN customers c'))return result([{id:site,title:'Vertragsprüfung',due_at:overdue.toISOString(),customer_id:customer,customer_name:'Nordlicht GmbH'}]);
      if(sql.includes('FROM incidents i'))return result([]);
      return result([]);
    });
    const actions=await request(app).get('/api/v1/customers/action-list').set('Cookie','securityops_session=opaque');
    expect(actions.status).toBe(200);
    expect(actions.body.A.map((entry:{code:string})=>entry.code)).toEqual(expect.arrayContaining(['risk_critical','missing_primary_contact','missing_security_contact','contract_expiring','task_overdue']));
    expect(actions.body.B.map((entry:{code:string})=>entry.code)).toEqual(expect.arrayContaining(['missing_decision_contact','missing_billing_contact','missing_emergency_contact']));
    expect(new Set(actions.body.A.map((entry:{id:string})=>entry.id)).size).toBe(actions.body.A.length);
    expect(actions.body.C.some((entry:{code:string})=>entry.code==='active_customer')).toBe(true);

    const dashboard=await request(app).get('/api/v1/customers/dashboard').set('Cookie','securityops_session=opaque');
    expect(dashboard.status).toBe(200);
    const reminders=dashboard.body.reminders as {id:string}[];
    expect(reminders.length).toBeGreaterThan(0);
    expect(new Set(reminders.map(item=>item.id)).size).toBe(reminders.length);
  });
});
