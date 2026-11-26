import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';
const optionalString=z.preprocess(value=>value===''?undefined:value,z.string().min(1).optional());
const optionalUrl=z.preprocess(value=>value===''?undefined:value,z.string().url().optional());
const supportedReminderDays=[0,1,3,7];
const reminderDays=z.string().default('7,3,1,0').transform(value=>[...new Set(value.split(',')
  .map(part=>Number(part.trim())).filter(Number.isInteger))])
  .refine(values=>values.length>0&&values.every(value=>supportedReminderDays.includes(value)),{
    message:'KEY_REMINDER_DAYS must contain at least one of 0,1,3,7',
  });
const knownWeakQrSecrets=new Set([
  'securityops-dev-key-qr-secret','test-key-qr-secret','super-secret-signing-key',
  'changeme','change-me','secret','development','password','key-qr-secret',
]);
function shannonEntropy(value:string):number{
  const counts=new Map<string,number>();
  for(const char of value)counts.set(char,(counts.get(char)??0)+1);
  return [...counts.values()].reduce((sum,count)=>{
    const probability=count/value.length;
    return sum-probability*Math.log2(probability);
  },0);
}
/**
 * QR signing secrets are never taken from other secrets and never fall back to
 * a compiled-in value in production. A missing secret only gets a cryptographically
 * random, per-process secret in an explicitly non-production environment.
 */
export function parseKeyQrSecret(nodeEnv:string,configured:string|undefined):{secret:string;source:'configured'|'ephemeral'}{
  if(configured!==undefined){
    const weak=configured.length<32||configured.length>512
      ||Array.from(configured).some(character=>/\s/.test(character)||character.charCodeAt(0)<=31||character.charCodeAt(0)===127)
      ||new Set(configured).size<12||/(.)\1{5,}/.test(configured)
      ||shannonEntropy(configured)<3.5
      ||knownWeakQrSecrets.has(configured.toLowerCase());
    if(weak)throw new Error('KEY_QR_SECRET must be a strong random secret (at least 32 characters, high entropy, no whitespace or repeated patterns)');
    return {secret:configured,source:'configured'};
  }
  if(nodeEnv==='production')throw new Error('KEY_QR_SECRET is required in production; generate one with: openssl rand -hex 32');
  return {secret:crypto.randomBytes(32).toString('base64url'),source:'ephemeral'};
}
const schema=z.object({
  NODE_ENV:z.string().default('development'),
  PORT:z.coerce.number().default(3000),
  DATABASE_URL:z.string().default('postgres://securityops:securityops@localhost:5432/securityops'),
  CORS_ORIGIN:z.preprocess(value=>value===''?undefined:value,z.string().optional()),
  SESSION_TTL_HOURS:z.coerce.number().int().positive().max(168).default(8),
  API_RATE_LIMIT_MAX:z.coerce.number().int().positive().default(120),
  LOGIN_RATE_LIMIT_MAX:z.coerce.number().int().positive().default(10),
  LOGIN_MAX_FAILURES:z.coerce.number().int().positive().max(20).default(5),
  LOGIN_LOCK_MINUTES:z.coerce.number().int().positive().max(1440).default(15),
  PASSWORD_MIN_LENGTH:z.coerce.number().int().min(12).max(256).default(12),
  MFA_ENCRYPTION_KEY:optionalString,
  DEV_SEED_ENABLED:z.enum(['true','false']).default('false').transform(value=>value==='true'),
  DEV_SEED_EMAIL:z.preprocess(value=>value===''?undefined:value,z.string().email().optional()),
  DEV_SEED_PASSWORD:z.preprocess(value=>value===''?undefined:value,z.string().min(12).optional()),
  DEV_SEED_TENANT_NAME:optionalString,
  SMTP_HOST:z.string().optional(),
  SMTP_PORT:z.coerce.number().default(587),
  SMTP_USER:z.string().optional(),
  SMTP_PASSWORD:z.string().optional(),
  NOTIFICATION_FROM:z.string().email().default('notifications@securityops.local'),
  SMS_GATEWAY_URL:optionalUrl,
  SMS_GATEWAY_HEALTH_URL:optionalUrl,
  SMS_GATEWAY_TOKEN:z.string().optional(),
  BACKUP_DIRECTORY:z.string().default('./backups'),
  BACKUP_SECRET_KEY:optionalString,
  WATCHBOOK_HASH_SECRET:optionalString,
  KEY_QR_SECRET:optionalString,
  KEY_REMINDER_DAYS:reminderDays,
  KEY_REMINDER_INTERVAL_MS:z.coerce.number().int().min(60000).max(604800000).default(3600000),
  DMS_STORAGE_PROVIDER:z.enum(['minio']).default('minio'),
  DMS_MAX_BYTES:z.coerce.number().int().positive().max(1073741824).default(52428800),
  DMS_ALLOWED_CONTENT_TYPES:z.string().default('application/pdf,image/jpeg,image/png,text/plain'),
  MINIO_ENDPOINT:z.string().url().default('http://localhost:9000'),
  MINIO_BUCKET:z.string().min(1).default('securityops-dms'),
  MINIO_ACCESS_KEY:z.string().default(''),
  MINIO_SECRET_KEY:z.string().default(''),
  CLAMAV_HOST:z.string().default('localhost'),
  CLAMAV_PORT:z.coerce.number().int().positive().default(3310),
  CLAMAV_TIMEOUT_MS:z.coerce.number().int().positive().default(15000),
  CLAMAV_CHUNK_BYTES:z.coerce.number().int().positive().default(1048576),
  DMS_BLOB_BACKUP_PROVIDER:z.string().min(1).default('not-configured'),
  DMS_BLOB_BACKUP_STATUS:z.enum(['unknown','healthy','degraded','failed']).default('unknown'),
  LOG_LEVEL:z.string().default('info'),
});
const parsedEnv=schema.parse(process.env);
const keyQrConfig=parseKeyQrSecret(parsedEnv.NODE_ENV,parsedEnv.KEY_QR_SECRET);
if(keyQrConfig.source==='ephemeral'){
  console.warn('KEY_QR_SECRET is not configured; an ephemeral development-only QR secret is in use. Issued QR references will be invalid after a restart.');
}
export const keyQrSecret=keyQrConfig.secret;
export const keyQrSecretSource=keyQrConfig.source;

