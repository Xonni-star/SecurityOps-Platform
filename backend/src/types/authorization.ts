export type PermissionScope='tenant'|'site'|'own'|'system';

export interface PermissionGrant {
  code:string;
  scope:PermissionScope;
}

export interface AuthorizationContext {
  userId:string;
  tenantId:string;
  role:string;
  isSystemAdmin:boolean;
  siteIds:string[];
  grants:PermissionGrant[];
}

const scopeRank:Record<PermissionScope,number>={own:1,site:2,tenant:3,system:4};

export function normalizePermissionGrants(
  grants:unknown,
  legacyPermissions:unknown=[],
):PermissionGrant[]{
  const normalized:PermissionGrant[]=[];
  if(Array.isArray(grants)){
    for(const grant of grants){
      if(typeof grant==='string')normalized.push({code:grant,scope:'tenant'});
      else if(grant&&typeof grant==='object'){
        const code='code' in grant&&typeof grant.code==='string'?grant.code:'';
        const scope='scope' in grant&&typeof grant.scope==='string'?grant.scope:'';
        if(code&&scopeRank[scope as PermissionScope])normalized.push({code,scope:scope as PermissionScope});
      }
    }
  }
  if(Array.isArray(legacyPermissions)){
    for(const code of legacyPermissions)if(typeof code==='string'&&!normalized.some(grant=>grant.code===code))normalized.push({code,scope:'tenant'});
  }
  return normalized;
}

export function effectivePermissionScope(
  grants:PermissionGrant[],
  code:string,
  context:Pick<AuthorizationContext,'role'|'isSystemAdmin'>,
):PermissionScope|null{
  const matches=grants.filter(grant=>grant.code===code);
  const allowed=matches.filter(grant=>grant.scope!=='system'||(context.role==='superadmin'&&context.isSystemAdmin));
  return allowed.sort((a,b)=>scopeRank[b.scope]-scopeRank[a.scope])[0]?.scope??null;
}

export function canUsePermission(
  context:AuthorizationContext,
  code:string,
  allowedScopes:PermissionScope[]=['tenant','system'],
):boolean{
  const scope=effectivePermissionScope(context.grants,code,context);
  return scope!==null&&allowedScopes.includes(scope);
}

export function canAccessResource(
  context:AuthorizationContext,
  scope:PermissionScope,
  target:{tenantId:string;siteId?:string|null;ownerId?:string|null},
):boolean{
  if(target.tenantId!==context.tenantId)return false;
  if(scope==='system')return context.role==='superadmin'&&context.isSystemAdmin;
  if(scope==='tenant')return true;
  if(scope==='site')return typeof target.siteId==='string'&&context.siteIds.includes(target.siteId);
  return target.ownerId===context.userId;
}
