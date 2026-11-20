import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock,withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work()}));
const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const user={id:'00000000-0000-0000-0000-000000000001',tenantId:'00000000-0000-0000-0000-000000000010',email:'operator@example.com',role:'operator',permissions:['telemetry:read','telemetry:write','positions:read','positions:write','incidents:read','incidents:write','alarms:read','alarms:write']};
const session={...user,session_id:'session-1',csrf_token:'csrf-value',expires_at:'2099-01-01'};
const cookies=['securityops_session=session-1','securityops_csrf=csrf-value'];
const csrf={Cookie:cookies,'x-csrf-token':'csrf-value'};

beforeEach(()=>queryMock.mockReset());

describe('telemetry and positions',()=>{
  it('ingests a fall and creates a critical alarm through Phase 2',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM devices'))return result([{id:'00000000-0000-0000-0000-000000000020'}]);
      if(sql.includes('INSERT INTO sensor_events'))return result([{id:'event-1',sensor_type:'fall',value:1}]);
      if(sql.includes('FROM sensor_thresholds'))return result([{threshold:1,priority_code:'critical',enabled:true}]);
      if(sql.includes('FROM alarms'))return result([]);
      if(sql.includes("code=$2"))return result([{id:'00000000-0000-0000-0000-000000000030'}]);
      if(sql.includes('INSERT INTO alarms'))return result([{id:'alarm-1',type:'sensor_fall',status:'open'}]);
      return result([{id:'history-1'}]);
    });
    const response=await request(app).post('/api/v1/telemetry').set(csrf).send({device_id:'00000000-0000-0000-0000-000000000020',sensor_type:'fall',value:1});
    expect(response.status).toBe(201);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO alarms'))).toBe(true);
  });

  it('ingests positions and publishes a position record',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM devices'))return result([{id:'00000000-0000-0000-0000-000000000020'}]);
      if(sql.includes('INSERT INTO device_positions'))return result([{id:'position-1',latitude:50.1,longitude:8.6}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/positions').set(csrf).send({device_id:'00000000-0000-0000-0000-000000000020',latitude:50.1,longitude:8.6,accuracy_m:4});
    expect(response.status).toBe(201);
    expect(response.body.latitude).toBe(50.1);
  });
});

describe('incident lifecycle',()=>{
  it('creates an incident and moves it through the operational lifecycle',async()=>{
    let current='initiated';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('INSERT INTO incidents'))return result([{id:'00000000-0000-0000-0000-000000000040',status:'initiated',description:'Assist'}]);
      if(sql.includes('SELECT status FROM incidents'))return result([{status:current}]);
      if(sql.includes('UPDATE incidents')){current='en_route';return result([{id:'00000000-0000-0000-0000-000000000040',status:current}]);}
      return result([{id:'history-1'}]);
    });
    const created=await request(app).post('/api/v1/incidents').set(csrf).send({priority_id:'00000000-0000-0000-0000-000000000030',description:'Assist'});
    expect(created.status).toBe(201);
    const moved=await request(app).post('/api/v1/incidents/00000000-0000-0000-0000-000000000040/status').set(csrf).send({status:'en_route'});
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe('en_route');
  });
});