export function parseAllowedOrigins(nodeEnv:string,configuredOrigin:string|undefined):string[]{
  if(nodeEnv==='production'&&!configuredOrigin)throw new Error('Production CORS_ORIGIN is required and must list explicit external origins');
  const rawOrigins=(configuredOrigin??'http://localhost:5173').split(',').map(origin=>origin.trim()).filter(Boolean);
  if(rawOrigins.length===0)throw new Error('CORS_ORIGIN must contain at least one origin');
  return rawOrigins.map(origin=>{
    if(origin==='*'||origin.includes('*'))throw new Error('CORS_ORIGIN must not contain wildcards');
    let parsed:URL;
    try{parsed=new URL(origin);}catch{throw new Error(`CORS_ORIGIN contains an invalid origin: ${origin}`);}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash){
      throw new Error(`CORS_ORIGIN must contain origins only: ${origin}`);
    }
    if(nodeEnv==='production'&&['localhost','127.0.0.1','::1','0.0.0.0'].includes(parsed.hostname)){
      throw new Error('Production CORS_ORIGIN must not allow localhost or loopback');
    }
    return parsed.origin;
  });
}

export const allowedOrigins=parseAllowedOrigins(parsedEnv.NODE_ENV,parsedEnv.CORS_ORIGIN);
export const env={...parsedEnv,CORS_ORIGIN:allowedOrigins.join(',')};
