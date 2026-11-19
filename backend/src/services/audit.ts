import {query} from '../db/pool.js';

export async function recordAudit(tenantId:string,actorUserId:string,eventType:string,entityType?:string,entityId?:string,details:Record<string,unknown>={}){
  await query(
    'INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
    [tenantId,actorUserId,eventType,entityType??null,entityId??null,details],
  );
}
