import 'dotenv/config';
import { z } from 'zod';
const optionalString=z.preprocess(value=>value===''?undefined:value,z.string().min(1).optional());
const optionalUrl=z.preprocess(value=>value===''?undefined:value,z.string().url().optional());
const schema=z.object({
  NODE_ENV:z.string().default('development'),
  PORT:z.coerce.number().default(3000),
  DATABASE_URL:z.string().default('postgres://securityops:securityops@localhost:5432/securityops'),
  CORS_ORIGIN:z.string().default('http://localhost:5173'),
  SESSION_TTL_HOURS:z.coerce.number().int().positive().max(168).default(8),
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
export const env=schema.parse(process.env);
export const allowedOrigins=env.CORS_ORIGIN.split(',').map(origin=>origin.trim()).filter(Boolean);
if(env.NODE_ENV==='production'&&allowedOrigins.some(origin=>origin.includes('localhost')||origin.includes('127.0.0.1'))){
  throw new Error('Production CORS_ORIGIN must not allow localhost');
}
