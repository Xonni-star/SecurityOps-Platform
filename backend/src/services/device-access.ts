import type {AuthUser} from '../types/models.js';
import {
  canAccessResource,
  effectivePermissionScope,
  normalizePermissionGrants,
  type PermissionGrant,
  type PermissionScope,
} from '../types/authorization.js';

/**
 * Einheitlicher Zugriff auf Betriebsgeräte. Alle Gerätelisten, Akten und
 * Geräteaktionen verwenden dieselben Regeln wie die generische CRUD-Route.
 * Authentifizierte Geräte (device_kind='authenticated') sind hier bewusst
 * ausgeschlossen; für sie gelten authenticated_devices:*.
 */
export function devicePermissionScope(user: AuthUser, code: string): PermissionScope | null {
  return effectivePermissionScope(
    normalizePermissionGrants(user.permissionGrants, user.permissions),
    code,
    {role: user.role, isSystemAdmin: user.isSystemAdmin === true},
  );
}

export function deviceAuthorizationContext(user: AuthUser) {
  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    isSystemAdmin: user.isSystemAdmin === true,
    siteIds: user.siteIds ?? [],
    grants: normalizePermissionGrants(user.permissionGrants, user.permissions) as PermissionGrant[],
  };
}

/**
 * SQL-Zusatzfilter für einen Scope. `start` ist die Nummer des ersten
 * Platzhalters, der für die Filterwerte reserviert wird.
 */
export function deviceScopeFilterForScope(
  user: AuthUser,
  scope: PermissionScope | null,
  start: number,
  tableAlias = 'd',
): {sql: string; values: unknown[]} {
  if (!scope) return {sql: ' AND FALSE', values: []};
  if (scope === 'tenant' || scope === 'system') return {sql: '', values: []};
  if (scope === 'site') {
    return {
      sql: ` AND ${tableAlias}.site_id = ANY($${start}::uuid[])`,
      values: [user.siteIds ?? []],
    };
  }
  return {
    sql: ` AND EXISTS (SELECT 1 FROM resource_owners ro WHERE ro.tenant_id=$${start} AND ro.resource='devices' AND ro.resource_id=${tableAlias}.id AND ro.user_id=$${start + 1})`,
    values: [user.tenantId, user.id],
  };
}

export function deviceScopeFilter(
  user: AuthUser,
  code: string,
  start: number,
  tableAlias = 'd',
): {sql: string; values: unknown[]} {
  return deviceScopeFilterForScope(user, devicePermissionScope(user, code), start, tableAlias);
}

export function canAccessDevice(
  user: AuthUser,
  code: string,
  device: {tenant_id: string; site_id: string | null; id: string},
): boolean {
  const scope = devicePermissionScope(user, code);
  if (!scope) return false;
  if (scope === 'own') {
    // Der Ownership-Check erfolgt in den Routen über resource_owners, weil
    // dort der Filter bereits in der Datenbank angewendet wird.
    return false;
  }
  return canAccessResource(deviceAuthorizationContext(user), scope, {
    tenantId: device.tenant_id,
    siteId: device.site_id,
  });
}
