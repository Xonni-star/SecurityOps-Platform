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
const site='00000000-0000-4000-8000-0000000000aa';
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const allGrants=['sites:read','devices:read','dms:read','watchbook:read','scheduling:read','employees:read','customers:read','keys:read','alarms:read','incidents:read','handover:read'].map(code=>({code,scope:'site'}));
const baseUser={
  id:'00000000-0000-4000-8000-000000000009',tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:allGrants.map(grant=>grant.code),permission_grants:allGrants,site_ids:[site],is_system_admin:false,
  session_id:'00000000-0000-4000-8000-0000000000ac',csrf_token:'csrf-value',expires_at:'2099-01-01',
};
let activeUser:Record<string,unknown>;

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=baseUser;
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('WITH audit_source AS'))return result([{
      id:'event-1',site_id:site,occurred_at:'2026-11-24T10:00:00Z',event_kind:'maintenance_order.completed',
      entity_type:'maintenance_order',entity_id:'order-1',actor_user_id:'00000000-0000-4000-8000-000000000009',
      actor_employee_id:null,source_table:'audit_events',summary:'MAIN-2026-000042',details:{},
      actor_email:'admin@example.invalid',actor_employee_name:null,
    }]);
    return result([]);
  });
});

describe('object chronicle',()=>{
  const path=`/api/v1/sites/${site}/chronicle`;

  it('returns deduplicated real events newest first with categories',async()=>{
    const response=await request(app).get(path).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.site_id).toBe(site);
    expect(response.body.events[0]).toMatchObject({event_kind:'maintenance_order.completed',category:'Technik & Wartung'});
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('WITH audit_source AS'));
    expect(String(call?.[0])).toContain('DISTINCT ON (event_kind,entity_id,occurred_at)');
    expect(String(call?.[0])).toContain('ORDER BY d.occurred_at DESC,d.id DESC LIMIT');
    expect(call?.[1]?.[2]).toEqual(expect.arrayContaining(['maintenance_order.%']));
  });

  it('applies type and period filters server-side',async()=>{
    const response=await request(app).get(`${path}?type=dms.document.approved&from=2026-11-01&to=2026-12-01&limit=25`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('WITH audit_source AS'));
    expect(call?.[1]?.[3]).toBe('2026-11-01T00:00:00Z');
    expect(call?.[1]?.[4]).toBe('2026-12-01T00:00:00Z');
    expect(call?.[1]?.[5]).toBe(25);
    expect(call?.[1]?.[6]).toEqual(['dms.document.approved']);
  });

  it('excludes event kinds whose source permission is missing',async()=>{
    activeUser={...baseUser,permissions:['sites:read'],permission_grants:[{code:'sites:read',scope:'site'}]};
    const response=await request(app).get(path).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('WITH audit_source AS'));
    expect(call?.[1]?.[2]).not.toEqual(expect.arrayContaining(['maintenance_order.%']));
  });

  it('rejects a site outside the granted scope',async()=>{
    activeUser={...baseUser,site_ids:['00000000-0000-4000-8000-0000000000ff']};
    const response=await request(app).get(path).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('WITH audit_source AS'))).toBe(false);
  });

  it('rejects malformed date filters',async()=>{
    const response=await request(app).get(`${path}?from=last-week`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(400);
  });
});
