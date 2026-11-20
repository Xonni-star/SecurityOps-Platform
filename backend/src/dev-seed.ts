import argon2 from 'argon2';
import {pool} from './db/pool.js';
import {env} from './config/env.js';

if(env.NODE_ENV!=='development'||!env.DEV_SEED_ENABLED||!env.DEV_SEED_EMAIL||!env.DEV_SEED_PASSWORD||!env.DEV_SEED_TENANT_NAME){
  throw new Error('Development seed requires NODE_ENV=development, DEV_SEED_ENABLED=true, DEV_SEED_EMAIL, DEV_SEED_PASSWORD, and DEV_SEED_TENANT_NAME');
}

const passwordHash=await argon2.hash(env.DEV_SEED_PASSWORD,{type:argon2.argon2id});
const client=await pool.connect();
try{
  await client.query('BEGIN');
  const existingTenant=await client.query<{id:string}>('SELECT id FROM tenants WHERE name=$1 LIMIT 1',[env.DEV_SEED_TENANT_NAME]);
  const tenantId=existingTenant.rows[0]?.id??(await client.query<{id:string}>('INSERT INTO tenants(name) VALUES($1) RETURNING id',[env.DEV_SEED_TENANT_NAME])).rows[0]?.id;
  if(!tenantId)throw new Error('Unable to create or locate development tenant');
  await client.query('SELECT set_config($1,$2,true)',['app.tenant_id',tenantId]);
  await client.query('INSERT INTO users(tenant_id,email,password_hash,role) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,email) DO UPDATE SET password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,updated_at=now()',[tenantId,env.DEV_SEED_EMAIL,passwordHash,'admin']);
  await client.query('COMMIT');
}catch(error){
  await client.query('ROLLBACK');
  throw error;
}finally{
  client.release();
  await pool.end();
}
