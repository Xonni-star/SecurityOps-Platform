import pg from 'pg';
import request from 'supertest';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterAll,beforeAll,describe,expect,it} from '@jest/globals';
import {runMigrations} from '../src/db/migration-runner.js';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
const describePostgres=databaseUrl?describe:describe.skip;
if(databaseUrl&&!process.env.DATABASE_URL)process.env.DATABASE_URL=databaseUrl;
const {app}=databaseUrl?await import('../src/app.js'):{app:undefined};

const sessionAdmin=`leitstelle-admin-${randomUUID()}`;
const sessionOperator=`leitstelle-operator-${randomUUID()}`;
const sessionViewer=`leitstelle-viewer-${randomUUID()}`;
const sessionOther=`leitstelle-other-${randomUUID()}`;
const csrfAdmin=`leitstelle-csrf-admin-${randomUUID()}`;
const csrfOperator=`leitstelle-csrf-operator-${randomUUID()}`;
const csrfViewer=`leitstelle-csrf-viewer-${randomUUID()}`;
const csrfOther=`leitstelle-csrf-other-${randomUUID()}`;
const headersAdmin={Cookie:[`securityops_session=${sessionAdmin}`,`securityops_csrf=${csrfAdmin}`],'x-csrf-token':csrfAdmin};
const headersOperator={Cookie:[`securityops_session=${sessionOperator}`,`securityops_csrf=${csrfOperator}`],'x-csrf-token':csrfOperator};
const headersViewer={Cookie:[`securityops_session=${sessionViewer}`,`securityops_csrf=${csrfViewer}`],'x-csrf-token':csrfViewer};
const headersOther={Cookie:[`securityops_session=${sessionOther}`,`securityops_csrf=${csrfOther}`],'x-csrf-token':csrfOther};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const testDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

type Seed={
  tenant_a:string;tenant_b:string;site_a:string;site_b:string;admin:string;operator:string;viewer:string;user_b:string;
  employee_ok:string;employee_blocked:string;catalog:string;qual_ok:string;qual_bad:string;
  doc_valid:string;doc_pending:string;requirement:string;device_lost:string;key_overdue:string;
  alarm:string;hazard:string;profile:string;period:string;shift_running:string;shift_open:string;
};

