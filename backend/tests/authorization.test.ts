import {describe,expect,it} from '@jest/globals';
import {canAccessResource,canUsePermission,effectivePermissionScope,normalizePermissionGrants,PermissionGrant} from '../src/types/authorization.js';

const grants:PermissionGrant[]=[
  {code:'employees:read',scope:'tenant'},
  {code:'sites:read',scope:'site'},
  {code:'devices:write',scope:'own'},
  {code:'backup:read',scope:'system'},
];

describe('granular permission scopes',()=>{
  it('keeps legacy permissions tenant-scoped',()=>{
    expect(normalizePermissionGrants(undefined,['employees:read'])).toEqual([{code:'employees:read',scope:'tenant'}]);
    expect(canUsePermission({userId:'u',tenantId:'t',role:'viewer',isSystemAdmin:false,siteIds:[],grants:normalizePermissionGrants(undefined,['employees:read'])},'employees:read')).toBe(true);
  });

  it('distinguishes tenant, site and own grants',()=>{
    expect(effectivePermissionScope(grants,'employees:read',{role:'viewer',isSystemAdmin:false})).toBe('tenant');
    expect(effectivePermissionScope(grants,'sites:read',{role:'viewer',isSystemAdmin:false})).toBe('site');
    expect(effectivePermissionScope(grants,'devices:write',{role:'operator',isSystemAdmin:false})).toBe('own');
    expect(canUsePermission({userId:'u',tenantId:'t',role:'operator',isSystemAdmin:false,siteIds:['s'],grants},'sites:read',['site'])).toBe(true);
    expect(canUsePermission({userId:'u',tenantId:'t',role:'operator',isSystemAdmin:false,siteIds:['s'],grants},'sites:read',['tenant'])).toBe(false);
  });

  it('requires both superadmin role and explicit system-admin flag',()=>{
    expect(effectivePermissionScope(grants,'backup:read',{role:'admin',isSystemAdmin:true})).toBeNull();
    expect(effectivePermissionScope(grants,'backup:read',{role:'superadmin',isSystemAdmin:false})).toBeNull();
    expect(effectivePermissionScope(grants,'backup:read',{role:'superadmin',isSystemAdmin:true})).toBe('system');
  });

  it('accepts and rejects tenant, site and own resource targets',()=>{
    const context={userId:'u-1',tenantId:'tenant-a',role:'operator',isSystemAdmin:false,siteIds:['site-a'],grants};
    expect(canAccessResource(context,'tenant',{tenantId:'tenant-a'})).toBe(true);
    expect(canAccessResource(context,'tenant',{tenantId:'tenant-b'})).toBe(false);
    expect(canAccessResource(context,'site',{tenantId:'tenant-a',siteId:'site-a'})).toBe(true);
    expect(canAccessResource(context,'site',{tenantId:'tenant-a',siteId:'site-b'})).toBe(false);
    expect(canAccessResource(context,'own',{tenantId:'tenant-a',ownerId:'u-1'})).toBe(true);
    expect(canAccessResource(context,'own',{tenantId:'tenant-a',ownerId:'u-2'})).toBe(false);
  });
});
