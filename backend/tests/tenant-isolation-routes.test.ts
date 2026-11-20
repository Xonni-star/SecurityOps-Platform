import request from 'supertest';
import {describe,expect,it,jest,beforeEach} from '@jest/globals';
import type {QueryResult} from 'pg';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {app}=await import('../src/app.js');

const sessionUser={
  id:'00000000-0000-4000-8000-000000000001',
  tenantId:'00000000-0000-4000-8000-00000000000a',
  email:'admin@example.invalid',
  role:'admin',
  permissions:['customer_reports:export','dms:read','account_security:manage','push_subscriptions:write'],
  permission_grants:[],
  site_ids:['00000000-0000-4000-8000-0000000000aa'],
  is_system_admin:false,
  session_id:'00000000-0000-4000-8000-0000000000ab',
  csrf_token:'csrf-value',
  expires_at:'2099-01-01',
  device_id:'00000000-0000-4000-8000-0000000000ac',
};

const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

beforeEach(()=>{
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([sessionUser]):result([]));
});

describe('route-level tenant isolation',()=>{
  it('rejects a report export for a site outside the authenticated tenant scope',async()=>{
    const response=await request(app).get('/api/v1/customer-reports/alarms')
      .query({site_id:'00000000-0000-4000-8000-0000000000bb',format:'csv'})
      .set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM alarms'))).toBe(false);
  });

  it('does not resolve a DMS document addressed through another tenant',async()=>{
    const response=await request(app).get('/api/v1/dms/documents/00000000-0000-4000-8000-0000000000bd/versions/00000000-0000-4000-8000-0000000000be/download')
      .set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(404);
    const dmsCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM dms_documents'));
    expect(dmsCall?.[1]).toEqual([sessionUser.tenantId,'00000000-0000-4000-8000-0000000000bd','00000000-0000-4000-8000-0000000000be']);
  });

  it('cannot administer a user from another tenant',async()=>{
    const response=await request(app).post('/api/v1/auth/lockout/accounts/00000000-0000-4000-8000-0000000000bf/lock')
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({reason:'cross tenant negative test'});
    expect(response.status).toBe(404);
    const lockCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('locked_permanently=true'));
    expect(lockCall?.[1]).toEqual([sessionUser.tenantId,'00000000-0000-4000-8000-0000000000bf']);
  });

  it('does not accept a client tenant on offline push subscription writes',async()=>{
    const response=await request(app).post('/api/v1/push-subscriptions')
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({
        tenant_id:'00000000-0000-4000-8000-0000000000bb',
        endpoint:'https://push.example.invalid/subscription',
        keys:{p256dh:'public-key',auth:'auth-key'},
      });
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO push_subscriptions'))).toHaveLength(0);
  });
});
