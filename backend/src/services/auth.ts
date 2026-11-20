import argon2 from 'argon2'; import crypto from 'node:crypto'; import {query,withLoginContext,withSessionContext,withTenantContext} from '../db/pool.js'; import {AuthUser} from '../types/models.js'; import {PermissionGrant} from '../types/authorization.js'; import {sessionHash} from '../middleware/auth.js'; import {env} from '../config/env.js'; import {AuthenticatedDeviceMetadata,registerAuthenticatedDevice} from './devices.js'; import {isMfaRequired} from './mfa.js'; import {recordAudit} from './audit.js';
const DUMMY_PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=4$bvnJpnO/Vq6gVslGLAskuQ$qbPvJtwnDyXQAv/pyVx4Q9fohMkbCIWsYfjZ4OW4yGo';
export function generateOpaqueToken(){return crypto.randomBytes(32).toString('base64url');}
export async function login(email:string,password:string,deviceId:string,metadata:AuthenticatedDeviceMetadata){
  const r=await withLoginContext(email,()=>query<{id:string;tenant_id:string;email:string;password_hash:string;role:'admin'|'operator'|'viewer'|'superadmin';failed_login_attempts:number;locked_until:string|null;locked_permanently:boolean}>('SELECT id,tenant_id,email,password_hash,role,failed_login_attempts,locked_until,locked_permanently FROM users WHERE email=$1',[email]));
  const u=r.rows[0];const passwordValid=await argon2.verify(u?.password_hash??DUMMY_PASSWORD_HASH,password);
  const locked=Boolean(u?.locked_permanently||(u?.locked_until&&new Date(u.locked_until).getTime()>Date.now()));
  if(!u||!passwordValid||locked){
    if(u&&!locked)await withTenantContext(u.tenant_id,async()=>{const result=await query<{failed_login_attempts:number;locked_until:string|null}>(`UPDATE users SET failed_login_attempts=failed_login_attempts+1,last_failed_login_at=now(),locked_until=CASE WHEN failed_login_attempts+1 >= $2 THEN now()+($3 || ' minutes')::interval ELSE locked_until END WHERE id=$1 RETURNING failed_login_attempts,locked_until`,[u.id,env.LOGIN_MAX_FAILURES,env.LOGIN_LOCK_MINUTES]);await recordAudit(u.tenant_id,null,'auth.login.failed','user',u.id,{reason:'invalid_credentials',attempts:result.rows[0]?.failed_login_attempts??null,locked:Boolean(result.rows[0]?.locked_until)});});
    return null;
  }
  await withTenantContext(u.tenant_id,()=>query('UPDATE users SET failed_login_attempts=0,locked_until=NULL,last_failed_login_at=NULL WHERE id=$1',[u.id]));
  const mfaRequired=await withTenantContext(u.tenant_id,()=>isMfaRequired(u.tenant_id,u.role,u.id));const pending=mfaRequired;const sessionId=generateOpaqueToken();const csrfToken=generateOpaqueToken();await registerAuthenticatedDevice(u.tenant_id,u.id,deviceId,metadata,sessionHash(sessionId),csrfToken,pending?1/6:env.SESSION_TTL_HOURS,pending);const grants=await withLoginContext(email,()=>query<PermissionGrant & {key:string}>('SELECT p.key,p.key AS code,rp.scope FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id WHERE rp.role=$1 ORDER BY p.key',[u.role]));const user:AuthUser={id:u.id,tenantId:u.tenant_id,email:u.email,role:u.role,permissions:grants.rows.map(row=>row.key),permissionGrants:grants.rows.map(row=>({code:row.code,scope:row.scope}))};return {sessionId,csrfToken,user,deviceId,mfaRequired,mfaPending:pending};
}

export function validatePassword(password:string,minimum=env.PASSWORD_MIN_LENGTH){
  return password.length>=minimum&&/[A-Z]/.test(password)&&/[a-z]/.test(password)&&/\d/.test(password)&&/[^A-Za-z0-9]/.test(password);
}
export async function changePassword(tenantId:string,userId:string,currentPassword:string,newPassword:string){
  if(!validatePassword(newPassword))throw Object.assign(new Error('Password does not meet policy'),{status:400});
  return withTenantContext(tenantId,async()=>{
    const user=(await query<{password_hash:string}>('SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,userId])).rows[0];if(!user||!(await argon2.verify(user.password_hash,currentPassword)))throw Object.assign(new Error('Invalid credentials'),{status:401});
    const history=(await query<{password_hash:string}>('SELECT password_hash FROM password_history WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 5',[tenantId,userId])).rows;
    if(await Promise.all([user.password_hash,...history.map(item=>item.password_hash)].map(hash=>argon2.verify(hash,newPassword))).then(values=>values.some(Boolean)))throw Object.assign(new Error('Password was used recently'),{status:400});
    const hash=await argon2.hash(newPassword,{type:argon2.argon2id});await query('INSERT INTO password_history(tenant_id,user_id,password_hash) VALUES($1,$2,$3)',[tenantId,userId,user.password_hash]);await query('UPDATE users SET password_hash=$3,password_changed_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,userId,hash]);await recordAudit(tenantId,userId,'auth.password.changed','user',userId,{history_depth:5});return true;
  });
}
export async function logout(sessionId:string|undefined){if(sessionId){const tokenHash=sessionHash(sessionId);await withSessionContext(tokenHash,()=>query('UPDATE sessions SET revoked_at=now(),updated_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',[tokenHash]));}}
