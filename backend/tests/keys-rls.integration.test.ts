import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {runMigrations} from '../src/db/migration-runner.js';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL key management integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;

describePostgres('PostgreSQL key management cockpit migrations and isolation',()=>{
  const testName=`securityops_keys_${randomUUID().replaceAll('-','')}`;
  let pool:pg.Pool;
  let tenantA:string;
  let tenantB:string;
  let userA:string;
  let sessionA:string;
  let deviceA:string;
  let keyA:string;
  let keyB:string;
  let movementA:string;

  beforeAll(async()=>{
    if(!databaseUrl)throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    pool=new pg.Pool({connectionString:databaseUrl});
    const migrationsDir=existsSync(resolve(process.cwd(),'migrations'))
      ?resolve(process.cwd(),'migrations')
      :resolve(process.cwd(),'backend/migrations');
    await runMigrations(pool,migrationsDir);
    const admin=await pool.connect();
    try{
      const seed=await admin.query<{
        tenant_a:string;tenant_b:string;site_a:string;site_b:string;
        user_a:string;session_a:string;device_a:string;
      }>(`
        WITH a AS (INSERT INTO tenants(name) VALUES ('Keys A') RETURNING id),
        b AS (INSERT INTO tenants(name) VALUES ('Keys B') RETURNING id),
        sa AS (INSERT INTO sites(tenant_id,name) SELECT id,'Site A' FROM a RETURNING id),
        sb AS (INSERT INTO sites(tenant_id,name) SELECT id,'Site B' FROM b RETURNING id),
        ua AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$1,'admin','hash' FROM a RETURNING id),
        ub AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$4,'admin','hash' FROM b RETURNING id),
        da AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'Device A','authenticated' FROM a RETURNING id),
        db AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sb),'Device B','authenticated' FROM b RETURNING id),
        sea AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at) SELECT id,(SELECT id FROM ua),(SELECT id FROM da),$2,$3,now()+INTERVAL '1 day' FROM a RETURNING id),
        seb AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at) SELECT id,(SELECT id FROM ub),(SELECT id FROM db),$5,$6,now()+INTERVAL '1 day' FROM b RETURNING id),
        ka AS (INSERT INTO keys(tenant_id,site_id,key_code,label,key_type,created_by,created_session_id)
          SELECT id,(SELECT id FROM sa),'A-1','Key A','electronic',(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
        kb AS (INSERT INTO keys(tenant_id,site_id,key_code,label,key_type,created_by,created_session_id)
          SELECT id,(SELECT id FROM sb),'B-1','Key B','physical',(SELECT id FROM ub),(SELECT id FROM seb) FROM b RETURNING id),
        ma AS (INSERT INTO key_movements(tenant_id,key_id,movement_type,to_status,actor_user_id,session_id,device_id)
          SELECT id,(SELECT id FROM ka),'created','available',(SELECT id FROM ua),(SELECT id FROM sea),(SELECT id FROM da) FROM a RETURNING id)
        SELECT a.id tenant_a,b.id tenant_b,(SELECT id FROM sa) site_a,(SELECT id FROM sb) site_b,
          (SELECT id FROM ua) user_a,(SELECT id FROM sea) session_a,(SELECT id FROM da) device_a
        FROM a,b
      `,[
        `${testName}-a@example.invalid`,`hash-a-${testName}`,`csrf-a-${testName}`,
        `${testName}-b@example.invalid`,`hash-b-${testName}`,`csrf-b-${testName}`,
      ]);
      ({tenant_a:tenantA,tenant_b:tenantB,user_a:userA,session_a:sessionA,device_a:deviceA}=seed.rows[0]);
      const keys=await admin.query<{a:string;b:string}>('SELECT (SELECT id FROM keys WHERE key_code=$1) a,(SELECT id FROM keys WHERE key_code=$2) b',['A-1','B-1']);
      keyA=keys.rows[0].a;keyB=keys.rows[0].b;
      const movements=await admin.query<{id:string}>('SELECT id FROM key_movements WHERE tenant_id=$1',[tenantA]);
      movementA=movements.rows[0].id;

      await admin.query(`CREATE ROLE ${testName} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${testName}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON keys,key_movements,key_receipts,key_loss_reports,key_qr_tokens,key_inventory_checks,key_inventory_check_items,key_reminder_state,sites,tenants,users,employees,devices,sessions TO ${testName}`);
    }finally{
      admin.release();
    }
  },60_000);

  afterAll(async()=>{
    if(!pool)return;
    const admin=await pool.connect();
    let triggerDisabled=false;
    try{
      await admin.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${testName}') THEN EXECUTE 'DROP OWNED BY ${testName}'; EXECUTE 'DROP ROLE ${testName}'; END IF; END $$;`);
      if(tenantA&&tenantB){
        await admin.query('ALTER TABLE key_movements DISABLE TRIGGER key_movements_immutable');
        triggerDisabled=true;
        await admin.query('DELETE FROM tenants WHERE id IN ($1,$2)',[tenantA,tenantB]);
      }
    }finally{
      if(triggerDisabled)await admin.query('ALTER TABLE key_movements ENABLE TRIGGER key_movements_immutable');
      admin.release();
      await pool.end();
    }
  },60_000);

  it('keeps new key cockpit tables tenant-isolated under RLS',async()=>{
    const client=await pool.connect();
    try{
      await client.query(`SET ROLE ${testName}`);
      await client.query('SELECT set_config($1,$2,false)',['app.tenant_id',tenantA]);
      expect((await client.query('SELECT id FROM keys')).rows.map(row=>row.id)).toEqual([keyA]);
      expect((await client.query('UPDATE keys SET label=$1 WHERE id=$2',['hidden',keyB])).rowCount).toBe(0);
      await expect(client.query(
        'INSERT INTO key_qr_tokens(tenant_id,key_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,$4,$5)',
        [tenantB,keyB,'f'.repeat(64),new Date(Date.now()+60000),userA],
      )).rejects.toMatchObject({code:'42501'});
      await expect(client.query(
        'INSERT INTO key_receipts(tenant_id,key_id,kind,actor_user_id) VALUES ($1,$2,$3,$4)',
        [tenantA,keyB,'issue',userA],
      )).rejects.toMatchObject({code:'23503'});
    }finally{
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('keeps key_movements append-only even for the owning tenant',async()=>{
    const client=await pool.connect();
    try{
      await client.query('SELECT set_config($1,$2,false)',['app.tenant_id',tenantA]);
      await expect(client.query('UPDATE key_movements SET reason=$1 WHERE id=$2',['tampered',movementA])).rejects.toThrow(/immutable/);
      await expect(client.query('DELETE FROM key_movements WHERE id=$1',[movementA])).rejects.toThrow(/immutable/);
      expect((await client.query('SELECT reason FROM key_movements WHERE id=$1',[movementA])).rows).toHaveLength(1);
    }finally{
      client.release();
    }
  });

  it('accepts the cockpit status and movement vocabulary after migration 054',async()=>{
    const client=await pool.connect();
    try{
      await client.query('SELECT set_config($1,$2,false)',['app.tenant_id',tenantA]);
      await client.query(`UPDATE keys SET status='blocked',due_at=now()+INTERVAL '1 day' WHERE id=$1`,[keyA]);
      expect((await client.query('SELECT status FROM keys WHERE id=$1',[keyA])).rows[0].status).toBe('blocked');
      await expect(client.query(`UPDATE keys SET key_type='obsolete' WHERE id=$1`,[keyA])).rejects.toMatchObject({code:'23514'});
      await expect(client.query(`UPDATE keys SET status='unknown' WHERE id=$1`,[keyA])).rejects.toMatchObject({code:'23514'});
      await client.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,actor_user_id,session_id,device_id)
        VALUES($1,$2,'reactivated','blocked','available',$3,$4,$5)`,[tenantA,keyA,userA,sessionA,deviceA]);
    }finally{
      client.release();
    }
  });

  it('enforces reminder uniqueness and the expanded sync action constraint',async()=>{
    const admin=await pool.connect();
    try{
      const dueAt=new Date('2026-07-01T00:00:00.000Z').toISOString();
      await admin.query('INSERT INTO key_reminder_state(tenant_id,key_id,due_at,days) VALUES($1,$2,$3,$4)',[tenantA,keyA,dueAt,7]);
      await expect(admin.query('INSERT INTO key_reminder_state(tenant_id,key_id,due_at,days) VALUES($1,$2,$3,$4)',[tenantA,keyA,dueAt,7])).rejects.toMatchObject({code:'23505'});
      const payloadHash='a'.repeat(64);
      await admin.query(`INSERT INTO sync_receipts(tenant_id,user_id,mutation_id,action,payload_hash,status) VALUES($1,$2,$3,$4,$5,'processing')`,[tenantA,userA,randomUUID(),'keys.bundle.item_removed',payloadHash]);
      await expect(admin.query(`INSERT INTO sync_receipts(tenant_id,user_id,mutation_id,action,payload_hash,status) VALUES($1,$2,$3,$4,$5,'processing')`,[tenantA,userA,randomUUID(),'keys.nope',payloadHash])).rejects.toMatchObject({code:'23514'});
    }finally{
      admin.release();
    }
  });
});
