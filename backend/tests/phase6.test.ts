import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock}));
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
});
