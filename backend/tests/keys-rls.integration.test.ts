import pg from 'pg';
import request from 'supertest';
import {createHash,randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {runMigrations} from '../src/db/migration-runner.js';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL key management integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;
if(databaseUrl&&!process.env.DATABASE_URL)process.env.DATABASE_URL=databaseUrl;
const {app}=databaseUrl?await import('../src/app.js'):{app:undefined};
const sessionToken=`key-cockpit-${randomUUID()}`;
const sessionCookie=[`securityops_session=${sessionToken}`,'securityops_csrf=cockpit-csrf'];

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
      await admin.query('UPDATE sessions SET token_hash=$1,csrf_token=$2 WHERE id=$3',[
        createHash('sha256').update(sessionToken).digest('hex'),'cockpit-csrf',sessionA,
      ]);
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

  it('keeps old open A/B cases and counts distinct critical KPIs over real HTTP',async()=>{
    if(!app)throw new Error('app unavailable');
    const admin=await pool.connect();
    let oldReportId='';
    try{
      oldReportId=(await admin.query<{id:string}>(`
        INSERT INTO key_loss_reports(tenant_id,key_id,lost_at,reported_at,reporter_name,status,created_by,created_at)
        VALUES($1,$2,now()-INTERVAL '90 days',now()-INTERVAL '90 days','Alter Vorfall','review',$3,now()-INTERVAL '90 days')
        RETURNING id
      `,[tenantA,keyA,userA])).rows[0].id;
      await admin.query(`
        INSERT INTO keys(tenant_id,key_code,label,key_type,created_by,created_session_id,created_at,updated_at)
        VALUES($1,'OLD-B','Alte Stammdaten','physical',$2,$3,now()-INTERVAL '60 days',now()-INTERVAL '60 days')
      `,[tenantA,userA,sessionA]);
    }finally{admin.release();}

    const actions=await request(app).get('/api/v1/keys/action-list').set('Cookie',sessionCookie);
    expect(actions.status).toBe(200);
    expect(actions.body.A.some((entry:{code:string;subject_id:string})=>entry.code==='critical_loss_report'&&entry.subject_id===oldReportId)).toBe(true);
    expect(actions.body.B.some((entry:{code:string;label:string})=>entry.code==='incomplete_master_data'&&entry.label.includes('Alte Stammdaten'))).toBe(true);
    const dashboard=await request(app).get('/api/v1/keys/dashboard').set('Cookie',sessionCookie);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.critical_count).toBe(1);

    const admin2=await pool.connect();
    try{
      for(let index=0;index<55;index+=1){
        await admin2.query(`
          INSERT INTO key_loss_reports(tenant_id,key_id,lost_at,reported_at,reporter_name,status,created_by,created_at)
          VALUES($1,$2,now()-INTERVAL '45 days',now()-INTERVAL '45 days',$3,'review',$4,now()-INTERVAL '45 days')
        `,[tenantA,keyA,`Vorfall ${index}`,userA]);
      }
      await admin2.query(`UPDATE keys SET status='issued',due_at=now()-INTERVAL '2 days',holder_user_id=NULL,holder_employee_id=NULL WHERE id=$1`,[keyA]);
    }finally{admin2.release();}

    const capped=await request(app).get('/api/v1/keys/action-list').set('Cookie',sessionCookie);
    expect(capped.status).toBe(200);
    expect(capped.body.A).toHaveLength(50);
    expect(capped.body.totals.A).toBe(58);
    const updated=await request(app).get('/api/v1/keys/dashboard').set('Cookie',sessionCookie);
    expect(updated.status).toBe(200);
    expect(updated.body.critical_count).toBe(1);
  });

  it('paginates thousands of picker keys in tenant scope with live filters',async()=>{
    if(!app)throw new Error('app unavailable');
    const admin=await pool.connect();
    const site=(await admin.query<{id:string}>('SELECT id FROM sites WHERE tenant_id=$1',[tenantA])).rows[0].id;
    const bundle=(await admin.query<{id:string}>(
      `INSERT INTO key_bundles(tenant_id,site_id,name,created_by,created_session_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [tenantA,site,'Scale bundle',userA,sessionA],
    )).rows[0].id;
    try{
      await admin.query(`
        INSERT INTO keys(tenant_id,site_id,key_code,label,key_type,location,created_by,created_session_id,created_at,updated_at)
        SELECT $1,$2,'SCALE-'||lpad(n::text,5,'0'),'Skala '||n,'physical','Lager '||n,$3,$4,now()-INTERVAL '60 days',now()-INTERVAL '60 days'
        FROM generate_series(1,10050) n
      `,[tenantA,site,userA,sessionA]);
      await admin.query(`
        UPDATE keys SET label='=SUM(A1:A2); Umlaut ä' WHERE tenant_id=$1 AND key_code='SCALE-10050'
      `,[tenantA]);
      await admin.query(`
        INSERT INTO key_bundle_items(tenant_id,bundle_id,key_id,added_by)
        SELECT $1,$2,id,$3 FROM keys WHERE tenant_id=$1 AND key_code='SCALE-00001'
      `,[tenantA,bundle,userA]);
    }finally{admin.release();}

    const first=await request(app).get('/api/v1/keys/picker').set('Cookie',sessionCookie)
      .query({cursor:'0',pageSize:'100',q:'SCALE-',site_id:site,sort:'key_code',dir:'asc'});
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(100);
    expect(first.body.items[0].key_code).toBe('SCALE-00001');
    expect(first.body.total).toBe(10050);
    expect(first.body.next_cursor).toBe('100');
    expect(first.headers['x-total-count']).toBe('10050');

    const excluded=await request(app).get('/api/v1/keys/picker').set('Cookie',sessionCookie)
      .query({cursor:'0',pageSize:'100',q:'SCALE-',exclude_bundle_id:bundle});
    expect(excluded.body.total).toBe(10049);
    expect(excluded.body.items.some((row:{key_code:string})=>row.key_code==='SCALE-00001')).toBe(false);

    const deep=await request(app).get('/api/v1/keys/picker').set('Cookie',sessionCookie)
      .query({cursor:'10000',pageSize:'100',q:'SCALE-',sort:'key_code',dir:'asc'});
    expect(deep.body.items.at(-1).key_code).toBe('SCALE-10050');
    expect(deep.body.items.at(-1).label).toBe('=SUM(A1:A2); Umlaut ä');
    expect(deep.body.next_cursor).toBeNull();
    expect(deep.body.items.some((row:{id:string})=>row.id===keyB)).toBe(false);
  });

  it('uses the new indexes for paginated and prioritized SQL',async()=>{
    const admin=await pool.connect();
    const client=await pool.connect();
    try{
      const indexes=(await admin.query<{indexname:string}>(
        `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[])`,
        [['keys_tenant_key_code_lower_idx','key_movements_tenant_type_created_idx','key_bundles_tenant_status_idx','key_bundle_items_tenant_bundle_key_idx']],
      )).rows.map(row=>row.indexname);
      expect(indexes).toHaveLength(4);
      const site=(await admin.query<{id:string}>('SELECT id FROM sites WHERE tenant_id=$1',[tenantA])).rows[0].id;
      // Refresh statistics after the bulk fixture so the planner sees the new indexes.
      await client.query('ANALYZE keys');
      await client.query('ANALYZE key_movements');
      await client.query('SET enable_seqscan=off');
      const plan=(await client.query<{'QUERY PLAN':Array<{Plan:{[key:string]:unknown}}>}>(
        `EXPLAIN (FORMAT JSON) SELECT id FROM keys WHERE tenant_id=$1 AND site_id=$2 ORDER BY lower(key_code),id LIMIT 100 OFFSET 1000`,
        [tenantA,site],
      )).rows[0]['QUERY PLAN'][0].Plan;
      expect(JSON.stringify(plan)).toContain('keys_tenant_key_code_lower_idx');
      const movementPlan=(await client.query<{'QUERY PLAN':Array<{Plan:{[key:string]:unknown}}>}>(
        `EXPLAIN (FORMAT JSON) SELECT id FROM key_movements WHERE tenant_id=$1 AND movement_type IN ('issued','lost') ORDER BY created_at DESC`,
        [tenantA],
      )).rows[0]['QUERY PLAN'][0].Plan;
      expect(JSON.stringify(movementPlan)).toContain('key_movements_tenant_type_created_idx');
    }finally{
      await client.query('RESET enable_seqscan');
      client.release();
      admin.release();
    }
  });

  it('streams a complete CSV export in bounded chunks and audits aborts',async()=>{
    if(!app)throw new Error('app unavailable');
    const server=app.listen(0);
    const port=(server.address() as AddressInfo).port;
    const cookie=sessionCookie.join('; ');
    try{
      const capped=await request(app).get('/api/v1/keys/export').set('Cookie',sessionCookie).query({q:'SCALE-'});
      expect(capped.status).toBe(200);
      expect(capped.headers['x-key-export-count']).toBe('10000');
      expect(capped.headers['x-key-export-total']).toBe('10050');
      expect(capped.headers['x-key-export-truncated']).toBe('true');
      expect(capped.text).toContain('begrenzt');
      expect(capped.text).not.toContain('B-1');

      const response=await fetch(`http://127.0.0.1:${port}/api/v1/keys/export?full=true&q=SCALE-`,{headers:{Cookie:cookie}});
      expect(response.status).toBe(200);
      expect(response.headers.get('x-key-export-total')).toBe('10050');
      const reader=response.body!.getReader();
      const decoder=new TextDecoder();
      let received='';
      let chunks=0;
      let maxChunk=0;
      const rawPrefix:number[]=[];
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        chunks+=1;
        maxChunk=Math.max(maxChunk,value.byteLength);
        if(rawPrefix.length<3)rawPrefix.push(...value.subarray(0,3-rawPrefix.length));
        received+=decoder.decode(value,{stream:true});
      }
      expect(chunks).toBeGreaterThan(1);
      expect(maxChunk).toBeLessThan(1_000_000);
      expect(rawPrefix).toEqual([0xEF,0xBB,0xBF]);
      expect(received).toContain('Schlüsselnummer');
      expect(received).toContain('SCALE-00001');
      expect(received).toContain('SCALE-10050');
      expect(received).toContain('"\'=SUM(A1:A2); Umlaut ä"');
      expect(received).not.toContain('B-1');

      const controller=new AbortController();
      const aborted=await fetch(`http://127.0.0.1:${port}/api/v1/keys/export?full=true&q=SCALE-`,{
        headers:{Cookie:cookie},signal:controller.signal,
      });
      // Abort as soon as the response headers are available, before the streamed body
      // can finish on loopback. The server must record this in the export audit.
      controller.abort();
      await aborted.body!.cancel().catch(()=>undefined);
      const admin=await pool.connect();
      try{
        let detail:Record<string,unknown>|undefined;
        for(let attempt=0;attempt<40&&detail?.aborted!==true;attempt+=1){
          await new Promise<void>(resolve=>setTimeout(resolve,50));
          const latest=(await admin.query<{details:Record<string,unknown>}>(
            `SELECT details FROM audit_events WHERE tenant_id=$1 AND event_type='keys.exported' ORDER BY created_at DESC LIMIT 1`,
            [tenantA],
          )).rows[0];
          if(latest?.details?.aborted===true)detail=latest.details;
        }
        expect(detail).toMatchObject({aborted:true,full:true});
      }finally{admin.release();}
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });

  it('repairs every inherited key SET NULL foreign key with an explicit nullable column',async()=>{
    const admin=await pool.connect();
    try{
      const result=await admin.query<{definition:string}>(`
        SELECT pg_get_constraintdef(c.oid) definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid=c.conrelid
        WHERE c.contype='f' AND c.confdeltype='n'
          AND t.relnamespace='public'::regnamespace
          AND t.relname IN ('keys','key_movements','key_receipts','key_loss_reports','key_qr_tokens',
            'key_inventory_checks','key_inventory_check_items','key_bundles','key_bundle_items',
            'key_bundle_movements','key_reminder_state')
      `);
      expect(result.rows).toHaveLength(11);
      for(const row of result.rows){
        const match=/ON DELETE SET NULL\s*\(([a-z_]+)\)/.exec(row.definition);
        expect(match).not.toBeNull();
        expect(match?.[1]).toBeTruthy();
        expect(match?.[1]).not.toBe('tenant_id');
      }
    }finally{
      admin.release();
    }
  });

  it('detaches optional key references on parent deletion without losing tenant or history',async()=>{
    const admin=await pool.connect();
    try{
      const fkSite=(await admin.query<{id:string}>(
        `INSERT INTO sites(tenant_id,name) VALUES($1,$2) RETURNING id`,
        [tenantA,`FK site ${testName}`],
      )).rows[0];
      const fkDevice=(await admin.query<{id:string}>(
        `INSERT INTO devices(tenant_id,site_id,name,device_kind) VALUES($1,$2,$3,'authenticated') RETURNING id`,
        [tenantA,fkSite.id,`FK device ${testName}`],
      )).rows[0];
      const fkKey=(await admin.query<{id:string}>(
        `INSERT INTO keys(tenant_id,site_id,key_code,label,key_type,created_by,created_session_id)
         VALUES($1,$2,$3,$4,'physical',$5,$6) RETURNING id`,
        [tenantA,fkSite.id,`FK-${testName}`,'FK key',userA,sessionA],
      )).rows[0];
      await admin.query(
        `INSERT INTO key_movements(tenant_id,key_id,movement_type,to_status,actor_user_id,session_id,device_id)
         VALUES($1,$2,'created','available',$3,$4,$5)`,
        [tenantA,fkKey.id,userA,sessionA,fkDevice.id],
      );
      const document=(await admin.query<{id:string}>(
        `INSERT INTO dms_documents(tenant_id,site_id,title,created_by,created_session_id)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [tenantA,fkSite.id,'Key receipt evidence',userA,sessionA],
      )).rows[0];
      const bundle=(await admin.query<{id:string}>(
        `INSERT INTO key_bundles(tenant_id,site_id,name,created_by,created_session_id)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [tenantA,fkSite.id,'FK bundle',userA,sessionA],
      )).rows[0];
      const incident=(await admin.query<{id:string}>(
        `INSERT INTO incidents(tenant_id,description) VALUES($1,$2) RETURNING id`,
        [tenantA,'Key loss incident'],
      )).rows[0];
      const holder=(await admin.query<{id:string}>(
        `INSERT INTO users(tenant_id,email,role,password_hash) VALUES($1,$2,'viewer',$3) RETURNING id`,
        [tenantA,`fk-holder-${testName}@example.invalid`,'hash'],
      )).rows[0];
      const receipt=(await admin.query<{id:string}>(
        `INSERT INTO key_receipts(tenant_id,key_id,kind,actor_user_id,receipt_document_id)
         VALUES($1,$2,'issue',$3,$4) RETURNING id`,
        [tenantA,fkKey.id,userA,document.id],
      )).rows[0];
      const loss=(await admin.query<{id:string}>(
        `INSERT INTO key_loss_reports(tenant_id,key_id,last_holder_user_id,incident_id,lost_at,reported_at,reporter_name,created_by)
         VALUES($1,$2,$3,$4,now(),now(),'Reporter',$5) RETURNING id`,
        [tenantA,fkKey.id,holder.id,incident.id,userA],
      )).rows[0];
      const inventory=(await admin.query<{id:string}>(
        `INSERT INTO key_inventory_checks(tenant_id,site_id,bundle_id,checked_at,checker_name,created_by)
         VALUES($1,$2,$3,now(),'Checker',$4) RETURNING id`,
        [tenantA,fkSite.id,bundle.id,userA],
      )).rows[0];

      await admin.query('DELETE FROM dms_documents WHERE id=$1',[document.id]);
      await admin.query('DELETE FROM incidents WHERE id=$1',[incident.id]);
      await admin.query('DELETE FROM users WHERE id=$1',[holder.id]);
      await admin.query('DELETE FROM sites WHERE id=$1',[fkSite.id]);
      await admin.query('DELETE FROM key_bundles WHERE id=$1',[bundle.id]);
      await admin.query('DELETE FROM devices WHERE id=$1',[fkDevice.id]);

      const state=(await admin.query<{
        key_site:string|null;key_tenant:string;
        receipt_document:string|null;receipt_tenant:string;loss_user:string|null;loss_incident:string|null;
        loss_tenant:string;inventory_site:string|null;inventory_bundle:string|null;inventory_tenant:string;
        movement_device:string|null;movement_tenant:string;
      }>(`
        SELECT (SELECT site_id FROM keys WHERE id=$2) key_site,
          (SELECT tenant_id FROM keys WHERE id=$2) key_tenant,
          (SELECT receipt_document_id FROM key_receipts WHERE id=$3) receipt_document,
          (SELECT tenant_id FROM key_receipts WHERE id=$3) receipt_tenant,
          (SELECT last_holder_user_id FROM key_loss_reports WHERE id=$4) loss_user,
          (SELECT incident_id FROM key_loss_reports WHERE id=$4) loss_incident,
          (SELECT tenant_id FROM key_loss_reports WHERE id=$4) loss_tenant,
          (SELECT site_id FROM key_inventory_checks WHERE id=$5) inventory_site,
          (SELECT bundle_id FROM key_inventory_checks WHERE id=$5) inventory_bundle,
          (SELECT tenant_id FROM key_inventory_checks WHERE id=$5) inventory_tenant,
          (SELECT device_id FROM key_movements WHERE tenant_id=$1 AND key_id=$2) movement_device,
          (SELECT tenant_id FROM key_movements WHERE tenant_id=$1 AND key_id=$2) movement_tenant
      `,[tenantA,fkKey.id,receipt.id,loss.id,inventory.id])).rows[0];
      expect(state.key_site).toBeNull();
      expect(state.key_tenant).toBe(tenantA);
      expect(state.receipt_document).toBeNull();
      expect(state.receipt_tenant).toBe(tenantA);
      expect(state.loss_user).toBeNull();
      expect(state.loss_incident).toBeNull();
      expect(state.loss_tenant).toBe(tenantA);
      expect(state.inventory_site).toBeNull();
      expect(state.inventory_bundle).toBeNull();
      expect(state.inventory_tenant).toBe(tenantA);
      expect(state.movement_device).toBeNull();
      expect(state.movement_tenant).toBe(tenantA);
      await expect(admin.query('UPDATE key_movements SET reason=$1 WHERE tenant_id=$2',['tampered',tenantA])).rejects.toThrow(/immutable/);
    }finally{
      admin.release();
    }
  });
});
