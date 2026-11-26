import crypto from 'node:crypto';
import argon2 from 'argon2';
import {env} from '../config/env.js';
import {query,withSessionContext,withTenantContext,withTransaction} from '../db/pool.js';
import {sessionHash} from '../middleware/auth.js';
import {recordAudit} from './audit.js';

const TOTP_PERIOD_SECONDS=30;
const TOTP_DIGITS=6;
const TOTP_WINDOW=1;
const MAX_FAILURES=5;
const LOCK_MINUTES=15;
const RECOVERY_CODE_COUNT=10;

type MfaUserRow={id:string;tenant_id:string;email:string;role:string;mfa_secret_ciphertext:string|null;mfa_secret_nonce:string|null;mfa_secret_tag:string|null;mfa_enrolled_at:string|null;mfa_failed_attempts:number;mfa_locked_until:string|null;mfa_last_used_step:string|null};
type MfaSessionRow=MfaUserRow & {session_id:string;csrf_token:string;device_id:string;expires_at:string;mfa_pending:boolean};

function key(){if(!env.MFA_ENCRYPTION_KEY)throw new Error('MFA_ENCRYPTION_KEY must be configured before MFA enrollment');return crypto.createHash('sha256').update(env.MFA_ENCRYPTION_KEY).digest();}
function base32Encode(value:Buffer){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0;let buffer=0;let output='';for(const byte of value){buffer=(buffer<<8)|byte;bits+=8;while(bits>=5){output+=alphabet[(buffer>>>(bits-5))&31];bits-=5;}}if(bits>0)output+=alphabet[(buffer<<(5-bits))&31];return output;}
function base32Decode(value:string){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0;let buffer=0;const bytes:number[]=[];for(const char of value.replace(/=+$/,'').toUpperCase()){const index=alphabet.indexOf(char);if(index<0)throw new Error('Invalid TOTP secret');buffer=(buffer<<5)|index;bits+=5;if(bits>=8){bytes.push((buffer>>>(bits-8))&255);bits-=8;}}return Buffer.from(bytes);}
export function generateTotpSecret(){return base32Encode(crypto.randomBytes(20));}
export function totpStep(timestamp=Date.now()){return Math.floor(timestamp/1000/TOTP_PERIOD_SECONDS);}
export function totpCode(secret:string,step=totpStep()){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const digest=crypto.createHmac('sha1',base32Decode(secret)).update(counter).digest();const offset=digest[digest.length-1]&15;const number=(digest.readUInt32BE(offset)&0x7fffffff)%10**TOTP_DIGITS;return String(number).padStart(TOTP_DIGITS,'0');}
export function verifyTotp(secret:string,code:string,now=Date.now()){if(!/^\d{6}$/.test(code))return null;const current=totpStep(now);for(let offset=-TOTP_WINDOW;offset<=TOTP_WINDOW;offset++)if(crypto.timingSafeEqual(Buffer.from(totpCode(secret,current+offset)),Buffer.from(code)))return current+offset;return null;}
function encryptSecret(secret:string){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return {ciphertext:ciphertext.toString('base64url'),nonce:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')};}
function decryptSecret(row:MfaUserRow){if(!row.mfa_secret_ciphertext||!row.mfa_secret_nonce||!row.mfa_secret_tag)return null;const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(row.mfa_secret_nonce,'base64url'));decipher.setAuthTag(Buffer.from(row.mfa_secret_tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(row.mfa_secret_ciphertext,'base64url')),decipher.final()]).toString('utf8');}
function error(message:string,status=400,code='MFA_ERROR'){return Object.assign(new Error(message),{status,code});}
export function isMfaEnrolled(user:MfaUserRow){return Boolean(user.mfa_enrolled_at&&user.mfa_secret_ciphertext);}
export async function isMfaRequired(tenantId:string,role:string,userId:string){
  const result=await query<{required:boolean}>(`SELECT (u.mfa_enrolled_at IS NOT NULL AND u.mfa_secret_ciphertext IS NOT NULL) OR ($2=ANY(COALESCE(p.required_roles,ARRAY['admin','superadmin']::text[]))) AS required FROM users u LEFT JOIN tenant_mfa_policies p ON p.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.id=$3`,[tenantId,role,userId]);
  return result.rows[0]?.required===true;
}
export async function createEnrollment(tenantId:string,userId:string,email:string){
  const secret=generateTotpSecret();const encrypted=encryptSecret(secret);const recoveryCodes=Array.from({length:RECOVERY_CODE_COUNT},()=>crypto.randomBytes(8).toString('hex'));
  await withTenantContext(tenantId,()=>withTransaction(async client=>{
    await client.query(`UPDATE users SET mfa_secret_ciphertext=$1,mfa_secret_nonce=$2,mfa_secret_tag=$3,mfa_enrolled_at=now(),mfa_failed_attempts=0,mfa_locked_until=NULL,mfa_last_used_step=NULL WHERE tenant_id=$4 AND id=$5`,[encrypted.ciphertext,encrypted.nonce,encrypted.tag,tenantId,userId]);
    await client.query('DELETE FROM mfa_recovery_codes WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL',[tenantId,userId]);
    for(const code of recoveryCodes)await client.query('INSERT INTO mfa_recovery_codes(tenant_id,user_id,code_hash) VALUES($1,$2,$3)',[tenantId,userId,await argon2.hash(code)]);
  }));
  await withTenantContext(tenantId,()=>recordAudit(tenantId,userId,'mfa.enrolled','user',userId,{recovery_code_count:recoveryCodes.length}));
  return {otpauthUri:`otpauth://totp/SecurityOps:${encodeURIComponent(email)}?secret=${secret}&issuer=SecurityOps`,recoveryCodes};
}
export async function getPendingSession(sessionId:string|undefined){
  if(!sessionId)return null;
  const result=await withSessionContext(sessionHash(sessionId),()=>query<MfaSessionRow>(`SELECT s.id AS session_id,s.csrf_token,s.device_id,s.expires_at,s.mfa_pending,u.id,u.tenant_id,u.email,u.role,u.mfa_secret_ciphertext,u.mfa_secret_nonce,u.mfa_secret_tag,u.mfa_enrolled_at,u.mfa_failed_attempts,u.mfa_locked_until,u.mfa_last_used_step FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,[sessionHash(sessionId)]));
  return result.rows[0]??null;
}
export async function verifyPendingMfa(sessionId:string,code:string,recoveryCode?:string){
  const pending=await getPendingSession(sessionId);if(!pending||!pending.mfa_pending)throw error('MFA-Herausforderung ist nicht aktiv',401,'MFA_NOT_PENDING');
  if(pending.mfa_locked_until&&new Date(pending.mfa_locked_until)>new Date())throw error('MFA vorübergehend gesperrt',429,'MFA_LOCKED');
  let validStep: number|null=null;let recoveryId:string|undefined;
  if(recoveryCode){
    const candidates=await withTenantContext(pending.tenant_id,()=>withSessionContext(sessionHash(sessionId),()=>query<{id:string;code_hash:string}>('SELECT id,code_hash FROM mfa_recovery_codes WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL',[pending.tenant_id,pending.id])));
    for(const candidate of candidates.rows)if(await argon2.verify(candidate.code_hash,recoveryCode)){recoveryId=candidate.id;break;}
  }else{
    const secret=decryptSecret(pending);if(secret)validStep=verifyTotp(secret,code);
  }
  if(validStep===null&& !recoveryId){
    await withTenantContext(pending.tenant_id,()=>query('UPDATE users SET mfa_failed_attempts=mfa_failed_attempts+1,mfa_locked_until=CASE WHEN mfa_failed_attempts+1 >= $1 THEN now()+($2 * interval \'1 minute\') ELSE mfa_locked_until END WHERE id=$3',[MAX_FAILURES,LOCK_MINUTES,pending.id]));
    throw error('Ungültiger MFA-Code',401,'MFA_INVALID');
  }
  if(validStep!==null&&pending.mfa_last_used_step!==null&&validStep<=Number(pending.mfa_last_used_step))throw error('MFA-Code bereits verwendet',401,'MFA_REPLAY');
  const updated=await withTenantContext(pending.tenant_id,()=>withSessionContext(sessionHash(sessionId),()=>withTransaction(async client=>{
    if(recoveryId){const used=await client.query('UPDATE mfa_recovery_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL',[recoveryId]);if(used.rowCount!==1)throw error('Wiederherstellungscode bereits verwendet',401,'MFA_REPLAY');}
    const result=await client.query(`UPDATE sessions SET mfa_pending=false,mfa_verified_at=now(),expires_at=now()+($1 * interval '1 hour'),updated_at=now() WHERE token_hash=$2 AND mfa_pending=true AND revoked_at IS NULL RETURNING id`,[env.SESSION_TTL_HOURS,sessionHash(sessionId)]);
    if(result.rowCount!==1)throw error('MFA-Herausforderung ist nicht mehr aktiv',401,'MFA_NOT_PENDING');
    await client.query('UPDATE users SET mfa_failed_attempts=0,mfa_locked_until=NULL,mfa_last_used_step=COALESCE($1,mfa_last_used_step) WHERE id=$2',[validStep,pending.id]);
    return result.rows[0];
  })));
  await withTenantContext(pending.tenant_id,()=>recordAudit(pending.tenant_id,pending.id,recoveryId?'mfa.recovery_used':'mfa.verified','session',String(updated.id),{}));
  return {sessionId};
}
export async function resetMfa(tenantId:string,userId:string,actorUserId:string){
  await withTenantContext(tenantId,()=>withTransaction(async client=>{
    await client.query('UPDATE users SET mfa_secret_ciphertext=NULL,mfa_secret_nonce=NULL,mfa_secret_tag=NULL,mfa_enrolled_at=NULL,mfa_failed_attempts=0,mfa_locked_until=NULL,mfa_last_used_step=NULL WHERE tenant_id=$1 AND id=$2',[tenantId,userId]);
    await client.query('UPDATE sessions SET revoked_at=now(),updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL',[tenantId,userId]);
  }));
  await withTenantContext(tenantId,()=>recordAudit(tenantId,actorUserId,'mfa.reset','user',userId,{sessions_revoked:true}));
}
