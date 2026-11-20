import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
const listWorkTimes=jest.fn(async()=>[{externalId:'shift-1',employeeEmail:'worker@example.com',startedAt:'2026-11-19T08:00:00Z',endedAt:'2026-11-19T16:00:00Z',minutes:480}]);
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock,withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work()}));
jest.unstable_mockModule('../src/services/timescan.js',()=>({createTimeScanAdapter:jest.fn(()=>({listWorkTimes}))}));
const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const user={id:'00000000-0000-0000-0000-000000000001',tenantId:'00000000-0000-0000-0000-000000000010',email:'admin@example.com',role:'admin',permissions:['reports:read','timescan:read','timescan:write','audit:read','privacy:write','backup:read','providers:read']};
const session={...user,session_id:'session-1',csrf_token:'csrf-value',expires_at:'2099-01-01'};
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};

beforeEach(()=>{queryMock.mockReset();process.env.TIMESCAN_TEST_SECRET='secret';});

describe('phase 5 reporting',()=>{
  it('returns filtered statistics',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM alarms'))return result([{total:2,resolved:1,open:1}]);
      if(sql.includes('FROM incidents'))return result([{total:1,completed:1}]);
      if(sql.includes('FROM patrol_scans'))return result([{total:3,deviations:1}]);
      if(sql.includes('FROM work_time_entries'))return result([{minutes:480,entries:1}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/reports/statistics?from=2026-11-01&to=2026-11-30').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);expect(response.body.alarms.open).toBe(1);
  });

  it('exports a tenant-scoped employee report',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM employees'))return result([{id:'employee-1',name:'Worker'}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/reports/employees?format=csv').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);expect(response.text).toContain('employee-1');
  });
});

describe('phase 5 TimeScan and privacy',()=>{
  it('reports provider status without treating unconfigured providers as verified',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/admin/provider-status').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({provider:'smtp',status:'not_configured'}),
      expect.objectContaining({provider:'sms',status:'not_configured'}),
      expect.objectContaining({provider:'timescan',status:'not_configured'}),
    ]));
    expect(response.body.providers.some((provider:{status:string})=>provider.status==='verified')).toBe(false);
  });

  it('syncs work time idempotently through the adapter',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM timescan_connections'))return result([{id:'connection-1',base_url:'https://timescan.test',account_ref:'acct',secret_ref:'TIMESCAN_TEST_SECRET',enabled:true}]);
      if(sql.includes('INSERT INTO timescan_sync_runs'))return result([{id:'run-1'}]);
      if(sql.includes('FROM employees'))return result([{id:'employee-1'}]);
      if(sql.includes('INSERT INTO work_time_entries'))return result([{id:'entry-1'}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/timescan/sync?from=2026-11-01&to=2026-11-30').set(csrf);
    expect(response.status).toBe(200);expect(response.body.imported_count).toBe(1);expect(listWorkTimes).toHaveBeenCalled();
  });

  it('exports a data subject record with permission protection',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('SELECT id,email,role'))return result([{id:user.id,email:user.email,role:user.role}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/privacy/export').set(csrf).send({user_id:user.id});
    expect(response.status).toBe(200);expect(response.body.user.email).toBe(user.email);
  });
});
