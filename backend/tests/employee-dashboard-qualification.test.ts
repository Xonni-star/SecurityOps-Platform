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
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const tenant='00000000-0000-4000-8000-000000000010';
const session={id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:['employees:read'],permission_grants:[{code:'employees:read',scope:'tenant'}],
  site_ids:[],is_system_admin:false,session_id:'session-1',csrf_token:'csrf-value',expires_at:'2099-01-01'};

beforeEach(()=>{
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([session]);
    return result([{count:0}]);
  });
});

describe('Mitarbeiter-Dashboard: Qualifikationsbewertung',()=>{
  it('nutzt die zentrale Klassifikation und zählt fehlende Pflichtqualifikationen nur für aktive und Probation',async()=>{
    const response=await request(app).get('/api/v1/employees/dashboard').set('Cookie','securityops_session=session-1');
    expect(response.status).toBe(200);
    const missing=queryMock.mock.calls.find(([sql])=>String(sql).includes('SELECT COUNT(*)::int count FROM qualification_catalog c'));
    expect(missing?.[0]).toContain("(now() AT TIME ZONE 'Europe/Berlin')::date");
    expect(missing?.[0]).toContain("e.employment_status IN ('active','probation')");
    expect(missing?.[0]).toContain('(q.catalog_id IS NULL AND c.code=q.code)');
    expect(missing?.[0]).toContain("s.computed_status='valid'");
  });

  it('verwendet in der Übersicht die zentrale Klassifikation mit Schweregrad statt lokaler Näherungen',async()=>{
    const response=await request(app).get('/api/v1/employees/overview').set('Cookie','securityops_session=session-1');
    expect(response.status).toBe(200);
    const overview=queryMock.mock.calls.find(([sql])=>String(sql).includes('WITH states AS'))?.[0];
    expect(overview).toContain("q.status='invalid' OR c.active=false THEN 'invalid'");
    expect(overview).toContain("'invalid'=ANY(t.qualification_issue_codes) THEN 'ungültig'");
    expect(overview).toContain("'expiring'=ANY(t.qualification_issue_codes) THEN 'läuft bald ab'");
    expect(overview).not.toContain('q.status IN (\'expired\',\'revoked\',\'invalid\')');
  });
});
