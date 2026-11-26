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
  it('keeps acknowledgement and history atomic when the history write fails',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}]);
      if(sql.includes("status='acknowledged'"))return result([{id:'alarm-1',status:'acknowledged'}]);
      throw new Error('history unavailable');
    });
    const response=await request(app).post('/api/v1/alarms/alarm-1/acknowledge').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf');
    expect(response.status).toBe(500);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("VALUES($1,$2,'open','acknowledged'"))).toBe(true);
  });
});
describe('phase 2 NFC deviation',()=>{
  it('marks an out-of-order scan and creates a medium alarm',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}])
      :sql.includes('FROM patrol_routes')?result([{id:'00000000-0000-0000-0000-000000000005',site_id:'00000000-0000-0000-0000-000000000003'}])
      :sql.includes('FROM control_points')?result([{id:'00000000-0000-0000-0000-000000000002',site_id:'00000000-0000-0000-0000-000000000003'}])
      :sql.includes('FROM nfc_devices')?result([{id:'00000000-0000-0000-0000-000000000007',status:'active',control_point_id:'00000000-0000-0000-0000-000000000002'}])
      :sql.includes('FROM patrol_assignments')?result([{id:'assignment-1'}])
      :sql.includes('FROM patrol_route_points')?result([{sequence:1,expected_offset_seconds:0}])
      :sql.includes('FROM patrol_scans')?result([{sequence:2}])
      :sql.includes('INSERT INTO patrol_scans')?result([{id:'scan-1',deviation:'out_of_order'}])
      :sql.includes("code='medium'")?result([{id:'00000000-0000-0000-0000-000000000004'}])
      :sql.includes('INSERT INTO alarms')?result([{id:'alarm-2'}])
      :result([{id:'history-2'}]));
    const response=await request(app).post('/api/v1/patrol-routes/00000000-0000-0000-0000-000000000005/scans').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf').send({nfc_uid:'nfc-2',employee_id:'00000000-0000-0000-0000-000000000006'});
    expect(response.status).toBe(201);
    expect(response.body.deviation).toBe('out_of_order');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO alarms'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("patrol.scan.recorded"))).toBe(true);
  });

  it('rejects a scan when the employee has no active route assignment',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}])
      :sql.includes('FROM patrol_routes')?result([{id:'route-1',site_id:'site-1'}])
      :sql.includes('FROM control_points')?result([{id:'point-1',site_id:'site-1'}])
      :sql.includes('FROM nfc_devices')?result([{id:'tag-1',status:'active',control_point_id:'point-1'}])
      :sql.includes('FROM patrol_assignments')?result([])
      :result([]));
    const response=await request(app).post('/api/v1/patrol-routes/00000000-0000-0000-0000-000000000005/scans').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf').send({nfc_uid:'nfc-2',employee_id:'00000000-0000-0000-0000-000000000006'});
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO patrol_scans'))).toBe(false);
  });

  it('rejects an inactive registered tag before persisting a scan',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}])
      :sql.includes('FROM patrol_routes')?result([{id:'route-1',site_id:'site-1'}])
      :sql.includes('FROM control_points')?result([{id:'point-1',site_id:'site-1'}])
      :sql.includes('FROM nfc_devices')?result([{id:'tag-1',status:'blocked',control_point_id:'point-1'}])
      :result([]));
    const response=await request(app).post('/api/v1/patrol-routes/00000000-0000-0000-0000-000000000005/scans').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf').send({nfc_uid:'nfc-2',employee_id:'00000000-0000-0000-0000-000000000006'});
    expect(response.status).toBe(409);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO patrol_scans'))).toBe(false);
  });

  it('audits rejected scans with the NFC uid and machine-readable reason',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}])
      :sql.includes('FROM patrol_routes')?result([{id:'route-1',site_id:'site-1'}])
      :sql.includes('FROM control_points')?result([{id:'point-1',site_id:'site-1'}])
      :sql.includes('FROM nfc_devices')?result([])
      :result([]));
    const response=await request(app).post('/api/v1/patrol-routes/00000000-0000-0000-0000-000000000005/scans').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf').send({nfc_uid:'nfc-2',employee_id:'00000000-0000-0000-0000-000000000006'});
    expect(response.status).toBe(404);
    const audit=queryMock.mock.calls.find(([sql,values])=>String(sql).includes('INSERT INTO audit_events')
      && String((values as unknown[])?.[2])==='patrol.scan.rejected');
    expect(audit).toBeDefined();
    expect((audit?.[1] as unknown[])?.[5]).toEqual(expect.objectContaining({
      nfc_uid:'nfc-2',scan_authentication:'uid_registered',code:'NFC_TAG_UNREGISTERED',reason:expect.stringContaining('nicht registriert'),
    }));
  });

  it('rejects tags assigned to another site for the same control point UID',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}])
      :sql.includes('FROM patrol_routes')?result([{id:'route-1',site_id:'site-1'}])
      :sql.includes('FROM control_points')?result([{id:'point-1',site_id:'site-1'}])
      :sql.includes('FROM nfc_devices')?result([{id:'tag-1',status:'active',control_point_id:'point-1',site_id:'site-2'}])
      :result([]));
    const response=await request(app).post('/api/v1/patrol-routes/00000000-0000-0000-0000-000000000005/scans').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf').send({nfc_uid:'nfc-2',employee_id:'00000000-0000-0000-0000-000000000006'});
    expect(response.status).toBe(409);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO patrol_scans'))).toBe(false);
  });

  it('rejects archived tags before persisting a scan or counting it as successful',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}])
      :sql.includes('FROM patrol_routes')?result([{id:'route-1',site_id:'site-1'}])
      :sql.includes('FROM control_points')?result([{id:'point-1',site_id:'site-1'}])
      :sql.includes('FROM nfc_devices')?result([{id:'tag-1',status:'active',archived_at:'2026-11-26',control_point_id:'point-1'}])
      :result([]));
    const response=await request(app).post('/api/v1/patrol-routes/00000000-0000-0000-0000-000000000005/scans').set('Cookie',['securityops_session=s','securityops_csrf=csrf']).set('x-csrf-token','csrf').send({nfc_uid:'nfc-2',employee_id:'00000000-0000-0000-0000-000000000006',scanned_at:'2026-11-26T10:00:00.000Z'});
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('archiviert');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO patrol_scans'))).toBe(false);
    const audit=queryMock.mock.calls.find(([sql,values])=>String(sql).includes('INSERT INTO audit_events')
      && String((values as unknown[])?.[2])==='patrol.scan.rejected');
    expect((audit?.[1] as unknown[])?.[5]).toEqual(expect.objectContaining({
      nfc_uid:'nfc-2',nfc_device_id:'tag-1',site_id:'site-1',control_point_id:'point-1',scan_authentication:'uid_registered',
      scanned_at:'2026-11-26T10:00:00.000Z',code:'NFC_TAG_ARCHIVED',reason:expect.stringContaining('archiviert'),
    }));
  });

  it('prevents duplicate active NFC UIDs on control points',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([{...user,session_id:'s',csrf_token:'csrf',expires_at:'2099-01-01'}])
      :sql.includes('SELECT id FROM control_points')?result([{id:'point-1'}])
      :result([]));
    const response=await request(app).post('/api/v1/control-points').set('Cookie',['securityops_session=s','securityops_csrf=csrf'])
      .set('x-csrf-token','csrf').send({site_id:'00000000-0000-0000-0000-000000000003',name:'Doppelter Punkt',nfc_uid:'nfc-2',sequence:1});
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('bereits');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO control_points'))).toBe(false);
  });
});
