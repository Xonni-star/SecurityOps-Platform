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

const tenant='00000000-0000-4000-8000-000000000101';
const site='00000000-0000-4000-8000-000000000103';
const otherSite='00000000-0000-4000-8000-000000000104';
const measure='00000000-0000-4000-8000-000000000106';
const alarm='00000000-0000-4000-8000-000000000107';
const baseUser={
  id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'leitstelle@example.invalid',role:'operator',
  permissions:['nsl:read','scheduling:read','employees:read','sites:read','dms:read','keys:read','nfc_devices:read',
    'qualifications:read','alarms:read','operations_measures:read','operations_measures:write'],
  permission_grants:[] as Array<{code:string;scope:string}>,site_ids:[site],is_system_admin:false,
  session_id:'00000000-0000-4000-8000-0000000000ac',csrf_token:'csrf-value',expires_at:'2099-01-01',
  device_id:'00000000-0000-4000-8000-0000000000ad',
};
const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
const csrf={'x-csrf-token':'csrf-value'};
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
let activeUser:typeof baseUser;

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=baseUser;
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    return result([]);
  });
});

describe('operative control centre routes',()=>{
  it('requires an authenticated session',async()=>{
    const response=await request(app).get('/api/v1/operations/control-center');
    expect(response.status).toBe(401);
  });

  it('returns only server-aggregated sections and never caches the result',async()=>{
    const response=await request(app).get('/api/v1/operations/control-center?date=2026-11-27&page=2&page_size=5').set('Cookie',cookie);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      date:'2026-11-27',page:2,page_size:5,operational_status:'stabil',
      sections:{kpi:true,shifts:true,employees:true,sites:true,qualifications:true,documents:true,devices:true,keys:true,measures:true,alarms:true},
      alerts:[],shifts:[],employees:[],sites:[],qualifications:[],documents:[],devices:[],keys:[],measures:[],
      summary:{open_shifts:0,understaffed_sites:0,missing_documents:0,active_disruptions:0,measures_open:0,measures_overdue:0,unacknowledged_alarms:0},
    });
    expect(response.body.kpis.map((kpi:{key:string;value:number})=>[kpi.key,kpi.value])).toEqual([
      ['employees_total',0],['available_today',0],['scheduled_today',0],['on_duty_now',0],['open_shifts',0],
      ['understaffed_sites',0],['qualification_gaps',0],['expiring_qualifications',0],['document_issues',0],['active_disruptions',0],
    ]);
    expect(response.body.kpis.every((kpi:{definition?:string})=>typeof kpi.definition==='string'&&kpi.definition.length>0)).toBe(true);
  });

  it('rejects unknown query parameters and out-of-range pagination',async()=>{
    expect((await request(app).get('/api/v1/operations/control-center?unknown=1').set('Cookie',cookie)).status).toBe(400);
    expect((await request(app).get('/api/v1/operations/control-center?page_size=4').set('Cookie',cookie)).status).toBe(400);
    expect((await request(app).get('/api/v1/operations/control-center?page_size=101').set('Cookie',cookie)).status).toBe(400);
  });

  it('denies the aggregate without nsl:read',async()=>{
    activeUser={...baseUser,permissions:['sites:read'],permission_grants:[{code:'sites:read',scope:'tenant'}]};
    expect((await request(app).get('/api/v1/operations/control-center').set('Cookie',cookie)).status).toBe(403);
  });

  it('disables sections without read permission and does not query those tables',async()=>{
    activeUser={...baseUser,permissions:['nsl:read'],permission_grants:[{code:'nsl:read',scope:'tenant'}]};
    const response=await request(app).get('/api/v1/operations/control-center').set('Cookie',cookie);
    expect(response.status).toBe(200);
    expect(response.body.sections).toMatchObject({kpi:true,shifts:false,employees:false,sites:false,
      qualifications:false,documents:false,devices:false,keys:false,measures:false});
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM keys k'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM nfc_devices n'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM operations_measures m'))).toBe(false);
  });

  it('binds site-scoped grants on the server for every section',async()=>{
    activeUser={...baseUser,permission_grants:baseUser.permissions.map(code=>({code,scope:'site'})),site_ids:[site]};
    const response=await request(app).get('/api/v1/operations/control-center?date=2026-11-27').set('Cookie',cookie);
    expect(response.status).toBe(200);
    const siteCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM sites s'));
    expect(siteCall?.[1]).toEqual([tenant,'2026-11-27',[site]]);
    const measureCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM operations_measures m'));
    expect(measureCall?.[1]).toEqual([tenant,[site]]);
  });

  it('validates candidate requests and keeps foreign shifts inaccessible',async()=>{
    expect((await request(app).get('/api/v1/operations/control-center/candidates').set('Cookie',cookie)).status).toBe(400);
    const foreign=await request(app).get(`/api/v1/operations/control-center/candidates?shift_id=${otherSite}`).set('Cookie',cookie);
    expect(foreign.status).toBe(404);
    activeUser={...baseUser,permission_grants:[{code:'scheduling:read',scope:'site'}],site_ids:[otherSite]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('FROM schedule_shifts sh'))return result([{id:site,site_id:site}]);
      return result([]);
    });
    expect((await request(app).get(`/api/v1/operations/control-center/candidates?shift_id=${site}`).set('Cookie',cookie)).status).toBe(403);
  });

  it('lists measures with filters and pagination headers',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT count(*)::text count FROM operations_measures'))return result([{count:'2'}]);
      if(sql.includes('SELECT m.*,s.name site_name'))return result([{id:measure,title:'Prüfung',status:'open',site_id:site}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/operations/measures?q=Prüfung&status=open&module=leitstelle&site_id='+site+'&overdue=true&page=1&page_size=5').set('Cookie',cookie);
    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('2');
    expect(response.headers['x-page-count']).toBe('1');
    expect(response.body).toEqual([expect.objectContaining({id:measure,title:'Prüfung'})]);
    expect((await request(app).get('/api/v1/operations/measures?status=unknown').set('Cookie',cookie)).status).toBe(400);
  });

  it('requires CSRF and replays an idempotent measure creation',async()=>{
    expect((await request(app).post('/api/v1/operations/measures').set('Cookie',cookie).send({title:'Test',module:'leitstelle'})).status).toBe(403);
    const existing={id:measure,title:'Besteht bereits',source_key:'alarm:'+alarm};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM operations_measures WHERE tenant_id'))return result([existing]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/operations/measures').set('Cookie',cookie).set(csrf)
      .send({title:'Test',module:'leitstelle',source_type:'alarm',source_id:alarm,source_key:'alarm:'+alarm});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(existing);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO operations_measures'))).toBe(false);
  });

  it('audits a newly created measure',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('INSERT INTO operations_measures'))return result([{id:measure,title:'Neu'}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/operations/measures').set('Cookie',cookie).set(csrf)
      .send({title:'Neu',module:'leitstelle',client_mutation_id:alarm});
    expect(response.status).toBe(201);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO audit_events'))).toBe(true);
  });

  it('refuses to close a measure while its source is still open',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM operations_measures WHERE tenant_id'))return result([{
        id:measure,tenant_id:tenant,site_id:site,source_type:'alarm',source_id:alarm,status:'open',
      }]);
      if(sql.includes('FROM alarms a'))return result([{id:alarm}]);
      return result([]);
    });
    const response=await request(app).patch(`/api/v1/operations/measures/${measure}`).set('Cookie',cookie).set(csrf).send({status:'done'});
    expect(response.status).toBe(409);
    expect(response.body.reason_code).toBe('source_open');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE operations_measures'))).toBe(false);
  });

  it('closes a measure when the source no longer exists and records the reason',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM operations_measures WHERE tenant_id'))return result([{
        id:measure,tenant_id:tenant,site_id:site,source_type:'alarm',source_id:alarm,status:'in_progress',
      }]);
      if(sql.includes('FROM alarms a'))return result([]);
      if(sql.includes('UPDATE operations_measures'))return result([{id:measure,status:'done'}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{}]);
      return result([]);
    });
    const response=await request(app).patch(`/api/v1/operations/measures/${measure}`).set('Cookie',cookie).set(csrf)
      .send({status:'done',reason:'Alarm ist behoben'});
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('done');
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]).toEqual(expect.arrayContaining([tenant,'operations.measure.status']));
  });

  it('rejects invalid measure ids, foreign sites and reason-only updates',async()=>{
    expect((await request(app).patch('/api/v1/operations/measures/not-a-uuid').set('Cookie',cookie).set(csrf).send({status:'done'})).status).toBe(400);
    activeUser={...baseUser,permission_grants:baseUser.permissions.map(code=>({code,scope:'site'})),site_ids:[otherSite]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM operations_measures WHERE tenant_id'))return result([{id:measure,tenant_id:tenant,site_id:site,status:'open'}]);
      return result([]);
    });
    expect((await request(app).patch(`/api/v1/operations/measures/${measure}`).set('Cookie',cookie).set(csrf).send({status:'done'})).status).toBe(403);
    activeUser=baseUser;
    expect((await request(app).patch(`/api/v1/operations/measures/${measure}`).set('Cookie',cookie).set(csrf).send({reason:'nur Grund'})).status).toBe(400);
  });

  it('denies write access to viewers and to site-scoped users without a site',async()=>{
    activeUser={...baseUser,permissions:baseUser.permissions.filter(code=>code!=='operations_measures:write')};
    expect((await request(app).post('/api/v1/operations/measures').set('Cookie',cookie).set(csrf).send({title:'X',module:'leitstelle'})).status).toBe(403);
    activeUser={...baseUser,permission_grants:[{code:'operations_measures:write',scope:'site'}],site_ids:[site]};
    expect((await request(app).post('/api/v1/operations/measures').set('Cookie',cookie).set(csrf).send({title:'X',module:'leitstelle'})).status).toBe(403);
  });
});
