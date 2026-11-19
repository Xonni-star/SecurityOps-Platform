import 'dotenv/config';
import { z } from 'zod';
const schema=z.object({
  NODE_ENV:z.string().default('development'),
  PORT:z.coerce.number().default(3000),
  DATABASE_URL:z.string().default('postgres://securityops:securityops@localhost:5432/securityops'),
  CORS_ORIGIN:z.string().default('http://localhost:5173'),
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
