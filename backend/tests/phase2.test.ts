import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';
const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock,withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work()}));
const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const user={id:'user-1',tenantId:'tenant-a',email:'operator@example.com',role:'operator',permissions:['alarms:read','alarms:write','patrols:read','patrols:write','alarm_priorities:read']};
beforeEach(()=>queryMock.mockReset());
describe('phase 2 alarm lifecycle',()=>{
  it('creates a panic alarm with the critical priority and history',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}]):sql.includes('SELECT id FROM alarm_priorities')?result([{id:'00000000-0000-0000-0000-000000000001'}]):sql.includes('INSERT INTO alarms')?result([{id:'alarm-1',status:'open',type:'panic'}]):result([{id:'history-1'}]));
    const response=await request(app).post('/api/v1/alarms/panic').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf').send({position:'Gate A'});
    expect(response.status).toBe(201);
    expect(response.body.type).toBe('panic');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO alarm_history'))).toBe(true);
  });
  it('requires an open alarm for acknowledgement and writes the transition',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}]):sql.includes("status='acknowledged'")?result([{id:'alarm-1',status:'acknowledged'}]):result([{id:'history-1'}]));
    const response=await request(app).post('/api/v1/alarms/alarm-1/acknowledge').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf');
    expect(response.status).toBe(200);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("VALUES($1,$2,'open','acknowledged'"))).toBe(true);
  });
});
describe('phase 2 NFC deviation',()=>{
  it('marks an out-of-order scan and creates a medium alarm',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}]):sql.includes('FROM control_points')?result([{id:'00000000-0000-0000-0000-000000000002',site_id:'00000000-0000-0000-0000-000000000003'}]):sql.includes('FROM patrol_route_points')?result([{sequence:1,expected_offset_seconds:0}]):sql.includes('FROM patrol_scans')?result([{sequence:2}]):sql.includes('INSERT INTO patrol_scans')?result([{id:'scan-1',deviation:'out_of_order'}]):sql.includes("code='medium'")?result([{id:'00000000-0000-0000-0000-000000000004'}]):sql.includes('INSERT INTO alarms')?result([{id:'alarm-2'}]):result([{id:'history-2'}]));
    const response=await request(app).post('/api/v1/patrol-routes/00000000-0000-0000-0000-000000000005/scans').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf').send({nfc_uid:'nfc-2',employee_id:'00000000-0000-0000-0000-000000000006'});
    expect(response.status).toBe(201);
    expect(response.body.deviation).toBe('out_of_order');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO alarms'))).toBe(true);
  });
});
