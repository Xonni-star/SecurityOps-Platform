import 'dotenv/config';
import { z } from 'zod';
const optionalString=z.preprocess(value=>value===''?undefined:value,z.string().min(1).optional());
const schema=z.object({
  NODE_ENV:z.string().default('development'),
  PORT:z.coerce.number().default(3000),
  DATABASE_URL:z.string().default('postgres://securityops:securityops@localhost:5432/securityops'),
  CORS_ORIGIN:z.string().default('http://localhost:5173'),
  SESSION_TTL_HOURS:z.coerce.number().int().positive().max(168).default(8),
  DEV_SEED_ENABLED:z.enum(['true','false']).default('false').transform(value=>value==='true'),
  DEV_SEED_EMAIL:z.preprocess(value=>value===''?undefined:value,z.string().email().optional()),
  DEV_SEED_PASSWORD:z.preprocess(value=>value===''?undefined:value,z.string().min(12).optional()),
  DEV_SEED_TENANT_NAME:optionalString,
  SMTP_HOST:z.string().optional(),
  SMTP_PORT:z.coerce.number().default(587),
  SMTP_USER:z.string().optional(),
  SMTP_PASSWORD:z.string().optional(),
  NOTIFICATION_FROM:z.string().email().default('notifications@securityops.local'),
  SMS_GATEWAY_URL:z.string().url().optional(),
  SMS_GATEWAY_TOKEN:z.string().optional(),
  BACKUP_DIRECTORY:z.string().default('./backups'),
  LOG_LEVEL:z.string().default('info'),
});
export const env=schema.parse(process.env);
export const allowedOrigins=env.CORS_ORIGIN.split(',').map(origin=>origin.trim()).filter(Boolean);
if(env.NODE_ENV==='production'&&allowedOrigins.some(origin=>origin.includes('localhost')||origin.includes('127.0.0.1'))){
  throw new Error('Production CORS_ORIGIN must not allow localhost');
}
