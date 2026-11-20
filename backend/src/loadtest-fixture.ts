import argon2 from 'argon2';
import {pool} from './db/pool.js';
import {env} from './config/env.js';

const uuid = {
  tenant: '00000000-0000-0000-0000-000000000013',
  user: '00000000-0000-0000-0000-000000000014',
  device: '00000000-0000-0000-0000-000000000015',
  priority: '00000000-0000-0000-0000-000000000016',
};

const fixture = process.env.LOADTEST_FIXTURE === 'isolated';
const email = process.env.LOADTEST_EMAIL ?? 'loadtest@example.invalid';
const password = process.env.LOADTEST_PASSWORD;
const tenantName = process.env.LOADTEST_TENANT_NAME ?? 'loadtest-phase-4';

if (env.NODE_ENV === 'production' || !fixture || !password || !tenantName.startsWith('loadtest-')) {
  throw new Error('Refusing fixture setup: require non-production isolated load-test configuration');
}

const passwordHash = await argon2.hash(password, {type: argon2.argon2id});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO tenants(id,name) VALUES($1,$2)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,updated_at=now()`,
    [uuid.tenant, tenantName],
  );
  await client.query(
    `INSERT INTO users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,$4,'admin')
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,email=EXCLUDED.email,
       password_hash=EXCLUDED.password_hash,role='admin',updated_at=now()`,
    [uuid.user, uuid.tenant, email, passwordHash],
  );
  await client.query(
    `INSERT INTO devices(id,tenant_id,name,status,device_kind,metadata)
     VALUES($1,$2,'Phase 4 isolated load-test device','online','authenticated','{"source":"loadtest-fixture"}')
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,status='online',
       device_kind='authenticated',revoked_at=NULL,metadata=EXCLUDED.metadata,updated_at=now()`,
    [uuid.device, uuid.tenant],
  );
  await client.query(
    `INSERT INTO alarm_priorities(id,tenant_id,name,code,rank,color)
     VALUES($1,$2,'Load test medium','medium',3,'#2563eb')
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,code='medium',
       rank=3,color='#2563eb',updated_at=now()`,
    [uuid.priority, uuid.tenant],
  );
  await client.query('COMMIT');
  console.log(JSON.stringify({email, deviceId: uuid.device, priorityId: uuid.priority, tenantId: uuid.tenant}));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
