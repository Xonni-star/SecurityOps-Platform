import type {RequestHandler} from 'express';
import {query} from '../db/pool.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

type Request = Parameters<RequestHandler>[0];

/**
 * Site-aware permission check for read endpoints.
 *
 * `own` grants cannot be answered from the user context alone: ownership of a
 * site lives in resource_owners. This reader resolves that mapping once per
 * request from the existing table and applies the same scope rules as the
 * object-management router. It does not introduce a new permission system.
 */
export function createSitePermissionReader(req: Request) {
  const user = req.user!;
  const grants = normalizePermissionGrants(user.permissionGrants, user.permissions);
  const authorization = {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    isSystemAdmin: user.isSystemAdmin === true,
    siteIds: user.siteIds ?? [],
    grants,
  };
  let ownedSiteIds: Set<string> | null = null;

  return async function canReadSite(permission: string, siteId: string): Promise<boolean> {
    const scope = effectivePermissionScope(grants, permission, {
      role: user.role,
      isSystemAdmin: user.isSystemAdmin === true,
    });
    if (!scope) return false;
    if (scope !== 'own') {
      return canAccessResource(authorization, scope, {tenantId: user.tenantId, siteId});
    }
    if (!ownedSiteIds) {
      const result = await query<{resource_id: string}>(
        `SELECT resource_id FROM resource_owners
          WHERE tenant_id=$1 AND resource='sites' AND user_id=$2`,
        [user.tenantId, user.id],
      );
      ownedSiteIds = new Set(result.rows.map(row => row.resource_id));
    }
    return ownedSiteIds.has(siteId);
  };
}
