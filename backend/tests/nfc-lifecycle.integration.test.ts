import pg from 'pg';
import request from 'supertest';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterAll,beforeAll,describe,expect,it} from '@jest/globals';
import {runMigrations} from '../src/db/migration-runner.js';

type Row={permission_id:string;scope:string};

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL NFC lifecycle integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;
if(databaseUrl&&!process.env.DATABASE_URL)process.env.DATABASE_URL=databaseUrl;
const {app}=databaseUrl?await import('../src/app.js'):{app:undefined};

const sessionA=`nfc-lifecycle-a-${randomUUID()}`;
const sessionB=`nfc-lifecycle-b-${randomUUID()}`;
const sessionC=`nfc-lifecycle-c-${randomUUID()}`;
const csrfA=`nfc-csrf-a-${randomUUID()}`;
const csrfB=`nfc-csrf-b-${randomUUID()}`;
const csrfC=`nfc-csrf-c-${randomUUID()}`;
const headersA={Cookie:[`securityops_session=${sessionA}`,`securityops_csrf=${csrfA}`],'x-csrf-token':csrfA};
const headersB={Cookie:[`securityops_session=${sessionB}`,`securityops_csrf=${csrfB}`],'x-csrf-token':csrfB};
const headersC={Cookie:[`securityops_session=${sessionC}`,`securityops_csrf=${csrfC}`],'x-csrf-token':csrfC};
const uid=()=>`QA-${randomUUID().replaceAll('-','').slice(0,20)}`;

