import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock,withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work()}));
const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const user={id:'00000000-0000-0000-0000-000000000001',tenantId:'00000000-0000-0000-0000-000000000010',email:'operator@example.com',role:'operator',permissions:['nfc_devices:read','nfc_devices:write']};
const session={...user,session_id:'session-1',csrf_token:'csrf-value',expires_at:'2099-01-01'};
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};

beforeEach(()=>queryMock.mockReset());

describe('NFC device management',()=>{
  it('registers a tenant-scoped NFC device assigned to a control point',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM control_points'))return result([{id:'00000000-0000-0000-0000-000000000020'}]);
      if(sql.includes('INSERT INTO nfc_devices'))return result([{id:'nfc-1',identifier:'TAG-001',status:'active'}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/nfc-devices').set(csrf).send({
      identifier:'TAG-001',device_type:'tag',manufacturer:'Acme',control_point_id:'00000000-0000-0000-0000-000000000020',
    });
    expect(response.status).toBe(201);expect(response.body.identifier).toBe('TAG-001');
  });

  it('rejects multiple assignment targets',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([session]):result([]));
    const response=await request(app).post('/api/v1/nfc-devices').set(csrf).send({
      identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',
      employee_id:'00000000-0000-0000-0000-000000000021',site_id:'00000000-0000-0000-0000-000000000022',
    });
    expect(response.status).toBe(400);
  });

  it('reports duplicate NFC identifiers with a field error',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('SELECT id FROM nfc_devices'))return result([{id:'existing'}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/nfc-devices').set(csrf).send({
      identifier:'TAG-001',device_type:'tag',manufacturer:'Acme',
    });
    expect(response.status).toBe(409);
    expect(response.body.fields.identifier).toContain('bereits vergeben');
  });

  it('refuses status changes through the generic patch endpoint',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([session]):result([]));
    const response=await request(app).patch('/api/v1/nfc-devices/00000000-0000-0000-0000-000000000020').set(csrf)
      .send({status:'blocked'});
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE nfc_devices'))).toBe(false);
  });

  it('protects devices with scan history from deletion',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('SELECT identifier FROM nfc_devices'))return result([{identifier:'TAG-001'}]);
      if(sql.includes('scans,'))return result([{scans:1,replacements:0}]);
      return result([]);
    });
    const response=await request(app).delete('/api/v1/nfc-devices/00000000-0000-0000-0000-000000000020').set(csrf);
    expect(response.status).toBe(409);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('DELETE FROM nfc_devices'))).toBe(false);
  });
});
