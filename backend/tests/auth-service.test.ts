import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withTransaction:async (work:(client:{query:typeof queryMock})=>Promise<unknown>)=>work({query:queryMock}),
}));

const {logout,generateOpaqueToken}=await import('../src/services/auth.js');

beforeEach(()=>queryMock.mockReset());

describe('session service security',()=>{
  it('generates opaque tokens with sufficient randomness and no fixed value',()=>{
    const first=generateOpaqueToken();
    const second=generateOpaqueToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it('revokes sessions without deleting their audit row',async()=>{
    await logout('opaque-session');
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sessions SET revoked_at=now()'),
      [expect.any(String)],
    );
    expect(queryMock.mock.calls[0][0]).not.toContain('DELETE FROM sessions');
  });
});
