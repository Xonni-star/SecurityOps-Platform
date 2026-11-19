import {describe,it,expect,beforeEach,vi} from 'vitest';
import request from 'supertest';
import type {QueryResult} from 'pg';

const queryMock=vi.hoisted(()=>vi.fn());
const loginMock=vi.hoisted(()=>vi.fn());
const logoutMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/db/pool.js',()=>({query:queryMock}));
vi.mock('../src/services/auth.js',()=>({login:loginMock,logout:logoutMock}));

import {app} from '../src/app.js';
import {authenticateWebSocketRequest} from '../src/ws-auth.js';

const sessionUser={id:'user-1',tenantId:'tenant-a',email:'admin@example.com',role:'admin',permissions:['employees:read'],session_id:'s-1',csrf_token:'csrf-value',expires_at:'2099-01-01'};
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);

beforeEach(()=>{queryMock.mockReset();loginMock.mockReset();logoutMock.mockReset();});

describe('session authentication and CSRF',()=>{
  it('sets opaque httpOnly session and readable CSRF cookies on login',async()=>{
    loginMock.mockResolvedValue({sessionId:'opaque-session',csrfToken:'csrf-value',user:{id:'user-1',tenantId:'tenant-a',email:'admin@example.com',role:'admin',permissions:[]}});
    const response=await request(app).post('/api/v1/auth/login').send({email:'admin@example.com',password:'password'});
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('securityops_session=opaque-session; Path=/; HttpOnly'),expect.stringContaining('securityops_csrf=csrf-value; Path=/')]));
    expect(response.headers['set-cookie'].find((cookie:string)=>cookie.startsWith('securityops_csrf='))).not.toContain('HttpOnly');
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
});
