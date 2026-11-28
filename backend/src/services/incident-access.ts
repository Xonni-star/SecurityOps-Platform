import type {Request} from 'express';
import {createHash} from 'node:crypto';
import {
  canAccessResource,
  canUsePermission,
  effectivePermissionScope,
  normalizePermissionGrants,
  type AuthorizationContext,
  type PermissionScope,
} from '../types/authorization.js';

/** Gemeinsame Rechte- und Scope-Prüfung für alle Einsatz-Endpunkte. */
export type IncidentUser=AuthorizationContext;
export const incidentReadScopes:PermissionScope[]=['tenant','site','system'];
export const incidentWriteScopes:PermissionScope[]=['tenant','site','system'];

export function incidentAuthUser(req:Request):IncidentUser{
  const user=req.user!;
  return {
    userId:user.id,
    tenantId:user.tenantId,
    role:user.role,
    isSystemAdmin:user.isSystemAdmin===true,
    siteIds:user.siteIds??[],
    grants:normalizePermissionGrants(user.permissionGrants,user.permissions),
  };
}

export function incidentError(message:string,status:number,extra:Record<string,unknown>={}){
  return Object.assign(new Error(message),{status,...extra});
}

export function incidentScope(
  user:IncidentUser,
  permission:string,
  scopes:PermissionScope[]=incidentReadScopes,
):PermissionScope|null{
  if(!canUsePermission(user,permission,scopes))return null;
  return effectivePermissionScope(user.grants,permission,user);
}

export function requireIncidentScope(
  user:IncidentUser,
  permission:string,
  scopes:PermissionScope[]=incidentReadScopes,
):PermissionScope{
  const scope=incidentScope(user,permission,scopes);
  if(!scope)throw incidentError('Unzureichende Berechtigungen',403);
  return scope;
}

/** Ein Site-scoped Benutzer darf nur Objekte seiner Objektzuordnungen berühren. */
export function assertIncidentSiteScope(
  user:IncidentUser,
  scope:PermissionScope,
  siteId:string|null|undefined,
  requireSite=false,
){
  if(scope!=='site')return;
  if(!siteId||!user.siteIds.includes(siteId)){
    throw incidentError(requireSite
      ?'Für objektbezogene Berechtigungen ist ein zulässiges Objekt erforderlich'
      :'Kein Zugriff auf dieses Objekt',403);
  }
}

export function incidentCanAccessSite(user:IncidentUser,scope:PermissionScope,siteId:string|null|undefined){
  return canAccessResource(user,scope,{tenantId:user.tenantId,siteId:siteId??null});
}

export function incidentFingerprint(payload:unknown){
  return createHash('sha256').update(JSON.stringify(payload??null)).digest('hex');
}

export function incidentReplayConflict(){
  return incidentError('Die Wiederholung weicht von der ursprünglichen Anfrage ab',409,{reason_code:'idempotency_conflict'});
}
