import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock}));
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
      return result([{id:'row-1'}]);
    });
    const response=await request(app).get('/api/v1/nsl/dashboard').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({alarms:[{id:'row-1'}],incidents:[{id:'row-1'}],positions:[{id:'row-1'}],patrols:[{id:'row-1'}]});
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
