import pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {runMigrations} from '../src/db/migration-runner.js';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL DMS RLS integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;
const sessionToken=`dms-rls-${randomUUID()}`;
const csrfToken=`dms-rls-csrf-${randomUUID()}`;

describePostgres('PostgreSQL DMS RLS, workflow consistency and idempotency actions',()=>{
  const testName=`securityops_dms_rls_${randomUUID().replaceAll('-','')}`;
  let pool:pg.Pool;
  let tenantA:string;
  let tenantB:string;
  let userA:string;
  let sessionA:string;
  let documentA:string;
  let versionA:string;
  let documentB:string;

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
        tenant_a:string;tenant_b:string;user_a:string;session_a:string;document_a:string;version_a:string;document_b:string;
      }>(`
        WITH a AS (INSERT INTO tenants(name) VALUES ('DMS RLS A') RETURNING id),
        b AS (INSERT INTO tenants(name) VALUES ('DMS RLS B') RETURNING id),
        sa AS (INSERT INTO sites(tenant_id,name) SELECT id,'DMS Site A' FROM a RETURNING id),
        ua AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$1,'admin','hash' FROM a RETURNING id),
        ub AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$2,'admin','hash' FROM b RETURNING id),
        d AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'DMS Device','authenticated' FROM a RETURNING id),
        sea AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
          SELECT id,(SELECT id FROM ua),(SELECT id FROM d),$3,$4,now()+INTERVAL '1 day' FROM a RETURNING id),
        seb AS (INSERT INTO sessions(tenant_id,user_id,token_hash,csrf_token,expires_at)
          SELECT id,(SELECT id FROM ub),$5,$6,now()+INTERVAL '1 day' FROM b RETURNING id),
        da AS (INSERT INTO dms_documents(tenant_id,title,created_by,created_session_id)
          SELECT id,'DMS A',(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
        db AS (INSERT INTO dms_documents(tenant_id,title,created_by,created_session_id)
          SELECT id,'DMS B',(SELECT id FROM ub),(SELECT id FROM seb) FROM b RETURNING id),
        va AS (INSERT INTO dms_versions(tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,uploaded_by,uploaded_session_id)
          SELECT id,(SELECT id FROM da),1,$7||'/'||(SELECT id FROM da),4,'text/plain',$8,(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id)
        SELECT a.id tenant_a,b.id tenant_b,(SELECT id FROM ua) user_a,(SELECT id FROM sea) session_a,
          (SELECT id FROM da) document_a,(SELECT id FROM va) version_a,(SELECT id FROM db) document_b
        FROM a,b
      `,[
        `${testName}-a@example.invalid`,`${testName}-b@example.invalid`,
        createHash('sha256').update(sessionToken).digest('hex'),csrfToken,
        createHash('sha256').update(`${sessionToken}-b`).digest('hex'),`${csrfToken}-b`,
        testName,createHash('sha256').update(`${testName}-content`).digest('hex'),
      ]);
      ({tenant_a:tenantA,tenant_b:tenantB,user_a:userA,session_a:sessionA,
        document_a:documentA,version_a:versionA,document_b:documentB}=seed.rows[0]);
      await admin.query(`CREATE ROLE ${testName} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${testName}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON dms_documents,dms_versions,sync_receipts TO ${testName}`);
    }finally{
      admin.release();
    }
  });

  afterAll(async()=>{
    if(!pool)return;
    const admin=await pool.connect();
    try{
      await admin.query('DELETE FROM tenants WHERE id IN ($1,$2)',[tenantA,tenantB]);
      await admin.query(`DROP OWNED BY ${testName}`);
      await admin.query(`DROP ROLE IF EXISTS ${testName}`);
    }finally{
      admin.release();
      await pool.end();
    }
  });

  it('trennt Dokumente und Versionen strikt nach Mandant',async()=>{
    const client=await pool.connect();
    try{
      await client.query(`SET ROLE ${testName}`);
      await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
      expect((await client.query('SELECT id FROM dms_documents')).rows.map((row:{id:string})=>row.id)).toEqual([documentA]);
      expect((await client.query('SELECT id FROM dms_versions')).rows.map((row:{id:string})=>row.id)).toEqual([versionA]);
      expect((await client.query('UPDATE dms_documents SET title=$1 WHERE id=$2',['geändert',documentB])).rowCount).toBe(0);
      expect((await client.query('DELETE FROM dms_documents WHERE id=$1',[documentB])).rowCount).toBe(0);
      await expect(client.query(
        'INSERT INTO dms_documents(tenant_id,title,created_by,created_session_id) VALUES ($1,$2,$3,$4)',
        [tenantB,'cross-tenant',userA,sessionA],
      )).rejects.toMatchObject({code:'42501'});
      await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantB]);
      expect((await client.query('SELECT id FROM dms_documents')).rows.map((row:{id:string})=>row.id)).toEqual([documentB]);
      expect((await client.query('SELECT id FROM dms_versions')).rows).toEqual([]);
    }finally{
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('verhindert inkonsistente Löschzustände und aktualisiert changed_at automatisch',async()=>{
    const client=await pool.connect();
    try{
      await client.query(`SET ROLE ${testName}`);
      await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
      await expect(client.query(
        'UPDATE dms_documents SET deleted_at=now() WHERE id=$1',[documentA],
      )).rejects.toMatchObject({code:'23514'});
      const before=(await client.query<{updated_at:Date}>('SELECT updated_at FROM dms_documents WHERE id=$1',[documentA])).rows[0].updated_at;
      await new Promise(resolve=>setTimeout(resolve,5));
      const after=(await client.query<{updated_at:Date}>('UPDATE dms_documents SET description=$1 WHERE id=$2 RETURNING updated_at',['gepflegt',documentA])).rows[0].updated_at;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
      await client.query('UPDATE dms_documents SET document_status=$1,deleted_at=now() WHERE id=$2',['deleted',documentA]);
      expect((await client.query<{document_status:string}>('SELECT document_status FROM dms_documents WHERE id=$1',[documentA])).rows[0].document_status).toBe('deleted');
      await client.query('UPDATE dms_documents SET document_status=$1,deleted_at=NULL WHERE id=$2',['active',documentA]);
    }finally{
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('erlaubt beide DMS-Mutationsarten in der zentralen Idempotenz-Tabelle',async()=>{
    const client=await pool.connect();
    try{
      await client.query(`SET ROLE ${testName}`);
      await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
      for(const action of ['dms.document','dms.document.version']){
        const mutationId=randomUUID();
        await expect(client.query(
          `INSERT INTO sync_receipts(tenant_id,user_id,mutation_id,action,payload_hash,status)
           VALUES ($1,$2,$3,$4,$5,'completed')`,
          [tenantA,userA,mutationId,action,createHash('sha256').update(mutationId).digest('hex')],
        )).resolves.toBeTruthy();
      }
    }finally{
      await client.query('RESET ROLE');
      client.release();
    }
  });
});
