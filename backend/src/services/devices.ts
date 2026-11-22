import {query,withTenantContext,withTransaction} from '../db/pool.js';
import {recordAudit} from './audit.js';

export type AuthenticatedDeviceMetadata={platform?:string;app_version?:string};

function deviceError(message:string,status:number,code:string){
  return Object.assign(new Error(message),{status,code});
}

export async function registerAuthenticatedDevice(
  tenantId:string,
  userId:string,
  deviceId:string,
  metadata:AuthenticatedDeviceMetadata,
  sessionTokenHash:string,
  csrfToken:string,
  expiresInHours:number,
  mfaPending=false,
){
  return withTenantContext(tenantId,()=>withTransaction(async client=>{
    const device=(await client.query(
      `INSERT INTO devices(id,tenant_id,name,status,device_kind,metadata,last_seen_at)
       VALUES($1,$2,'Authenticated device','online','authenticated',$3,now())
       ON CONFLICT (tenant_id,id) DO UPDATE SET
         metadata=EXCLUDED.metadata,last_seen_at=now(),updated_at=now()
       WHERE devices.device_kind='authenticated' AND devices.revoked_at IS NULL
       RETURNING id,tenant_id,metadata,last_seen_at,revoked_at`,
      [deviceId,tenantId,metadata],
    )).rows[0];
    if(!device){
      const current=(await client.query<{device_kind:string;revoked_at:string|null}>(
        'SELECT device_kind,revoked_at FROM devices WHERE tenant_id=$1 AND id=$2',
        [tenantId,deviceId],
      )).rows[0];
      if(current?.revoked_at)throw deviceError('Device has been revoked.',403,'DEVICE_REVOKED');
      throw deviceError('Device identity is already in use.',409,'DEVICE_ID_CONFLICT');
    }
    if(mfaPending)await client.query(
      `INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at,mfa_pending)
       VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 hour'),true)`,
      [tenantId,userId,deviceId,sessionTokenHash,csrfToken,expiresInHours],
    );
    else await client.query(
      `INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
       VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 hour'))`,
      [tenantId,userId,deviceId,sessionTokenHash,csrfToken,expiresInHours],
    );
    return device;
  }));
}

export async function revokeAuthenticatedDevice(tenantId:string,deviceId:string,actorUserId:string){
  const result=await withTenantContext(tenantId,()=>withTransaction(async client=>{
    const device=(await client.query(
      `UPDATE devices SET revoked_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND device_kind='authenticated' AND revoked_at IS NULL
       RETURNING id,revoked_at`,
      [tenantId,deviceId],
    )).rows[0];
    if(!device)throw deviceError('Authenticated device not found.',404,'DEVICE_NOT_FOUND');
    const sessions=await client.query(
      `UPDATE sessions SET revoked_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND device_id=$2 AND revoked_at IS NULL`,
      [tenantId,deviceId],
    );
    return {device,sessionsRevoked:sessions.rowCount??0};
  }));
  await recordAudit(tenantId,actorUserId,'authenticated_device.revoked','device',deviceId,{sessionsRevoked:result.sessionsRevoked});
  return result;
}

export type AuthenticatedSessionSummary={
  id:string;
  user_id:string;
  email:string;
  role:string;
  device_id:string;
  device_name:string;
  metadata:Record<string,unknown>;
  created_at:string;
  last_seen_at:string|null;
  expires_at:string;
  revoked_at:string|null;
};

export async function listAuthenticatedSessions(tenantId:string){
  return (await withTenantContext(tenantId,()=>query<AuthenticatedSessionSummary>(
    `SELECT s.id,s.user_id,u.email,u.role,s.device_id,d.name AS device_name,d.metadata,
            s.created_at,d.last_seen_at,s.expires_at,s.revoked_at
       FROM sessions s
       JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
       JOIN devices d ON d.tenant_id=s.tenant_id AND d.id=s.device_id
      WHERE s.tenant_id=$1
      ORDER BY s.revoked_at NULLS FIRST,s.created_at DESC`,
    [tenantId],
  ))).rows;
}

export async function revokeAuthenticatedSession(tenantId:string,sessionId:string,actorUserId:string){
  const result=await withTenantContext(tenantId,()=>withTransaction(async client=>{
    const session=(await client.query(
      `UPDATE sessions SET revoked_at=now(),updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL
        RETURNING id`,
      [tenantId,sessionId],
    )).rows[0];
    if(!session)throw deviceError('Authenticated session not found or already revoked.',404,'SESSION_NOT_FOUND');
    return session;
  }));
  await recordAudit(tenantId,actorUserId,'authenticated_session.revoked','session',sessionId,{});
  return result;
}
