import type {PoolClient} from 'pg';
import {query} from '../db/pool.js';

/**
 * Records an audit event. When a client is supplied the insert participates in
 * the caller's transaction, so business data and its audit trail commit or
 * roll back together. Without a client the existing standalone behaviour is
 * preserved for all other callers.
 */
export async function recordAudit(
  tenantId: string,
  actorUserId: string | null,
  eventType: string,
  entityType?: string,
  entityId?: string,
  details: Record<string, unknown> = {},
  client?: PoolClient,
) {
  const text = 'INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)';
  const values = [tenantId, actorUserId, eventType, entityType ?? null, entityId ?? null, details];
  if (client) await client.query(text, values);
  else await query(text, values);
}
