import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock,withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work()}));
const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const user={id:'00000000-0000-0000-0000-000000000001',tenantId:'00000000-0000-0000-0000-000000000010',email:'operator@example.com',role:'operator',permissions:['nsl:read','nsl:write','reports:read','messages:read','messages:write','notifications:read','notifications:write']};
const session={...user,session_id:'session-1',csrf_token:'csrf-value',expires_at:'2099-01-01'};
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};

beforeEach(()=>queryMock.mockReset());

describe('phase 4 NSL and reports',()=>{
  it('returns consolidated dashboard data',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('COUNT(*) FILTER'))return result([{
        unacknowledged_alarms:2,critical_alarms:1,acknowledged_alarms:3,escalated_alarms:1,
        open_alarms:6,active_incidents:2,on_duty_resources:4,assigned_resources:1,
        open_handovers:1,technical_issues:1,
      }]);
      return result([{id:'row-1'}]);
    });
    const response=await request(app).get('/api/v1/nsl/dashboard').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.alarms).toEqual([{id:'row-1'}]);
    expect(response.body.incidents).toEqual([{id:'row-1'}]);
    expect(response.body.positions).toEqual([{id:'row-1'}]);
    expect(response.body.patrols).toEqual([{id:'row-1'}]);
    expect(response.body.summary).toEqual({
      unacknowledged_alarms:2,critical_alarms:1,acknowledged_alarms:3,escalated_alarms:1,
      open_alarms:6,active_incidents:2,on_duty_resources:4,assigned_resources:1,
      open_handovers:1,technical_issues:1,
    });
    expect(response.body.last_updated_at).toEqual(expect.any(String));
  });

  it('exports alarm reports as CSV',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM alarms'))return result([{id:'alarm-1',status:'open',description:'Test'}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/reports/alarms?format=csv').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('alarm-1');
  });
});

describe('phase 4 communications',()=>{
  it('sends and lists a direct message',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('SELECT id FROM users'))return result([{id:'00000000-0000-0000-0000-000000000002'}]);
      if(sql.includes('INSERT INTO direct_messages'))return result([{id:'message-1',body:'Hello'}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/messages').set(csrf).send({recipient_user_id:'00000000-0000-0000-0000-000000000002',body:'Hello'});
    expect(response.status).toBe(201);
    expect(response.body.id).toBe('message-1');
  });

  it('creates and acknowledges a shift handover',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([session]);
      if(sql.includes('FROM alarms'))return result([]);
      if(sql.includes('FROM incidents'))return result([]);
      if(sql.includes('INSERT INTO shift_handovers'))return result([{id:'handover-1',status:'open'}]);
      if(sql.includes('UPDATE shift_handovers'))return result([{id:'handover-1',status:'acknowledged'}]);
      return result([]);
    });
    const created=await request(app).post('/api/v1/handovers').set(csrf).send({notes:'Night shift'});
    expect(created.status).toBe(201);
    const acknowledged=await request(app).post('/api/v1/handovers/handover-1/acknowledge').set(csrf);
    expect(acknowledged.status).toBe(200);
  });
});
