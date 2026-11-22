import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
const transactionQueryMock=jest.fn();
const auditMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTenantContext:async (_tenantId:string,work:()=>Promise<unknown>)=>work(),
  withTransaction:async (work:(client:{query:typeof transactionQueryMock})=>Promise<unknown>)=>work({query:transactionQueryMock}),
}));
jest.unstable_mockModule('../src/services/audit.js',()=>({recordAudit:auditMock}));

const {listAuthenticatedSessions,registerAuthenticatedDevice,revokeAuthenticatedDevice,revokeAuthenticatedSession}=await import('../src/services/devices.js');

beforeEach(()=>{queryMock.mockReset();transactionQueryMock.mockReset();auditMock.mockReset();});

describe('authenticated device binding',()=>{
  it('registers a tenant-owned device and binds the new session',async()=>{
    transactionQueryMock
      .mockResolvedValueOnce({rows:[{id:'device-1',tenant_id:'tenant-a',metadata:{platform:'Mac'},revoked_at:null}]})
      .mockResolvedValueOnce({rows:[]});
    const result=await registerAuthenticatedDevice('tenant-a','user-a','device-1',{platform:'Mac'},'session-hash','csrf',8);
    expect(result.id).toBe('device-1');
    expect(transactionQueryMock.mock.calls[0][0]).toContain("device_kind='authenticated'");
    expect(transactionQueryMock.mock.calls[1][0]).toContain('INSERT INTO sessions');
    expect(transactionQueryMock.mock.calls[1][1]).toEqual(['tenant-a','user-a','device-1','session-hash','csrf',8]);
  });

  it('revokes the device and all active sessions in one transaction',async()=>{
    transactionQueryMock
      .mockResolvedValueOnce({rows:[{id:'device-1',revoked_at:'now'}]})
      .mockResolvedValueOnce({rowCount:2,rows:[]});
    await expect(revokeAuthenticatedDevice('tenant-a','device-1','admin-a')).resolves.toMatchObject({sessionsRevoked:2});
    expect(transactionQueryMock.mock.calls[0][0]).toContain('SET revoked_at=now()');
    expect(transactionQueryMock.mock.calls[1][0]).toContain('UPDATE sessions SET revoked_at=now()');
    expect(auditMock).toHaveBeenCalledWith('tenant-a','admin-a','authenticated_device.revoked','device','device-1',{sessionsRevoked:2});
  });

  it('lists tenant sessions without exposing session tokens',async()=>{
    queryMock.mockResolvedValueOnce({rows:[{id:'session-1',email:'admin@example.com',role:'admin',device_id:'device-1',device_name:'Authenticated device',metadata:{platform:'Mac'},created_at:'now',last_seen_at:'now',expires_at:'later',revoked_at:null}]});
    await expect(listAuthenticatedSessions('tenant-a')).resolves.toHaveLength(1);
    expect(queryMock.mock.calls[0][0]).not.toContain('token_hash');
  });

  it('revokes one session and records an audit event',async()=>{
    transactionQueryMock.mockResolvedValueOnce({rows:[{id:'session-1'}]});
    await expect(revokeAuthenticatedSession('tenant-a','session-1','admin-a')).resolves.toEqual({id:'session-1'});
    expect(transactionQueryMock.mock.calls[0][0]).toContain('UPDATE sessions SET revoked_at=now()');
    expect(auditMock).toHaveBeenCalledWith('tenant-a','admin-a','authenticated_session.revoked','session','session-1',{});
  });
});
