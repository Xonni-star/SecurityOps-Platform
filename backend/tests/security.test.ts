import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
const loginMock=jest.fn();
const logoutMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({query:queryMock,withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work()}));
jest.unstable_mockModule('../src/services/auth.js',()=>({login:loginMock,logout:logoutMock}));

const {app}=await import('../src/app.js');
const {authenticateWebSocketRequest}=await import('../src/ws-auth.js');

const sessionUser={id:'user-1',tenantId:'tenant-a',email:'admin@example.com',role:'admin',permissions:['employees:read'],session_id:'s-1',csrf_token:'csrf-value',expires_at:'2099-01-01'};
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);

beforeEach(()=>{queryMock.mockReset();loginMock.mockReset();logoutMock.mockReset();});

describe('session authentication and CSRF',()=>{
  it('sets opaque httpOnly session and readable CSRF cookies on login',async()=>{
    loginMock.mockResolvedValue({sessionId:'opaque-session',csrfToken:'csrf-value',user:{id:'user-1',tenantId:'tenant-a',email:'admin@example.com',role:'admin',permissions:[]}});
    const response=await request(app).post('/api/v1/auth/login').send({email:'admin@example.com',password:'password',device_id:'11111111-1111-4111-8111-111111111111'});
    expect(response.status).toBe(200);
    const cookies=response.headers['set-cookie'] as string[];
    expect(cookies).toEqual(expect.arrayContaining([expect.stringContaining('securityops_session=opaque-session;'),expect.stringContaining('securityops_csrf=csrf-value;')]));
    expect(cookies.find((cookie:string)=>cookie.startsWith('securityops_session='))).toContain('HttpOnly');
    expect(cookies.find((cookie:string)=>cookie.startsWith('securityops_csrf='))).not.toContain('HttpOnly');
    expect(response.body).not.toHaveProperty('sessionId');
    expect(response.body).not.toHaveProperty('csrfToken');
  });

  it('rejects state-changing requests from an unlisted origin',async()=>{
    loginMock.mockResolvedValue({sessionId:'opaque-session',csrfToken:'csrf-value',user:{id:'user-1',tenantId:'tenant-a',email:'admin@example.com',role:'admin',permissions:[]}});
    const response=await request(app).post('/api/v1/auth/login').set('Origin','https://evil.example').send({email:'admin@example.com',password:'password'});
    expect(response.status).toBe(403);
  });

  it('rejects offline mutations when the bound device or session is no longer active',async()=>{
    queryMock.mockResolvedValue({rows:[],rowCount:0});
    const response=await request(app).post('/api/v1/alarms/panic')
      .set('Cookie','securityops_session=revoked-session; securityops_csrf=csrf-value')
      .set('x-csrf-token','csrf-value')
      .send({description:'offline event'});
    expect(response.status).toBe(401);
    expect(queryMock.mock.calls[0][0]).toContain("d.revoked_at IS NULL");
    expect(queryMock.mock.calls[0][0]).toContain('s.revoked_at IS NULL');
  });

  it('does not accept a client-supplied tenant during device registration',async()=>{
    const response=await request(app).post('/api/v1/auth/login')
      .send({email:'admin@example.com',password:'password',device_id:'11111111-1111-4111-8111-111111111111',tenant_id:'tenant-b'});
    expect(response.status).toBe(400);
    expect(loginMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('requires the session-bound CSRF token for logout',async()=>{
    queryMock.mockResolvedValue(result([sessionUser]));
    const denied=await request(app).post('/api/v1/auth/logout').set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value']).set('x-csrf-token','wrong');
    expect(denied.status).toBe(403);
    const accepted=await request(app).post('/api/v1/auth/logout').set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value']).set('x-csrf-token','csrf-value');
    expect(accepted.status).toBe(204);
    expect(logoutMock).toHaveBeenCalledWith('opaque');
  });
});

describe('permission and tenant enforcement',()=>{
  it('denies a session without the resource permission',async()=>{
    queryMock.mockResolvedValue(result([{...sessionUser,permissions:[]}])) ;
    const response=await request(app).get('/api/v1/employees').set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid CRUD input with the uniform error shape',async()=>{
    queryMock.mockResolvedValue(result([{...sessionUser,permissions:['employees:write']}])) ;
    const response=await request(app).post('/api/v1/employees').set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value']).set('x-csrf-token','csrf-value').send({name:'',email:'not-an-email',unexpected:'rejected'});
    expect(response.status).toBe(400);
    expect(response.body).toEqual({error:'Invalid request'});
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('passes the authenticated tenant to CRUD queries',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([sessionUser]):result([{id:'employee-1',tenant_id:'tenant-a',name:'Ava'}]));
    const response=await request(app).get('/api/v1/employees').set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    const crudCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('SELECT * FROM employees'));
    expect(crudCall?.[1]).toEqual(['tenant-a']);
    expect(response.body[0].tenant_id).toBe('tenant-a');
  });
});

describe('WebSocket authentication',()=>{
  it('authenticates using the session cookie and never a URL token',async()=>{
    queryMock.mockResolvedValue(result([sessionUser]));
    const authenticated=await authenticateWebSocketRequest({headers:{cookie:'securityops_session=opaque'}} as never);
    expect(authenticated?.tenantId).toBe('tenant-a');
    expect(queryMock.mock.calls[0][1]).toHaveLength(1);
    const unauthenticated=await authenticateWebSocketRequest({headers:{cookie:''}} as never);
    expect(unauthenticated).toBeNull();
  });

  it('applies the same origin allowlist to WebSocket handshakes',async()=>{
    queryMock.mockResolvedValue(result([sessionUser]));
    const allowed=await authenticateWebSocketRequest({headers:{origin:'http://localhost:5173',cookie:'securityops_session=opaque'}} as never);
    expect(allowed?.id).toBe('user-1');
    const denied=await authenticateWebSocketRequest({headers:{origin:'https://evil.example',cookie:'securityops_session=opaque'}} as never);
    expect(denied).toBeNull();
  });
});
