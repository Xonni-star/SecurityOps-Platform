import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
}));
const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const session={
  id:'00000000-0000-4000-8000-000000000001',
  tenantId:'00000000-0000-4000-8000-000000000010',
  email:'operator@example.com',
  role:'operator',
  permissions:['scheduling:read','scheduling:write'],
  permission_grants:[{code:'scheduling:read',scope:'site'},{code:'scheduling:write',scope:'site'}],
  site_ids:['00000000-0000-0000-0000-000000000020'],
  is_system_admin:false,
  session_id:'00000000-0000-4000-8000-000000000030',
  csrf_token:'csrf-value',
  expires_at:'2099-01-01',
};
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};

beforeEach(()=>queryMock.mockReset());

describe('dienstplanung authorization and isolation',()=>{
  it('limits site-scoped period reads to assigned sites',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([session]):result([]));
    const response=await request(app).get('/api/v1/scheduling/periods').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM schedule_periods'));
    expect(call?.[0]).toContain('p.site_id = ANY($2::uuid[])');
    expect(call?.[1]).toEqual([session.tenantId,session.site_ids]);
  });
  it('denies a mutation outside the granted site scope',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([session]):result([]));
    const response=await request(app).post('/api/v1/scheduling/periods').set(csrf).send({
      site_id:'00000000-0000-4000-8000-000000000099',
      rule_profile_id:'00000000-0000-4000-8000-000000000040',
      name:'Night',
      starts_at:'2026-11-20T08:00:00Z',
      ends_at:'2026-11-20T18:00:00Z',
      client_mutation_id:'00000000-0000-4000-8000-000000000050',
    });
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO schedule_periods'))).toBe(false);
  });
  it('denies shift assignment when the shift belongs to a site outside the grant',async()=>{
    const outsideSite='00000000-0000-0000-0000-000000000099';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('INSERT INTO sync_receipts'))return result([{id:'receipt-id'}]);
      if(sql.includes('SELECT sh.*'))return result([{id:'shift-id',site_id:outsideSite}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/scheduling/shifts/00000000-0000-4000-8000-000000000060/assignments').set(csrf).send({
      employee_id:'00000000-0000-4000-8000-000000000061',
      client_mutation_id:'00000000-0000-4000-8000-000000000062',
    });
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO schedule_assignments'))).toBe(false);
  });
  it('rejects a direct assignment of an employee without the required qualification',async()=>{
    const future='2099-12-01T08:00:00Z';
    queryMock.mockImplementation(async(sql:string)=>{
      const text=String(sql);
      if(text.includes('FROM sessions'))return result([session]);
      if(text.includes('INSERT INTO sync_receipts'))return result([{id:'receipt-id'}]);
      if(text.includes('SELECT sh.*'))return result([{id:'shift-id',site_id:session.site_ids[0],starts_at:future,ends_at:'2099-12-01T16:00:00Z',period_id:'period-1',period_status:'published',required_qualification_codes:['sachkunde_34a']}]);
      if(text.includes('SELECT id FROM employees'))return result([{id:'00000000-0000-4000-8000-000000000061'}]);
      if(text.includes('SELECT id,name,employment_status,hire_date,termination_date'))return result([{
        id:'00000000-0000-4000-8000-000000000061',name:'Ohne Qualifikation',employment_status:'active',hire_date:null,termination_date:null,
      }]);
      if(text.includes('SELECT starts_on,ends_on FROM employee_object_assignments'))return result([{starts_on:'2026-01-01',ends_on:null}]);
      if(text.includes('SELECT c.code FROM site_qualification_requirements'))return result([{code:'sachkunde_34a'}]);
      if(text.includes('SELECT r.parameters'))return result([{parameters:{}}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/scheduling/shifts/00000000-0000-4000-8000-000000000060/assignments').set(csrf).send({
      employee_id:'00000000-0000-4000-8000-000000000061',
      client_mutation_id:'00000000-0000-4000-8000-000000000062',
    });
    expect(response.status).toBe(409);
    expect(response.body.reason_code).toBe('qualification_missing');
    expect(response.body.error).toContain('Erforderliche Qualifikation');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO schedule_assignments'))).toBe(false);
  });

  it('filters conflict findings by the granted sites',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([session]):result([]));
    const response=await request(app).get('/api/v1/scheduling/conflicts').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM schedule_conflicts'));
    expect(call?.[0]).toContain('p.site_id = ANY($2::uuid[])');
    expect(call?.[1]).toEqual([session.tenantId,session.site_ids]);
  });
});
