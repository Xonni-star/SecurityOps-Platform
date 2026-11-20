import {withTenantContext,withTransaction} from '../db/pool.js';
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
    await client.query(
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
