import 'dotenv/config';
import { z } from 'zod';
const schema=z.object({NODE_ENV:z.string().default('development'),PORT:z.coerce.number().default(3000),DATABASE_URL:z.string().default('postgres://securityops:securityops@localhost:5432/securityops'),CORS_ORIGIN:z.string().default('http://localhost:5173')});
export const env=schema.parse(process.env);