describePostgres('operative control centre with real tenant-scoped PostgreSQL data',()=>{
  let pool:pg.Pool;
  let seed:Seed;
  let originalScopes:Array<{role:string;permission_id:string;scope:string}>=[];

  beforeAll(async()=>{
    if(!databaseUrl)throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    pool=new pg.Pool({connectionString:databaseUrl});
    const migrationsDir=existsSync(resolve(process.cwd(),'migrations'))
      ?resolve(process.cwd(),'migrations')
      :resolve(process.cwd(),'backend/migrations');
    await runMigrations(pool,migrationsDir);
    const suffix=randomUUID().replaceAll('-','').slice(0,12);
    const seeded=await pool.query<Seed>(`
      WITH a AS (INSERT INTO tenants(name) VALUES ($1::text) RETURNING id),
      b AS (INSERT INTO tenants(name) VALUES ($2::text) RETURNING id),
      sa AS (INSERT INTO sites(tenant_id,name,site_number,status,security_classification,required_staff_count,city)
        SELECT id,'Leitstelle Objekt A','OC-'||$3::text,'active','medium',2,'Berlin' FROM a RETURNING id),
      sb AS (INSERT INTO sites(tenant_id,name,site_number,status,security_classification,required_staff_count,city)
        SELECT id,'Fremdes Objekt B','OC-'||$4::text,'active','medium',1,'Hamburg' FROM b RETURNING id),
      ca AS (INSERT INTO customers(tenant_id,name,customer_number) SELECT id,'QA Kunde','K-'||$5::text FROM a RETURNING id),
      csa AS (INSERT INTO customer_sites(tenant_id,customer_id,site_id,relationship_type,relationship_status,is_primary)
        SELECT a.id,(SELECT id FROM ca),(SELECT id FROM sa),'primary','active',true FROM a RETURNING id),
      ua AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$6::text,'admin','hash' FROM a RETURNING id),
      uo AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$21::text,'operator','hash' FROM a RETURNING id),
      uv AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$7::text,'viewer','hash' FROM a RETURNING id),
      ub AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$8::text,'admin','hash' FROM b RETURNING id),
      da AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'QA Admin Client','authenticated' FROM a RETURNING id),
      dov AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'QA Operator Client','authenticated' FROM a RETURNING id),
      dv AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'QA Viewer Client','authenticated' FROM a RETURNING id),
      db AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sb),'QA Other Client','authenticated' FROM b RETURNING id),
      sea AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT a.id,(SELECT id FROM ua),(SELECT id FROM da),$9::text,$12::text,now()+INTERVAL '1 day' FROM a RETURNING id),
      seo AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT a.id,(SELECT id FROM uo),(SELECT id FROM dov),$22::text,$23::text,now()+INTERVAL '1 day' FROM a RETURNING id),
      sev AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT a.id,(SELECT id FROM uv),(SELECT id FROM dv),$10::text,$13::text,now()+INTERVAL '1 day' FROM a RETURNING id),
      seb AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT b.id,(SELECT id FROM ub),(SELECT id FROM db),$11::text,$14::text,now()+INTERVAL '1 day' FROM b RETURNING id),
      ea AS (INSERT INTO employees(tenant_id,name,email,employment_status,employment_type,hire_date)
        SELECT id,'Mia verfuegbar',$15::text,'active','employee',now()-INTERVAL '100 days' FROM a RETURNING id),
      eb AS (INSERT INTO employees(tenant_id,name,email,employment_status,employment_type,hire_date)
        SELECT id,'Jonas gesperrt',$16::text,'active','employee',now()-INTERVAL '100 days' FROM a RETURNING id),
      assa AS (INSERT INTO employee_object_assignments(tenant_id,employee_id,site_id,assignment_type,starts_on,primary_assignment)
        SELECT a.id,(SELECT id FROM ea),(SELECT id FROM sa),'permanent',now()::date,true FROM a RETURNING id),
      assb AS (INSERT INTO employee_object_assignments(tenant_id,employee_id,site_id,assignment_type,starts_on,primary_assignment)
        SELECT a.id,(SELECT id FROM eb),(SELECT id FROM sa),'permanent',now()::date,true FROM a RETURNING id),
      cat AS (INSERT INTO qualification_catalog(tenant_id,code,name,active,required)
        SELECT id,'sicherheit','Sicherheitsqualifikation',true,true FROM a RETURNING id),
      qa AS (INSERT INTO employee_qualifications(tenant_id,employee_id,catalog_id,code,status,valid_from,valid_until)
        SELECT a.id,(SELECT id FROM ea),(SELECT id FROM cat),'sicherheit','valid',now()-INTERVAL '10 days',now()+INTERVAL '300 days' FROM a RETURNING id),
      qb AS (INSERT INTO employee_qualifications(tenant_id,employee_id,catalog_id,code,status,valid_from,valid_until,revoked_at)
        SELECT a.id,(SELECT id FROM eb),(SELECT id FROM cat),'sicherheit','revoked',now()-INTERVAL '10 days',now()+INTERVAL '300 days',now() FROM a RETURNING id),
      req AS (INSERT INTO site_qualification_requirements(tenant_id,site_id,catalog_id,required,active,created_by)
        SELECT a.id,(SELECT id FROM sa),(SELECT id FROM cat),true,true,(SELECT id FROM ua) FROM a RETURNING id),
      doca AS (INSERT INTO dms_documents(tenant_id,site_id,title,document_status,approval_status,document_type,
          valid_from,valid_until,review_on,reviewed_at,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM sa),'Gültige Unterweisung','active','approved','Unterweisung',
          now()-INTERVAL '10 days',now()+INTERVAL '100 days',now()+INTERVAL '200 days',now(),(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      docva AS (INSERT INTO dms_versions(tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,lifecycle_state,uploaded_by,uploaded_session_id)
        SELECT a.id,(SELECT id FROM doca),1,'qa/leitstelle/valid','1024','application/pdf',repeat('a',64),'available',(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      docp AS (INSERT INTO dms_documents(tenant_id,site_id,title,document_status,approval_status,document_type,
          valid_from,valid_until,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM sa),'Nicht freigegebene Unterweisung','active','pending_approval','Unterweisung',
          now()-INTERVAL '10 days',now()+INTERVAL '100 days',(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      docvp AS (INSERT INTO dms_versions(tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,lifecycle_state,uploaded_by,uploaded_session_id)
        SELECT a.id,(SELECT id FROM docp),1,'qa/leitstelle/pending','1024','application/pdf',repeat('b',64),'available',(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      dreq AS (INSERT INTO dms_document_requirements(tenant_id,site_id,document_type,required,created_by)
        SELECT a.id,(SELECT id FROM sa),'Pflichtnachweis fehlt',true,(SELECT id FROM ua) FROM a RETURNING id),
      nfc AS (INSERT INTO nfc_devices(tenant_id,site_id,identifier,device_type,manufacturer,status,lost_at,notes)
        SELECT a.id,(SELECT id FROM sa),'NFC-'||$17::text,'tag','QA','lost',now(),'Verloren gemeldet' FROM a RETURNING id),
      key AS (INSERT INTO keys(tenant_id,site_id,key_code,label,key_type,status,holder_employee_id,due_at,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM sa),'KEY-'||$18::text,'Objektschlüssel','physical','issued',(SELECT id FROM ea),now()-INTERVAL '2 days',(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      alarm AS (INSERT INTO alarms(tenant_id,site_id,device_id,severity,status,message,triggered_at,source,source_key)
        SELECT a.id,(SELECT id FROM sa),(SELECT id FROM da),'critical','open','Critical QA alarm',now()-INTERVAL '30 minutes','system','qa-alarm-'||$19::text FROM a RETURNING id),
      hazard AS (INSERT INTO object_hazards(tenant_id,site_id,title,category,description,likelihood,impact,status,created_by)
        SELECT a.id,(SELECT id FROM sa),'Hohe Gefährdung','burglary','QA Gefährdung',5,5,'open',(SELECT id FROM ua) FROM a RETURNING id),
      prof AS (INSERT INTO schedule_rule_profiles(tenant_id,name,version,parameters,created_by,created_session_id)
        SELECT a.id,'QA Regelprofil',1,'{}'::jsonb,(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      per AS (INSERT INTO schedule_periods(tenant_id,site_id,rule_profile_id,name,starts_at,ends_at,status,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM sa),(SELECT id FROM prof),'QA Zeitraum',
          now()-INTERVAL '10 days',now()+INTERVAL '10 days','published',(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      sh1 AS (INSERT INTO schedule_shifts(tenant_id,period_id,site_id,role_code,starts_at,ends_at,required_qualification_codes,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM per),(SELECT id FROM sa),'WACHE',$20::date+INTERVAL '8 hours',$20::date+INTERVAL '10 hours','["sicherheit"]'::jsonb,(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      sh2 AS (INSERT INTO schedule_shifts(tenant_id,period_id,site_id,role_code,starts_at,ends_at,required_qualification_codes,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM per),(SELECT id FROM sa),'WACHE',$20::date+INTERVAL '10 hours',$20::date+INTERVAL '12 hours','["sicherheit"]'::jsonb,(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      ass AS (INSERT INTO schedule_assignments(tenant_id,shift_id,employee_id,status,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM sh1),(SELECT id FROM ea),'assigned',(SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id)
      SELECT a.id tenant_a,b.id tenant_b,(SELECT id FROM sa) site_a,(SELECT id FROM sb) site_b,
        (SELECT id FROM ua) admin,(SELECT id FROM uo) operator,(SELECT id FROM uv) viewer,(SELECT id FROM ub) user_b,
        (SELECT id FROM ea) employee_ok,(SELECT id FROM eb) employee_blocked,(SELECT id FROM cat) catalog,
        (SELECT id FROM qa) qual_ok,(SELECT id FROM qb) qual_bad,(SELECT id FROM doca) doc_valid,
        (SELECT id FROM docp) doc_pending,(SELECT id FROM dreq) requirement,(SELECT id FROM nfc) device_lost,
        (SELECT id FROM key) key_overdue,(SELECT id FROM alarm) alarm,(SELECT id FROM hazard) hazard,
        (SELECT id FROM prof) profile,(SELECT id FROM per) period,(SELECT id FROM sh1) shift_running,
        (SELECT id FROM sh2) shift_open
      FROM a,b
    `,[
      `Leitstelle A ${suffix}`,`Leitstelle B ${suffix}`,suffix,`${suffix}-b`,suffix,
      `oc-admin-${suffix}@example.invalid`,`oc-viewer-${suffix}@example.invalid`,`oc-other-${suffix}@example.invalid`,
      hash(sessionAdmin),hash(sessionViewer),hash(sessionOther),csrfAdmin,csrfViewer,csrfOther,
      `oc-ok-${suffix}@example.invalid`,`oc-blocked-${suffix}@example.invalid`,
      `nfc-${suffix}`,`key-${suffix}`,`alarm-${suffix}`,testDate,
      `oc-operator-${suffix}@example.invalid`,hash(sessionOperator),csrfOperator,
    ]);
    seed=seeded.rows[0];
  },120_000);

  afterAll(async()=>{
    if(originalScopes.length){
      for(const row of originalScopes){
        await pool.query('UPDATE role_permissions SET scope=$1,updated_at=now() WHERE role=$2 AND permission_id=$3',[row.scope,row.role,row.permission_id]);
      }
    }
    if(pool&&seed){
      await pool.query('DELETE FROM tenants WHERE id IN ($1,$2)',[seed.tenant_a,seed.tenant_b]);
    }
    await pool?.end();
  });

  const getCenter=(headers:Record<string,unknown>,query='')=>request(app!)
    .get(`/api/v1/operations/control-center?date=${testDate}${query}`).set(headers);
  const createMeasure=async(body:Record<string,unknown>,headers=headersAdmin)=>request(app!)
    .post('/api/v1/operations/measures').set(headers).send(body);
  const completeMeasure=async(id:string,reason='QA Abschluss')=>request(app!)
    .patch(`/api/v1/operations/measures/${id}`).set(headersAdmin).send({status:'done',reason});

  const makeMeasure=async(sourceType:string,sourceId:string,title:string)=>{
    const response=await createMeasure({title,module:'leitstelle',source_type:sourceType,source_id:sourceId,
      site_id:seed.site_a,client_mutation_id:randomUUID()});
    expect(response.status).toBe(201);
    return String(response.body.id);
  };

  it('builds every KPI and warning from seeded operational records',async()=>{
    const response=await getCenter(headersAdmin);
    expect(response.status).toBe(200);
    expect(response.body.operational_status).toBe('kritisch');
    expect(response.body.kpis.find((kpi:{key:string})=>kpi.key==='employees_total').value).toBe(2);
    expect(response.body.kpis.find((kpi:{key:string})=>kpi.key==='open_shifts').value).toBe(1);
    expect(response.body.kpis.find((kpi:{key:string})=>kpi.key==='qualification_gaps').value).toBe(1);
    expect(response.body.kpis.find((kpi:{key:string})=>kpi.key==='active_disruptions').value).toBeGreaterThanOrEqual(3);
    const codes=response.body.alerts.map((alert:{code:string})=>alert.code);
    expect(codes).toEqual(expect.arrayContaining(['active_alarm','qualification_revoked','required_document_missing','nfc_lost','key_overdue','object_hazard']));
    expect(response.body.sites).toEqual([expect.objectContaining({id:seed.site_a})]);
    expect(response.body.qualifications).toEqual([expect.objectContaining({qualification_id:seed.qual_bad,status:'revoked'})]);
    expect(response.body.documents.map((doc:{id:string})=>doc.id)).toEqual(expect.arrayContaining([seed.doc_pending]));
    expect(response.body.document_requirements).toEqual([expect.objectContaining({id:seed.requirement,missing:true})]);
    expect(response.body.devices).toEqual([expect.objectContaining({id:seed.device_lost,status:'lost'})]);
    expect(response.body.keys).toEqual([expect.objectContaining({id:seed.key_overdue,display_status:'overdue'})]);
  });

  it('never treats an acknowledged alarm as resolved and blocks closing its measure',async()=>{
    await pool.query(`UPDATE alarms SET status='acknowledged',acknowledged_at=now(),acknowledged_by=$1 WHERE tenant_id=$2 AND id=$3`,[seed.admin,seed.tenant_a,seed.alarm]);
    const acknowledged=await getCenter(headersAdmin);
    expect(acknowledged.body.alarms).toEqual([expect.objectContaining({id:seed.alarm,status:'acknowledged'})]);
    expect(acknowledged.body.alerts.map((alert:{code:string})=>alert.code)).toContain('active_alarm');
    const measureId=await makeMeasure('alarm',seed.alarm,'Alarm Ursache bearbeiten');
    expect((await completeMeasure(measureId)).status).toBe(409);
    await pool.query(`UPDATE alarms SET status='resolved',resolved_at=now() WHERE tenant_id=$1 AND id=$2`,[seed.tenant_a,seed.alarm]);
    expect((await getCenter(headersAdmin)).body.alerts.map((alert:{code:string})=>alert.code)).not.toContain('active_alarm');
    expect((await completeMeasure(measureId)).status).toBe(200);
  });

  it('uses the central qualification status when deciding whether a cause is resolved',async()=>{
    const measureId=await makeMeasure('qualification',seed.qual_bad,'Qualifikation widerrufen');
    expect((await completeMeasure(measureId)).status).toBe(409);
    await pool.query(`UPDATE employee_qualifications SET status='valid',revoked_at=NULL WHERE tenant_id=$1 AND id=$2`,[seed.tenant_a,seed.qual_bad]);
    expect((await completeMeasure(measureId)).status).toBe(200);
    expect((await getCenter(headersAdmin)).body.qualifications).toEqual([]);
  });

  it('uses the DMS release rules when deciding whether a document cause is resolved',async()=>{
    const measureId=await makeMeasure('document',seed.doc_pending,'Dokument freigeben');
    expect((await completeMeasure(measureId)).status).toBe(409);
    await pool.query(`UPDATE dms_documents SET approval_status='approved',reviewed_at=now(),review_on=NULL WHERE tenant_id=$1 AND id=$2`,[seed.tenant_a,seed.doc_pending]);
    expect((await completeMeasure(measureId)).status).toBe(200);
    expect((await getCenter(headersAdmin)).body.documents.map((doc:{id:string})=>doc.id)).not.toContain(seed.doc_pending);
  });

  it('keeps lost NFC devices and overdue keys open until their real state changes',async()=>{
    const nfcMeasure=await makeMeasure('nfc_device',seed.device_lost,'NFC-Gerät ersetzen');
    const keyMeasure=await makeMeasure('key',seed.key_overdue,'Schlüsselrückgabe klären');
    expect((await completeMeasure(nfcMeasure)).status).toBe(409);
    expect((await completeMeasure(keyMeasure)).status).toBe(409);
    await pool.query(`UPDATE nfc_devices SET status='active',lost_at=NULL,notes='',archived_at=NULL WHERE tenant_id=$1 AND id=$2`,[seed.tenant_a,seed.device_lost]);
    await pool.query(`UPDATE keys SET status='available',due_at=NULL WHERE tenant_id=$1 AND id=$2`,[seed.tenant_a,seed.key_overdue]);
    expect((await completeMeasure(nfcMeasure)).status).toBe(200);
    expect((await completeMeasure(keyMeasure)).status).toBe(200);
  });

  it('filters candidates through the authoritative staffing verdict',async()=>{
    // Ein vorheriger Test hat die Qualifikation bewusst wieder freigegeben; hier
    // wird der gesperrte Ausgangszustand für die Kandidatenprüfung hergestellt.
    await pool.query(`UPDATE employee_qualifications SET status='revoked',revoked_at=now() WHERE tenant_id=$1 AND id=$2`,[seed.tenant_a,seed.qual_bad]);
    const response=await request(app!)
      .get(`/api/v1/operations/control-center/candidates?shift_id=${seed.shift_open}`).set(headersAdmin);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({id:seed.employee_ok,status:'eligible'})]);
    expect(response.body.map((candidate:{id:string})=>candidate.id)).not.toContain(seed.employee_blocked);
  });

  it('lists historical qualifications with identical natural keys only once each',async()=>{
    const source=(await pool.query<{employee_id:string;catalog_id:string;code:string;valid_until:string|null}>(
      'SELECT employee_id,catalog_id,code,valid_until FROM employee_qualifications WHERE tenant_id=$1 AND id=$2',
      [seed.tenant_a,seed.qual_bad])).rows[0];
    const history=(await pool.query<{id:string}>(`
      INSERT INTO employee_qualifications(tenant_id,employee_id,catalog_id,code,status,valid_from,valid_until)
      VALUES($1,$2,$3,$4,'invalid',now()-INTERVAL '10 days',$5) RETURNING id`,
      [seed.tenant_a,source.employee_id,source.catalog_id,source.code,source.valid_until])).rows[0];
    try{
      const response=await getCenter(headersAdmin);
      expect(response.status).toBe(200);
      const qualifications:Array<{qualification_id:string;status:string}>=response.body.qualifications;
      const relevant=qualifications.filter((qualification)=>[seed.qual_bad,history.id].includes(qualification.qualification_id));
      expect(relevant.map((qualification)=>qualification.qualification_id)).toEqual(
        expect.arrayContaining([seed.qual_bad,history.id]));
      expect(new Set(relevant.map((qualification)=>qualification.qualification_id)).size).toBe(relevant.length);
      expect(relevant.map((qualification)=>qualification.status).sort()).toEqual(['invalid','revoked']);
    }finally{
      await pool.query('DELETE FROM employee_qualifications WHERE tenant_id=$1 AND id=$2',[seed.tenant_a,history.id]);
    }
  });

  it('keeps tenants strictly separated and denies cross-tenant writes',async()=>{
    const measureId=await makeMeasure('site',seed.site_a,'Objektmaßnahme');
    const foreign=await getCenter(headersOther);
    expect(foreign.status).toBe(200);
    expect(foreign.body.sites).toEqual([expect.objectContaining({id:seed.site_b})]);
    expect(foreign.body.sites.map((site:{id:string})=>site.id)).not.toContain(seed.site_a);
    expect(foreign.body.alerts.every((alert:{site_id:string|null})=>alert.site_id===seed.site_b)).toBe(true);
    expect(foreign.body.filter_options.sites.map((site:{id:string})=>site.id)).not.toContain(seed.site_a);
    expect((await request(app!).patch(`/api/v1/operations/measures/${measureId}`).set(headersOther).send({status:'done'})).status).toBe(404);
    const foreignSiteFilter=await request(app!).get(`/api/v1/operations/control-center?date=${testDate}&site_id=${seed.site_a}`).set(headersOther);
    expect(foreignSiteFilter.status).toBe(200);
    expect(foreignSiteFilter.body.sites).toEqual([]);
  });

  it('applies site scopes to reads and writes on the server',async()=>{
    const permissions=(await pool.query<{key:string;id:string}>(`SELECT key,id FROM permissions WHERE key = ANY($1::text[])`,[
      ['nsl:read','scheduling:read','employees:read','sites:read','dms:read','keys:read','nfc_devices:read',
        'qualifications:read','alarms:read','operations_measures:read','operations_measures:write'],
    ])).rows;
    const before=(await pool.query<{role:string;permission_id:string;scope:string}>(
      `SELECT role,permission_id,scope FROM role_permissions WHERE role='operator' AND permission_id = ANY($1::uuid[])`,
      [permissions.map(row=>row.id)],
    )).rows;
    originalScopes=before;
    try{
      await pool.query(`UPDATE role_permissions SET scope='site',updated_at=now() WHERE role='operator' AND permission_id = ANY($1::uuid[])`,[permissions.map(row=>row.id)]);
      await pool.query(`INSERT INTO user_sites(tenant_id,user_id,site_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[seed.tenant_a,seed.operator,seed.site_a]);
      const scoped=await request(app!).get(`/api/v1/operations/control-center?date=${testDate}`).set(headersOperator);
      expect(scoped.status).toBe(200);
      expect(scoped.body.sites).toEqual([expect.objectContaining({id:seed.site_a})]);
      expect((await createMeasure({title:'Fremdes Objekt',module:'leitstelle',site_id:seed.site_b},headersOperator)).status).toBe(403);
      const allowed=await createMeasure({title:'Eigenes Objekt',module:'leitstelle',site_id:seed.site_a},headersOperator);
      expect(allowed.status).toBe(201);
      expect((await request(app!).get('/api/v1/operations/measures?site_id='+seed.site_b).set(headersOperator)).body).toEqual([]);
    } finally {
      for(const row of before){
        await pool.query('UPDATE role_permissions SET scope=$1,updated_at=now() WHERE role=$2 AND permission_id=$3',[row.scope,row.role,row.permission_id]);
      }
      originalScopes=[];
    }
  });

  it('enforces measure pagination, idempotency, RBAC and an auditable trail',async()=>{
    const ids:string[]=[];
    const mutations=Array.from({length:6},()=>randomUUID());
    for(let index=0;index<6;index+=1){
      const response=await createMeasure({title:`QA Maßnahme ${index}`,module:'leitstelle',site_id:seed.site_a,client_mutation_id:mutations[index]});
      expect(response.status).toBe(201);
      ids.push(String(response.body.id));
    }
    const replay=await createMeasure({title:'QA Maßnahme 0',module:'leitstelle',site_id:seed.site_a,client_mutation_id:mutations[0]});
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(ids[0]);
    const page=await request(app!).get('/api/v1/operations/measures?page=1&page_size=5').set(headersAdmin);
    expect(page.status).toBe(200);
    expect(Number(page.headers['x-total-count'])).toBeGreaterThanOrEqual(6);
    expect(page.body).toHaveLength(5);
    expect((await createMeasure({title:'Viewer darf nicht schreiben',module:'leitstelle'},headersViewer)).status).toBe(403);
    const audit=await pool.query(`SELECT event_type FROM audit_events WHERE tenant_id=$1 AND entity_type='operations_measure' AND entity_id=$2`,[seed.tenant_a,ids[0]]);
    expect(audit.rows.map(row=>row.event_type)).toContain('operations.measure.created');
  });

  it('filters and sorts real measures by search, status, module, object and overdue state',async()=>{
    const due=new Date(Date.now()-86_400_000).toISOString();
    const overdue=await createMeasure({title:'QA Überfällige Objektmaßnahme',description:'Sichtprüfung',module:'objekt',
      status:'in_progress',site_id:seed.site_a,due_at:due,client_mutation_id:randomUUID()});
    expect(overdue.status).toBe(201);
    await createMeasure({title:'QA Andere Schichtmaßnahme',module:'schicht',site_id:seed.site_a,client_mutation_id:randomUUID()});
    const filtered=await request(app!).get(`/api/v1/operations/measures?q=${encodeURIComponent('Überfällige')}&status=in_progress&module=objekt&site_id=${seed.site_a}&overdue=true`)
      .set(headersAdmin);
    expect(filtered.status).toBe(200);
    expect(filtered.body.map((row:{id:string})=>row.id)).toEqual([String(overdue.body.id)]);
    expect(Number(filtered.headers['x-total-count'])).toBe(1);
    const scoped=await getCenter(headersAdmin,`&site_id=${seed.site_a}`);
    expect(scoped.body.sites.map((site:{id:string})=>site.id)).toEqual([seed.site_a]);
    expect(scoped.body.filter_options.sites.map((site:{id:string})=>site.id)).toEqual([seed.site_a]);
    expect(scoped.body.summary.measures_overdue).toBeGreaterThanOrEqual(1);
  });
});