describePostgres('NFC lifecycle with real tenant-scoped PostgreSQL data',()=>{
  let pool:pg.Pool;
  let tenantA='';
  let tenantB='';
  let siteA='';
  let controlPointA='';
  let controlPointB='';
  let employeeA='';
  let routeA='';

  beforeAll(async()=>{
    if(!databaseUrl)throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    pool=new pg.Pool({connectionString:databaseUrl});
    const migrationsDir=existsSync(resolve(process.cwd(),'migrations'))
      ?resolve(process.cwd(),'migrations')
      :resolve(process.cwd(),'backend/migrations');
    await runMigrations(pool,migrationsDir);
    const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
    const seeded=await pool.query<{
      tenant_a:string;tenant_b:string;site_a:string;point_a:string;point_b:string;employee_a:string;route_a:string;
    }>(`
      WITH a AS (INSERT INTO tenants(name) VALUES ($1::text) RETURNING id),
      b AS (INSERT INTO tenants(name) VALUES ($2::text) RETURNING id),
      sa AS (INSERT INTO sites(tenant_id,name) SELECT id,'NFC Objekt' FROM a RETURNING id),
      ua AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$4::text,'operator','hash' FROM a RETURNING id),
      ub AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$5::text,'operator','hash' FROM b RETURNING id),
      da AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'QA Client A','authenticated' FROM a RETURNING id),
      sb AS (INSERT INTO sites(tenant_id,name) SELECT id,'NFC Objekt B' FROM b RETURNING id),
      db AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sb),'QA Client B','authenticated' FROM b RETURNING id),
      uc AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$12::text,'viewer','hash' FROM a RETURNING id),
      dc AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'QA Client C','authenticated' FROM a RETURNING id),
      sea AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT id,(SELECT id FROM ua),(SELECT id FROM da),$6::text,$8::text,now()+INTERVAL '1 day' FROM a RETURNING id),
      seb AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT id,(SELECT id FROM ub),(SELECT id FROM db),$7::text,$9::text,now()+INTERVAL '1 day' FROM b RETURNING id),
      sec AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT id,(SELECT id FROM uc),(SELECT id FROM dc),$13::text,$14::text,now()+INTERVAL '1 day' FROM a RETURNING id),
      ea AS (INSERT INTO employees(tenant_id,name,email,employment_status,employment_type)
        SELECT id,'Ava Worker',$3::text,'active','employee' FROM a RETURNING id),
      cp1 AS (INSERT INTO control_points(tenant_id,site_id,name,nfc_uid,sequence)
        SELECT id,(SELECT id FROM sa),'Eingang',$10::text,1 FROM a RETURNING id),
      cp2 AS (INSERT INTO control_points(tenant_id,site_id,name,nfc_uid,sequence)
        SELECT id,(SELECT id FROM sa),'Ausgang',$11::text,2 FROM a RETURNING id),
      ra AS (INSERT INTO patrol_routes(tenant_id,site_id,name) SELECT id,(SELECT id FROM sa),'QA Route' FROM a RETURNING id)
      SELECT a.id tenant_a,b.id tenant_b,(SELECT id FROM sa) site_a,(SELECT id FROM cp1) point_a,
        (SELECT id FROM cp2) point_b,(SELECT id FROM ea) employee_a,(SELECT id FROM ra) route_a
      FROM a,b
    `,[
      'NFC lifecycle A','NFC lifecycle B',`nfc-employee-a-${randomUUID()}@example.invalid`,
      `nfc-user-a-${randomUUID()}@example.invalid`,`nfc-user-b-${randomUUID()}@example.invalid`,
      hash(sessionA),hash(sessionB),csrfA,csrfB,uid(),uid(),
      `nfc-user-c-${randomUUID()}@example.invalid`,hash(sessionC),csrfC,
    ]);
    const row=seeded.rows[0];
    tenantA=row.tenant_a;tenantB=row.tenant_b;siteA=row.site_a;
    controlPointA=row.point_a;controlPointB=row.point_b;employeeA=row.employee_a;routeA=row.route_a;
  },60_000);

  afterAll(async()=>{
    if(pool&&tenantA&&tenantB)await pool.query('DELETE FROM tenants WHERE id IN ($1,$2)',[tenantA,tenantB]);
    await pool?.end();
  });

  const register=async(identifier:string,body:Record<string,unknown>={})=>request(app!)
    .post('/api/v1/nfc-devices').set(headersA).send({identifier,device_type:'tag',manufacturer:'Acme',...body});

  // Die folgenden Hilfsfunktionen erzeugen eine echte, reproduzierbare
  // Konkurrenzsituation auf Datenbankebene. Die Verzögerung liegt in einem
  // temporären Trigger, der erst nach dem SELECT ... FOR UPDATE der Route und
  // kurz vor dem UPDATE auf status='replaced' feuert. Damit hält Transaktion 1
  // die Row-Sperre wirklich, während Transaktion 2 in FOR UPDATE wartet. Der
  // Nachweis erfolgt nicht über Zeitmessung, sondern über pg_locks: der Warter
  // hält eine tuple-Sperre auf nfc_devices und wartet auf die transactionid
  // des Inhabers; beide Sessions halten außerdem eine RowShareLock-Relations-
  // sperre auf nfc_devices. Das belegt zwei gleichzeitig aktive Transaktionen
  // mit echter Sperrkollision an derselben Tabelle.
  const waitForLockContention=async(timeoutMs=1400)=>{
    type Contention={waiterPid:number;holderPid:number;mode:string;waitEvent:string|null};
    const deadline=Date.now()+timeoutMs;
    let observed:Contention|null=null;
    while(Date.now()<deadline&&!observed){
      const {rows}=await pool.query<{
        pid:number;locktype:string;granted:boolean;mode:string;relation:string|null;
        wait_event_type:string|null;wait_event:string|null;
      }>(`
        SELECT l.pid,l.locktype,l.granted,l.mode,l.relation::regclass::text AS relation,
          a.wait_event_type,a.wait_event
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE a.datname=current_database()
      `);
      const waiter=rows.find(row=>row.locktype==='transactionid'&&!row.granted
        &&row.wait_event_type==='Lock'&&row.wait_event==='transactionid');
      const holder=waiter
        ?rows.find(row=>row.locktype==='transactionid'&&row.granted&&row.pid!==waiter.pid)
        :undefined;
      const waiterTuple=waiter
        ?rows.find(row=>row.pid===waiter.pid&&row.locktype==='tuple'&&row.relation==='nfc_devices')
        :undefined;
      const relationLockers=rows
        .filter(row=>row.locktype==='relation'&&row.relation==='nfc_devices'&&row.mode==='RowShareLock')
        .map(row=>row.pid);
      if(waiter&&holder&&waiterTuple&&relationLockers.includes(waiter.pid)&&relationLockers.includes(holder.pid)){
        observed={waiterPid:waiter.pid,holderPid:holder.pid,mode:waiter.mode,waitEvent:waiter.wait_event_type};
      }else{
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    }
    return observed;
  };

  const withReplacementDelay=async<T>(marker:string,work:()=>Promise<T>)=>{
    const suffix=randomUUID().replaceAll('-','');
    const functionName=`nfc_parallel_delay_${suffix}`;
    const triggerName=`nfc_parallel_delay_${suffix}`;
    const literal=`'${marker.replaceAll("'","''")}'`;
    await pool.query(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP='UPDATE' AND OLD.identifier=${literal} AND NEW.status='replaced' THEN
          PERFORM pg_sleep(1.5);
        END IF;
        RETURN NEW;
      END $fn$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON nfc_devices
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
    try{return await work();}
    finally{
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON nfc_devices`);
      await pool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    }
  };

  const withReplacementRollback=async<T>(marker:string,work:()=>Promise<T>)=>{
    const suffix=randomUUID().replaceAll('-','');
    const functionName=`nfc_rollback_${suffix}`;
    const triggerName=`nfc_rollback_${suffix}`;
    const literal=`'${marker.replaceAll("'","''")}'`;
    await pool.query(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.notes=${literal} THEN RAISE EXCEPTION 'QA rollback'; END IF;
        RETURN NEW;
      END $fn$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON nfc_device_replacements
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
    try{return await work();}
    finally{
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON nfc_device_replacements`);
      await pool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    }
  };

  type ConcurrentResult={status:number;body:Record<string,any>};
  const runConcurrentReplacement=async(oldMarker:string,newDeviceIds:[string,string])=>{
    const created=await register(oldMarker);
    const oldId=created.body.id as string;
    expect((await request(app!).post(`/api/v1/nfc-devices/${oldId}/report-lost`).set(headersA)
      .send({lost_at:'2026-11-27',reason:'Paralleltest'})).status).toBe(200);
    let contention:Awaited<ReturnType<typeof waitForLockContention>>=null;
    const send=(new_device_id:string)=>request(app!).post(`/api/v1/nfc-devices/${oldId}/replace`).set(headersA)
      .send({new_device_id,reason:'Paralleler Austausch',copy_assignment:false})
      .then(response=>({status:response.status,body:response.body} as ConcurrentResult));
    const responses=await withReplacementDelay(oldMarker,async()=>{
      // Beide Requests werden im selben Event-Loop-Tick gestartet. Der Monitor
      // läuft parallel und beobachtet die Datenbank, während der Trigger die
      // erste Transaktion nach dem Row-Lock bewusst offen hält.
      const monitor=waitForLockContention().then(value=>{contention=value;});
      const results=await Promise.all([send(newDeviceIds[0]),send(newDeviceIds[1])]);
      await monitor;
      return results;
    });
    return {oldId,responses,contention};
  };

  it('registers active devices, assigns one target in tenant A and preserves assignment history',async()=>{
    const identifier=uid();
    const created=await register(identifier);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('active');
    const assigned=await request(app!).post(`/api/v1/nfc-devices/${created.body.id}/assign`).set(headersA)
      .send({control_point_id:controlPointA,reason:'Neue Zuordnung'});
    expect(assigned.status).toBe(200);
    expect(assigned.body.control_point_id).toBe(controlPointA);
    const employeeAssign=await request(app!).post(`/api/v1/nfc-devices/${created.body.id}/assign`).set(headersA)
      .send({employee_id:employeeA,reason:'Mitarbeiter zuordnen'});
    expect(employeeAssign.status).toBe(200);
    expect(employeeAssign.body.employee_id).toBe(employeeA);
    expect(employeeAssign.body.control_point_id).toBeNull();
    const siteAssign=await request(app!).post(`/api/v1/nfc-devices/${created.body.id}/assign`).set(headersA)
      .send({site_id:siteA,reason:'Objekt zuordnen'});
    expect(siteAssign.status).toBe(200);
    expect(siteAssign.body.site_id).toBe(siteA);
    expect(siteAssign.body.employee_id).toBeNull();
    const history=await pool.query('SELECT * FROM nfc_device_assignment_history WHERE tenant_id=$1 AND device_id=$2',[tenantA,created.body.id]);
    expect(history.rowCount).toBeGreaterThanOrEqual(1);
    const multiple=await request(app!).post(`/api/v1/nfc-devices/${created.body.id}/assign`).set(headersA)
      .send({site_id:siteA,control_point_id:controlPointB,reason:'Zweite Zuordnung'});
    expect(multiple.status).toBe(400);
  });

  it('enforces the controlled status sequence and keeps replaced devices out of service',async()=>{
    const created=await register(uid(),{employee_id:employeeA});
    const id=created.body.id as string;
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/block`).set(headersA).send({reason:'Prüfung'})).body.status).toBe('blocked');
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/reactivate`).set(headersA).send({reason:'Freigabe'})).body.status).toBe('active');
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/report-lost`).set(headersA)
      .send({lost_at:'2026-11-26',reason:'Verlust'})).body.status).toBe('lost');
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/reactivate`).set(headersA).send({reason:'Direkt'})).status).toBe(409);
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/recover`).set(headersA)
      .send({found_at:'2026-11-27',identifier_confirmation:created.body.identifier,assignment_confirmed:true,reason:'Gefunden'})).body.status).toBe('blocked');
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/reactivate`).set(headersA).send({reason:'Geprüft'})).body.status).toBe('active');
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/replace`).set(headersA)
      .send({identifier:uid(),device_type:'tag',manufacturer:'Acme',reason:'Direkt',copy_assignment:false})).status).toBe(409);
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/block`).set(headersA).send({reason:'Austausch vorbereiten'})).status).toBe(200);
    const replaced=await request(app!).post(`/api/v1/nfc-devices/${id}/replace`).set(headersA)
      .send({identifier:uid(),device_type:'tag',manufacturer:'Acme',reason:'Defekt',copy_assignment:true});
    expect(replaced.status).toBe(201);
    expect(replaced.body.device.status).toBe('active');
    expect(replaced.body.device.employee_id).toBe(employeeA);
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/reactivate`).set(headersA).send({reason:'Nochmal'})).status).toBe(409);
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/recover`).set(headersA)
      .send({found_at:'2026-11-28',identifier_confirmation:created.body.identifier,assignment_confirmed:true,reason:'Gefunden'})).status).toBe(409);
  },60_000);

  it('rolls back an incomplete replacement when the target control point is occupied',async()=>{
    const oldDevice=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${oldDevice.body.id}/assign`).set(headersA)
      .send({control_point_id:controlPointA,reason:'Eingang'})).status).toBe(200);
    const candidate=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${candidate.body.id}/assign`).set(headersA)
      .send({control_point_id:controlPointB,reason:'Ausgang'})).status).toBe(200);
    expect((await request(app!).post(`/api/v1/nfc-devices/${candidate.body.id}/block`).set(headersA)
      .send({reason:'Prüfung'})).status).toBe(200);
    // Ein aktiver Tag belegt denselben Kontrollpunkt wie der gesperrte Kandidat.
    const occupied=await pool.query(`INSERT INTO nfc_devices(tenant_id,identifier,device_type,manufacturer,status,control_point_id)
      VALUES($1,$2,'tag','Acme','active',$3) RETURNING id`,[tenantA,uid(),controlPointB]);
    expect((await request(app!).post(`/api/v1/nfc-devices/${oldDevice.body.id}/block`).set(headersA)
      .send({reason:'Austausch vorbereiten'})).status).toBe(200);
    const before=await pool.query('SELECT status,control_point_id FROM nfc_devices WHERE id=$1',[oldDevice.body.id]);
    const failed=await request(app!).post(`/api/v1/nfc-devices/${oldDevice.body.id}/replace`).set(headersA)
      .send({new_device_id:candidate.body.id,acknowledged_device_id:candidate.body.id,reason:'Defekt',copy_assignment:false,
        acknowledge_existing_assignment:true,acknowledge_restricted:true});
    expect(failed.status).toBe(409);
    expect(failed.body.error).toContain('Kontrollpunkt');
    const after=await pool.query('SELECT status,control_point_id FROM nfc_devices WHERE id=$1',[oldDevice.body.id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const replacement=await pool.query('SELECT id FROM nfc_device_replacements WHERE tenant_id=$1 AND old_device_id=$2',[tenantA,oldDevice.body.id]);
    expect(replacement.rowCount).toBe(0);
    const candidateState=await pool.query('SELECT status FROM nfc_devices WHERE id=$1',[candidate.body.id]);
    expect(candidateState.rows[0].status).toBe('blocked');
    await pool.query('DELETE FROM nfc_devices WHERE id=$1',[occupied.rows[0].id]);
  },60_000);

  it('returns more than 200 real scans with pagination, filters and rejected audit events',async()=>{
    const point=await pool.query(`INSERT INTO control_points(tenant_id,site_id,name,nfc_uid,sequence)
      VALUES($1,$2,'Historie',$3,$4) RETURNING id`,[tenantA,siteA,uid(),Math.floor(Math.random()*900000)+100000]);
    const device=await register(uid());
    const id=device.body.id as string;
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/assign`).set(headersA)
      .send({control_point_id:point.rows[0].id,reason:'Historie'})).status).toBe(200);
    await pool.query(`INSERT INTO patrol_scans(tenant_id,route_id,control_point_id,employee_id,scanned_at,nfc_device_id)
      SELECT $1,$2,$3,$4,now() - (g || ' minutes')::interval,$5 FROM generate_series(1,205) g`,
      [tenantA,routeA,point.rows[0].id,employeeA,id]);
    await pool.query(`INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,details,created_at)
      SELECT $1,(SELECT id FROM users WHERE tenant_id=$1 AND role='operator' LIMIT 1),'patrol.scan.rejected','patrol_scan',
        jsonb_build_object('nfc_uid',$2::text,'nfc_device_id',$3::text,'control_point_id',$4::text,'site_id',$5::text,
          'route_id',$6::text,'employee_id',$7::text,'reason','NFC-Tag ist archiviert','code','NFC_TAG_ARCHIVED',
          'scanned_at',now() - INTERVAL '1 hour','server_received_at',now()),now()`,
      [tenantA,device.body.identifier,id,point.rows[0].id,siteA,routeA,employeeA]);
    const first=await request(app!).get(`/api/v1/nfc-devices/${id}/scan-history?page=1&pageSize=25`).set(headersA);
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(206);
    expect(first.body.totalPages).toBe(9);
    expect(first.body.rows).toHaveLength(25);
    expect(first.headers['x-total-count']).toBe('206');
    const rejectedOnly=await request(app!).get(`/api/v1/nfc-devices/${id}/scan-history?outcome=rejected`).set(headersA);
    expect(rejectedOnly.body.total).toBe(1);
    expect(rejectedOnly.body.rows[0]).toEqual(expect.objectContaining({outcome:'rejected',rejection_code:'NFC_TAG_ARCHIVED',rejection_reason:'NFC-Tag ist archiviert'}));
    const filtered=await request(app!).get(`/api/v1/nfc-devices/${id}/scan-history?control_point_id=${controlPointB}`).set(headersA);
    expect(filtered.body.total).toBe(0);
  },60_000);

  it('denies tenant B access to tenant A devices and audit data',async()=>{
    const device=await register(uid());
    const id=device.body.id as string;
    expect((await request(app!).get(`/api/v1/nfc-devices/${id}/file`).set(headersB)).status).toBe(404);
    expect((await request(app!).get(`/api/v1/nfc-devices/${id}/scan-history`).set(headersB)).status).toBe(404);
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/block`).set(headersB).send({reason:'Fremd'})).status).toBe(404);
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/assign`).set(headersB).send({employee_id:employeeA})).status).toBe(404);
    expect((await request(app!).patch(`/api/v1/nfc-devices/${id}`).set(headersB).send({employee_id:null})).status).toBe(404);
    const state=await pool.query('SELECT status FROM nfc_devices WHERE id=$1',[id]);
    expect(state.rows[0].status).toBe('active');
  });

  it('denies read and security actions without the required permission',async()=>{
    // Der Viewer-Rolle werden ausschließlich für diesen Test ihre Grants entzogen;
    // anschließend werden sie unverändert wiederhergestellt.
    const original=(await pool.query<Row>("SELECT permission_id,scope FROM role_permissions WHERE role='viewer'")).rows;
    await pool.query("DELETE FROM role_permissions WHERE role='viewer'");
    try{
      const device=await register(uid());
      expect((await request(app!).get('/api/v1/nfc-devices/inventory').set(headersC)).status).toBe(403);
      expect((await request(app!).get(`/api/v1/nfc-devices/${device.body.id}/file`).set(headersC)).status).toBe(403);
      expect((await request(app!).post(`/api/v1/nfc-devices/${device.body.id}/block`).set(headersC).send({reason:'Test'})).status).toBe(403);
      expect((await request(app!).post(`/api/v1/nfc-devices/${device.body.id}/replace`).set(headersC)
        .send({identifier:uid(),device_type:'tag',manufacturer:'Acme',reason:'Test',copy_assignment:false})).status).toBe(403);
      expect((await request(app!).post(`/api/v1/nfc-devices/${device.body.id}/assign`).set(headersC)
        .send({employee_id:employeeA})).status).toBe(403);
      expect((await request(app!).post(`/api/v1/nfc-devices/${device.body.id}/archive`).set(headersC)
        .send({reason:'Test'})).status).toBe(403);
      expect((await request(app!).post(`/api/v1/nfc-devices/${device.body.id}/recover`).set(headersC)
        .send({found_at:'2026-11-27',identifier_confirmation:device.body.identifier,assignment_confirmed:true,reason:'Test'})).status).toBe(403);
      const state=await pool.query('SELECT status FROM nfc_devices WHERE id=$1',[device.body.id]);
      expect(state.rows[0].status).toBe('active');
    }finally{
      for(const grant of original){
        await pool.query(`INSERT INTO role_permissions(role,permission_id,scope) VALUES('viewer',$1,$2)
          ON CONFLICT (role,permission_id) DO UPDATE SET scope=EXCLUDED.scope,updated_at=now()`,
        [grant.permission_id,grant.scope]);
      }
    }
  });

  it('rejects state-changing API calls without a matching CSRF token',async()=>{
    const device=await register(uid());
    const cookies=[`securityops_session=${sessionA}`,`securityops_csrf=${csrfA}`];
    expect((await request(app!).post(`/api/v1/nfc-devices/${device.body.id}/block`).set('Cookie',cookies)
      .send({reason:'Test'})).status).toBe(403);
    const state=await pool.query('SELECT status FROM nfc_devices WHERE id=$1',[device.body.id]);
    expect(state.rows[0].status).toBe('active');
  });

  it('rejects assignments and indirect assignment changes for every non-active state',async()=>{
    const blocked=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${blocked.body.id}/block`).set(headersA).send({reason:'Sperren'})).status).toBe(200);
    expect((await request(app!).post(`/api/v1/nfc-devices/${blocked.body.id}/assign`).set(headersA)
      .send({employee_id:employeeA})).status).toBe(409);
    expect((await request(app!).patch(`/api/v1/nfc-devices/${blocked.body.id}`).set(headersA)
      .send({employee_id:employeeA,reason:'Umgehung'})).status).toBe(409);

    const lost=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${lost.body.id}/report-lost`).set(headersA)
      .send({lost_at:'2026-11-26',reason:'Verlust'})).status).toBe(200);
    expect((await request(app!).post(`/api/v1/nfc-devices/${lost.body.id}/assign`).set(headersA)
      .send({employee_id:employeeA})).status).toBe(409);
    expect((await request(app!).post(`/api/v1/nfc-devices/${lost.body.id}/block`).set(headersA)
      .send({reason:'Umgehung des Wiederauffindens'})).status).toBe(409);
    expect((await request(app!).patch(`/api/v1/nfc-devices/${lost.body.id}`).set(headersA)
      .send({employee_id:employeeA,reason:'Umgehung'})).status).toBe(409);

    const old=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${old.body.id}/block`).set(headersA).send({reason:'Sperren'})).status).toBe(200);
    const replaced=await request(app!).post(`/api/v1/nfc-devices/${old.body.id}/replace`).set(headersA)
      .send({identifier:uid(),device_type:'tag',manufacturer:'Acme',reason:'Defekt',copy_assignment:false});
    expect(replaced.status).toBe(201);
    expect((await request(app!).post(`/api/v1/nfc-devices/${old.body.id}/assign`).set(headersA)
      .send({employee_id:employeeA})).status).toBe(409);
    expect((await request(app!).post(`/api/v1/nfc-devices/${old.body.id}/replace`).set(headersA)
      .send({identifier:uid(),device_type:'tag',manufacturer:'Acme',reason:'Nochmal',copy_assignment:false})).status).toBe(409);
    expect((await request(app!).patch(`/api/v1/nfc-devices/${old.body.id}`).set(headersA)
      .send({employee_id:employeeA,reason:'Umgehung'})).status).toBe(409);

    const archived=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${archived.body.id}/archive`).set(headersA)
      .send({reason:'Außer Betrieb'})).status).toBe(200);
    expect((await request(app!).post(`/api/v1/nfc-devices/${archived.body.id}/assign`).set(headersA)
      .send({employee_id:employeeA})).status).toBe(409);
    expect((await request(app!).post(`/api/v1/nfc-devices/${archived.body.id}/replace`).set(headersA)
      .send({identifier:uid(),device_type:'tag',manufacturer:'Acme',reason:'Defekt',copy_assignment:false})).status).toBe(409);
  },60_000);

  it('keeps historical assignments and scans readable after a replacement',async()=>{
    const point=await pool.query(`INSERT INTO control_points(tenant_id,site_id,name,nfc_uid,sequence)
      VALUES($1,$2,'Austauschhistorie',$3,$4) RETURNING id`,[tenantA,siteA,uid(),Math.floor(Math.random()*900000)+100000]);
    const old=await register(uid(),{employee_id:employeeA});
    const id=old.body.id as string;
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/assign`).set(headersA)
      .send({control_point_id:point.rows[0].id,reason:'Eingang'})).status).toBe(200);
    await pool.query(`INSERT INTO patrol_scans(tenant_id,route_id,control_point_id,employee_id,scanned_at,nfc_device_id)
      SELECT $1,$2,$3,$4,now() - (g || ' minutes')::interval,$5 FROM generate_series(1,3) g`,
      [tenantA,routeA,point.rows[0].id,employeeA,id]);
    expect((await request(app!).post(`/api/v1/nfc-devices/${id}/block`).set(headersA).send({reason:'Austausch vorbereiten'})).status).toBe(200);
    const replaced=await request(app!).post(`/api/v1/nfc-devices/${id}/replace`).set(headersA)
      .send({identifier:uid(),device_type:'tag',manufacturer:'Acme',reason:'Defekt',copy_assignment:true});
    expect(replaced.status).toBe(201);
    const newId=replaced.body.device.id as string;
    const file=await request(app!).get(`/api/v1/nfc-devices/${id}/file`).set(headersA);
    expect(file.status).toBe(200);
    expect(file.body.device.status).toBe('replaced');
    expect(file.body.device.control_point_id).toBeNull();
    expect(file.body.replacements).toEqual(expect.arrayContaining([expect.objectContaining({old_device_id:id,new_device_id:newId})]));
    const history=await pool.query('SELECT assignment FROM nfc_device_assignment_history WHERE tenant_id=$1 AND device_id=$2 ORDER BY assigned_at DESC',[tenantA,id]);
    expect(history.rows[0].assignment).toEqual({employee_id:null,site_id:null,control_point_id:null});
    expect(JSON.stringify(history.rows[1].assignment)).toContain(point.rows[0].id);
    const oldScans=await request(app!).get(`/api/v1/nfc-devices/${id}/scan-history`).set(headersA);
    expect(oldScans.body.total).toBe(3);
    const newScans=await request(app!).get(`/api/v1/nfc-devices/${newId}/scan-history`).set(headersA);
    expect(newScans.status).toBe(200);
    expect(newScans.body.total).toBe(0);
    const audit=await pool.query("SELECT details FROM audit_events WHERE tenant_id=$1 AND event_type='nfc_device.replaced' AND entity_id=$2",[tenantA,id]);
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(audit.rows[0].details).toEqual(expect.objectContaining({old_device_id:id,new_device_id:newId,copy_assignment:true}));
  },60_000);

  it('persists every technical master-data field without changing the assignment',async()=>{
    const created=await register(uid(),{employee_id:employeeA,model:'MX-10',serial_number:'SN-1'});
    const id=created.body.id as string;
    const patched=await request(app!).patch(`/api/v1/nfc-devices/${id}`).set(headersA).send({
      manufacturer:'Neuer Hersteller',model:'MX-20',serial_number:'SN-2',description:'Technische Beschreibung',
      notes:'Interne Notiz',reason:'Stammdaten korrigiert',
    });
    expect(patched.status).toBe(200);
    const file=await request(app!).get(`/api/v1/nfc-devices/${id}/file`).set(headersA);
    expect(file.body.device).toEqual(expect.objectContaining({
      manufacturer:'Neuer Hersteller',model:'MX-20',serial_number:'SN-2',
      description:'Technische Beschreibung',notes:'Interne Notiz',employee_id:employeeA,
    }));
    const history=await pool.query('SELECT id FROM nfc_device_assignment_history WHERE tenant_id=$1 AND device_id=$2',[tenantA,id]);
    expect(history.rowCount).toBe(0);
  },60_000);

  it('rejects archived and already used replacement candidates',async()=>{
    const old=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${old.body.id}/block`).set(headersA).send({reason:'Sperren'})).status).toBe(200);
    const archived=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${archived.body.id}/archive`).set(headersA)
      .send({reason:'Außer Betrieb'})).status).toBe(200);
    expect((await request(app!).post(`/api/v1/nfc-devices/${old.body.id}/replace`).set(headersA)
      .send({new_device_id:archived.body.id,reason:'Defekt',copy_assignment:false})).status).toBe(409);
    const candidate=await register(uid());
    const replaced=await request(app!).post(`/api/v1/nfc-devices/${old.body.id}/replace`).set(headersA)
      .send({new_device_id:candidate.body.id,reason:'Defekt',copy_assignment:false});
    expect(replaced.status).toBe(201);
    const second=await register(uid());
    expect((await request(app!).post(`/api/v1/nfc-devices/${second.body.id}/block`).set(headersA).send({reason:'Sperren'})).status).toBe(200);
    const reused=await request(app!).post(`/api/v1/nfc-devices/${second.body.id}/replace`).set(headersA)
      .send({new_device_id:candidate.body.id,reason:'Nochmal',copy_assignment:false});
    expect(reused.status).toBe(409);
    expect(reused.body.error).toContain('bereits als Ersatzgerät verwendet');
    const state=await pool.query('SELECT status FROM nfc_devices WHERE id=$1',[second.body.id]);
    expect(state.rows[0].status).toBe('blocked');
  },60_000);

  it('performs exactly one of two concurrent replacements with different candidates',async()=>{
    const oldMarker=uid();
    const candidateA=await register(uid());
    const candidateB=await register(uid());
    const {oldId,responses,contention}=await runConcurrentReplacement(oldMarker,[candidateA.body.id,candidateB.body.id]);

    // Nachweis der echten Parallelität: zwei verschiedene Backend-Sessions,
    // beide mit RowShareLock auf nfc_devices; der Warter hält die tuple-Sperre
    // und blockiert auf der transactionid des Inhabers.
    expect(contention).not.toBeNull();
    expect(contention!.waiterPid).not.toBe(contention!.holderPid);
    expect(contention!.mode).toBe('ShareLock');
    expect(contention!.waitEvent).toBe('Lock');

    expect(responses.map(result=>result.status).sort()).toEqual([201,409]);
    const success=responses.find(result=>result.status===201)!;
    const rejected=responses.find(result=>result.status===409)!;
    expect(rejected.body.error).toContain('bereits ersetzt');
    const winnerId=success.body.device.id as string;
    expect([candidateA.body.id,candidateB.body.id]).toContain(winnerId);
    const loserId=winnerId===candidateA.body.id?candidateB.body.id:candidateA.body.id;

    const oldState=(await pool.query<{status:string;replaced_at:Date|null;employee_id:string|null;site_id:string|null;control_point_id:string|null}>(
      'SELECT status,replaced_at,employee_id,site_id,control_point_id FROM nfc_devices WHERE id=$1',[oldId])).rows[0];
    expect(oldState.status).toBe('replaced');
    expect(oldState.replaced_at).not.toBeNull();
    expect(oldState.employee_id).toBeNull();
    expect(oldState.site_id).toBeNull();
    expect(oldState.control_point_id).toBeNull();

    const replacements=await pool.query<{new_device_id:string}>(
      'SELECT new_device_id FROM nfc_device_replacements WHERE tenant_id=$1 AND old_device_id=$2',[tenantA,oldId]);
    expect(replacements.rowCount).toBe(1);
    expect(replacements.rows[0].new_device_id).toBe(winnerId);

    const loserState=(await pool.query<{status:string;employee_id:string|null;site_id:string|null;control_point_id:string|null}>(
      'SELECT status,employee_id,site_id,control_point_id FROM nfc_devices WHERE id=$1',[loserId])).rows[0];
    expect(loserState).toEqual(expect.objectContaining({status:'active',employee_id:null,site_id:null,control_point_id:null}));
    const loserUsage=await pool.query('SELECT id FROM nfc_device_replacements WHERE tenant_id=$1 AND new_device_id=$2',[tenantA,loserId]);
    expect(loserUsage.rowCount).toBe(0);

    const audit=await pool.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND event_type='nfc_device.replaced' AND entity_id=$2",[tenantA,oldId]);
    expect(audit.rowCount).toBe(1);
    const history=await pool.query<{assignment:Record<string,unknown>}>(
      'SELECT assignment FROM nfc_device_assignment_history WHERE tenant_id=$1 AND device_id=$2',[tenantA,oldId]);
    expect(history.rowCount).toBe(1);
    expect(history.rows[0].assignment).toEqual({employee_id:null,site_id:null,control_point_id:null});

    const repeated=await request(app!).post(`/api/v1/nfc-devices/${oldId}/replace`).set(headersA)
      .send({new_device_id:loserId,reason:'Wiederholung',copy_assignment:false});
    expect(repeated.status).toBe(409);
    expect(repeated.body.error).toContain('bereits ersetzt');
    const afterRepeat=await pool.query('SELECT new_device_id FROM nfc_device_replacements WHERE tenant_id=$1 AND old_device_id=$2',[tenantA,oldId]);
    expect(afterRepeat.rowCount).toBe(1);
    expect(afterRepeat.rows[0].new_device_id).toBe(winnerId);
  },60_000);

  it('performs exactly one of two concurrent replacements with the same candidate',async()=>{
    const oldMarker=uid();
    const candidate=await register(uid());
    const {oldId,responses,contention}=await runConcurrentReplacement(oldMarker,[candidate.body.id,candidate.body.id]);

    expect(contention).not.toBeNull();
    expect(contention!.waiterPid).not.toBe(contention!.holderPid);
    expect(responses.map(result=>result.status).sort()).toEqual([201,409]);
    expect(responses.find(result=>result.status===409)!.body.error).toContain('bereits ersetzt');

    const replacements=await pool.query('SELECT new_device_id FROM nfc_device_replacements WHERE tenant_id=$1 AND old_device_id=$2',[tenantA,oldId]);
    expect(replacements.rowCount).toBe(1);
    expect(replacements.rows[0].new_device_id).toBe(candidate.body.id);
    const audit=await pool.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND event_type='nfc_device.replaced' AND entity_id=$2",[tenantA,oldId]);
    expect(audit.rowCount).toBe(1);
    const candidateState=(await pool.query<{status:string}>('SELECT status FROM nfc_devices WHERE id=$1',[candidate.body.id])).rows[0];
    expect(candidateState.status).toBe('active');
  },60_000);

  it('rolls back the complete replacement when a database error occurs inside the transaction',async()=>{
    const old=await register(uid());
    const oldId=old.body.id as string;
    expect((await request(app!).post(`/api/v1/nfc-devices/${oldId}/report-lost`).set(headersA)
      .send({lost_at:'2026-11-27',reason:'Rollbacktest'})).status).toBe(200);
    const candidate=await register(uid());
    const marker=`QA-ROLLBACK-${randomUUID()}`;
    const failed=await withReplacementRollback(marker,async()=>request(app!).post(`/api/v1/nfc-devices/${oldId}/replace`).set(headersA)
      .send({new_device_id:candidate.body.id,reason:'Rollback',notes:marker,copy_assignment:false}));
    expect(failed.status).toBeGreaterThanOrEqual(500);

    const oldState=(await pool.query<{status:string;replaced_at:Date|null}>(
      'SELECT status,replaced_at FROM nfc_devices WHERE id=$1',[oldId])).rows[0];
    expect(oldState.status).toBe('lost');
    expect(oldState.replaced_at).toBeNull();
    const candidateState=(await pool.query<{status:string;employee_id:string|null;site_id:string|null;control_point_id:string|null}>(
      'SELECT status,employee_id,site_id,control_point_id FROM nfc_devices WHERE id=$1',[candidate.body.id])).rows[0];
    expect(candidateState).toEqual(expect.objectContaining({status:'active',employee_id:null,site_id:null,control_point_id:null}));
    expect((await pool.query('SELECT id FROM nfc_device_replacements WHERE tenant_id=$1 AND old_device_id=$2',[tenantA,oldId])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM nfc_device_replacements WHERE tenant_id=$1 AND new_device_id=$2',[tenantA,candidate.body.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND event_type='nfc_device.replaced' AND entity_id=$2",[tenantA,oldId])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM nfc_device_assignment_history WHERE tenant_id=$1 AND device_id=$2',[tenantA,oldId])).rowCount).toBe(0);
  },60_000);
});
