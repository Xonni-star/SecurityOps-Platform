import pg from 'pg';
import request from 'supertest';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach,beforeAll,beforeEach,describe,expect,it} from '@jest/globals';
import {runMigrations} from '../src/db/migration-runner.js';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
const describePostgres=databaseUrl?describe:describe.skip;
if(databaseUrl&&!process.env.DATABASE_URL)process.env.DATABASE_URL=databaseUrl;
const {app}=databaseUrl?await import('../src/app.js'):{app:undefined};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

type Ctx={
  pool:pg.Pool;tenantA:string;tenantB:string;siteA:string;siteB:string;
  admin:string;operator:string;viewer:string;other:string;employee:string;
  priorityHigh:string;priorityMedium:string;alarm:string;documentApproved:string;
  documentPending:string;rule:string;
  headersAdmin:Record<string,unknown>;headersOperator:Record<string,unknown>;
  headersViewer:Record<string,unknown>;headersOther:Record<string,unknown>;
};

describePostgres('Einsatz-, Alarm- und Vorfallmanagement mit echten Mandantendaten',()=>{
  let pool:pg.Pool;
  let ctx:Ctx;
  let originalScopes:Array<{role:string;permission_id:string;scope:string}>=[];

  beforeAll(async()=>{
    if(!databaseUrl)throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    pool=new pg.Pool({connectionString:databaseUrl});
    const migrationsDir=existsSync(resolve(process.cwd(),'migrations'))
      ?resolve(process.cwd(),'migrations')
      :resolve(process.cwd(),'backend/migrations');
    await runMigrations(pool,migrationsDir);
  });

  beforeEach(async()=>{
    const suffix=randomUUID().replaceAll('-','').slice(0,12);
    const sessionAdmin=`einsatz-admin-${randomUUID()}`;
    const sessionOperator=`einsatz-operator-${randomUUID()}`;
    const sessionViewer=`einsatz-viewer-${randomUUID()}`;
    const sessionOther=`einsatz-other-${randomUUID()}`;
    const csrfAdmin=`einsatz-csrf-admin-${randomUUID()}`;
    const csrfOperator=`einsatz-csrf-operator-${randomUUID()}`;
    const csrfViewer=`einsatz-csrf-viewer-${randomUUID()}`;
    const csrfOther=`einsatz-csrf-other-${randomUUID()}`;
    const priorityHigh=randomUUID();
    const priorityMedium=randomUUID();
    const seeded=await pool.query<{
      tenant_a:string;tenant_b:string;site_a:string;site_b:string;
      admin:string;operator:string;viewer:string;other:string;employee:string;
      alarm:string;document_approved:string;document_pending:string;rule:string;
    }>(`
      WITH a AS (INSERT INTO tenants(name) VALUES ($1::text) RETURNING id),
      b AS (INSERT INTO tenants(name) VALUES ($2::text) RETURNING id),
      sa AS (INSERT INTO sites(tenant_id,name,site_number,status,security_classification,required_staff_count,city)
        SELECT id,'Einsatz Objekt A','EA-'||$3::text,'active','medium',2,'Berlin' FROM a RETURNING id),
      sb AS (INSERT INTO sites(tenant_id,name,site_number,status,security_classification,required_staff_count,city)
        SELECT id,'Einsatz Objekt B','EA-'||$4::text,'active','medium',1,'Hamburg' FROM b RETURNING id),
      ua AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$5::text,'admin','hash' FROM a RETURNING id),
      uo AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$8::text,'operator','hash' FROM a RETURNING id),
      uv AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$6::text,'viewer','hash' FROM a RETURNING id),
      ub AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$7::text,'admin','hash' FROM b RETURNING id),
      da AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'Admin Client','authenticated' FROM a RETURNING id),
      dop AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'Operator Client','authenticated' FROM a RETURNING id),
      dv AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sa),'Viewer Client','authenticated' FROM a RETURNING id),
      db AS (INSERT INTO devices(tenant_id,site_id,name,device_kind) SELECT id,(SELECT id FROM sb),'Other Client','authenticated' FROM b RETURNING id),
      sea AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT a.id,(SELECT id FROM ua),(SELECT id FROM da),$9::text,$13::text,now()+INTERVAL '1 day' FROM a RETURNING id),
      seo AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT a.id,(SELECT id FROM uo),(SELECT id FROM dop),$10::text,$14::text,now()+INTERVAL '1 day' FROM a RETURNING id),
      sev AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT a.id,(SELECT id FROM uv),(SELECT id FROM dv),$11::text,$15::text,now()+INTERVAL '1 day' FROM a RETURNING id),
      seb AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
        SELECT b.id,(SELECT id FROM ub),(SELECT id FROM db),$12::text,$16::text,now()+INTERVAL '1 day' FROM b RETURNING id),
      ea AS (INSERT INTO employees(tenant_id,name,email,employment_status,employment_type,hire_date)
        SELECT id,'Einsatzkraft',$17::text,'active','employee',now()-INTERVAL '100 days' FROM a RETURNING id),
      oa AS (INSERT INTO employee_object_assignments(tenant_id,employee_id,site_id,assignment_type,starts_on,primary_assignment)
        SELECT a.id,(SELECT id FROM ea),(SELECT id FROM sa),'permanent',now()::date,true FROM a RETURNING id),
      ph AS (INSERT INTO alarm_priorities(id,tenant_id,name,code,rank,color)
        VALUES ($18::uuid,(SELECT id FROM a),'Hoch','high',2,'#ea580c') RETURNING id),
      pm AS (INSERT INTO alarm_priorities(id,tenant_id,name,code,rank,color)
        VALUES ($19::uuid,(SELECT id FROM a),'Mittel','medium',3,'#eab308') RETURNING id),
      alarm AS (INSERT INTO alarms(tenant_id,site_id,priority_id,severity,status,message,description,source)
        SELECT a.id,(SELECT id FROM sa),(SELECT id FROM ph),'high','open','QA Einsatzalarm','QA Einsatzalarm','system' FROM a RETURNING id),
      doca AS (INSERT INTO dms_documents(tenant_id,site_id,title,document_status,approval_status,document_type,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM sa),'Freigegebenes Einsatzdokument','active','approved','Bericht',
          (SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      docva AS (INSERT INTO dms_versions(tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,lifecycle_state,uploaded_by,uploaded_session_id)
        SELECT a.id,(SELECT id FROM doca),1,'qa/einsatz/approved','1024','application/pdf',repeat('a',64),'available',
          (SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      docp AS (INSERT INTO dms_documents(tenant_id,site_id,title,document_status,approval_status,document_type,created_by,created_session_id)
        SELECT a.id,(SELECT id FROM sa),'Nicht freigegebenes Einsatzdokument','active','pending_approval','Bericht',
          (SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      docvp AS (INSERT INTO dms_versions(tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,lifecycle_state,uploaded_by,uploaded_session_id)
        SELECT a.id,(SELECT id FROM docp),1,'qa/einsatz/pending','1024','application/pdf',repeat('b',64),'available',
          (SELECT id FROM ua),(SELECT id FROM sea) FROM a RETURNING id),
      rule AS (INSERT INTO escalation_rules(tenant_id,name,delay_seconds,target_status,enabled,notify_enabled)
        SELECT a.id,'Einsatz Eskalation',60,'escalated',true,true FROM a RETURNING id)
      SELECT a.id tenant_a,b.id tenant_b,(SELECT id FROM sa) site_a,(SELECT id FROM sb) site_b,
        (SELECT id FROM ua) admin,(SELECT id FROM uo) operator,(SELECT id FROM uv) viewer,(SELECT id FROM ub) other,
        (SELECT id FROM ea) employee,(SELECT id FROM alarm) alarm,
        (SELECT id FROM doca) document_approved,(SELECT id FROM docp) document_pending,(SELECT id FROM rule) rule
      FROM a,b
    `,[
      `Einsatz A ${suffix}`,`Einsatz B ${suffix}`,suffix,`${suffix}-b`,
      `ea-admin-${suffix}@example.invalid`,`ea-viewer-${suffix}@example.invalid`,
      `ea-other-${suffix}@example.invalid`,`ea-operator-${suffix}@example.invalid`,
      hash(sessionAdmin),hash(sessionOperator),hash(sessionViewer),hash(sessionOther),
      csrfAdmin,csrfOperator,csrfViewer,csrfOther,
      `ea-employee-${suffix}@example.invalid`,priorityHigh,priorityMedium,
    ]);
    const row=seeded.rows[0];
    ctx={
      pool,tenantA:row.tenant_a,tenantB:row.tenant_b,siteA:row.site_a,siteB:row.site_b,
      admin:row.admin,operator:row.operator,viewer:row.viewer,other:row.other,employee:row.employee,
      priorityHigh,priorityMedium,alarm:row.alarm,documentApproved:row.document_approved,
      documentPending:row.document_pending,rule:row.rule,
      headersAdmin:{Cookie:[`securityops_session=${sessionAdmin}`,`securityops_csrf=${csrfAdmin}`],'x-csrf-token':csrfAdmin},
      headersOperator:{Cookie:[`securityops_session=${sessionOperator}`,`securityops_csrf=${csrfOperator}`],'x-csrf-token':csrfOperator},
      headersViewer:{Cookie:[`securityops_session=${sessionViewer}`,`securityops_csrf=${csrfViewer}`],'x-csrf-token':csrfViewer},
      headersOther:{Cookie:[`securityops_session=${sessionOther}`,`securityops_csrf=${csrfOther}`],'x-csrf-token':csrfOther},
    };
  });

  afterEach(async()=>{
    if(originalScopes.length){
      for(const row of originalScopes){
        await pool.query('UPDATE role_permissions SET scope=$1,updated_at=now() WHERE role=$2 AND permission_id=$3',[row.scope,row.role,row.permission_id]);
      }
      originalScopes=[];
    }
    if(ctx)await pool.query('DELETE FROM tenants WHERE id IN ($1,$2)',[ctx.tenantA,ctx.tenantB]);
  });

  afterAll(async()=>{await pool?.end();});

  const get=(path:string,headers=ctx.headersAdmin)=>request(app!).get(`/api/v1${path}`).set(headers);
  const post=(path:string,body:unknown,headers=ctx.headersAdmin)=>request(app!).post(`/api/v1${path}`).set(headers).send(body);
  const patch=(path:string,body:unknown,headers=ctx.headersAdmin)=>request(app!).patch(`/api/v1${path}`).set(headers).send(body);
  const incidentBody=(overrides:Record<string,unknown>={})=>({
    incident_type_code:'technical_fault',priority_id:ctx.priorityHigh,
    description:'Technische Störung im Objekt A',site_id:ctx.siteA,...overrides,
  });
  const createIncident=async(overrides:Record<string,unknown>={},headers=ctx.headersAdmin)=>{
    const response=await post('/einsatz/incidents',incidentBody(overrides),headers);
    expect(response.status).toBe(201);
    return response.body;
  };
  const waitFor=async(check:()=>Promise<boolean>)=>{
    for(let attempt=0;attempt<40;attempt+=1){
      if(await check())return;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  };

  it('vergibt je Mandant und Jahr eindeutige, fortlaufende Vorgangsnummern',async()=>{
    const first=await createIncident();
    const second=await createIncident({description:'Zweite technische Störung'});
    const year=new Date().getFullYear();
    expect(first.incident_number).toBe(`INC-${year}-000001`);
    expect(second.incident_number).toBe(`INC-${year}-000002`);
    const list=await get('/einsatz/incidents',ctx.headersAdmin);
    expect(list.status).toBe(200);
    expect(list.body.map((incident:{incident_number:string})=>incident.incident_number)).toEqual(
      expect.arrayContaining([first.incident_number,second.incident_number]));
  });

  it('ist bei Vorfällen idempotent und meldet abweichende Wiederholungen als Konflikt',async()=>{
    const mutationId=randomUUID();
    const first=await post('/einsatz/incidents',incidentBody({client_mutation_id:mutationId}));
    expect(first.status).toBe(201);
    const replay=await post('/einsatz/incidents',incidentBody({client_mutation_id:mutationId}));
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    const conflict=await post('/einsatz/incidents',incidentBody({client_mutation_id:mutationId,description:'Andere Ursache'}));
    expect(conflict.status).toBe(409);
    expect(conflict.body.reason_code??conflict.body.error_code).toBe('idempotency_conflict');
  });

  it('dedupliziert Alarme über source_key und protokolliert nur eine Entstehung',async()=>{
    const body={description:'Doppelter Sensoralarm',site_id:ctx.siteA,source_key:`sensor-${randomUUID()}`};
    const first=await post('/einsatz/alarms',body);
    expect(first.status).toBe(201);
    const replay=await post('/einsatz/alarms',body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    const conflict=await post('/einsatz/alarms',{...body,description:'Abweichender Sensoralarm'});
    expect(conflict.status).toBe(409);
    const history=await get(`/einsatz/alarms/${first.body.id}/history`);
    expect(history.status).toBe(200);
    expect(history.body.filter((entry:{to_status:string})=>entry.to_status==='open')).toHaveLength(1);
    const forwards=await ctx.pool.query('SELECT count(*)::int count FROM alarm_forwarding_deliveries WHERE tenant_id=$1',[ctx.tenantA]);
    expect(forwards.rows[0].count).toBe(0);
  });

  it('bestätigt Alarme, ohne die Ursache zu beseitigen',async()=>{
    const acknowledged=await post(`/einsatz/alarms/${ctx.alarm}/acknowledge`,{});
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.status).toBe('acknowledged');
    expect(acknowledged.body.resolved_at).toBeNull();
    const history=await get(`/einsatz/alarms/${ctx.alarm}/history`);
    expect(history.body.map((entry:{note:string})=>entry.note)).toContain('Bestätigung beseitigt die Ursache nicht');
    const center=await get('/operations/control-center');
    expect(center.status).toBe(200);
    expect(center.body.alerts.map((alert:{code:string})=>alert.code)).toContain('active_alarm');
    const audit=await ctx.pool.query(`SELECT details FROM audit_events WHERE tenant_id=$1 AND entity_type='alarm' AND entity_id=$2 AND event_type='alarm.acknowledged'`,[ctx.tenantA,ctx.alarm]);
    expect(audit.rows[0].details.resolution).toBe(false);
  });

  it('verhindert die Alarmauflösung bei offenem Vorfall und erlaubt sie nach erzwungenem Abschluss',async()=>{
    expect((await post(`/einsatz/alarms/${ctx.alarm}/acknowledge`,{})).status).toBe(200);
    const incident=await createIncident({alarm_id:ctx.alarm});
    const blocked=await post(`/einsatz/alarms/${ctx.alarm}/resolve`,{reason:'Ursache behoben'});
    expect(blocked.status).toBe(409);
    expect(blocked.body.reason_code).toBe('linked_incident_open');
    expect((await post(`/einsatz/incidents/${incident.id}/status`,{status:'en_route'})).status).toBe(200);
    expect((await post(`/einsatz/incidents/${incident.id}/status`,{status:'on_site'})).status).toBe(200);
    const invalidClose=await post(`/einsatz/incidents/${incident.id}/status`,{status:'completed'});
    expect(invalidClose.status).toBe(409);
    expect(invalidClose.body.reason_code).toBe('closure_conditions');
    const forced=await post(`/einsatz/incidents/${incident.id}/status`,{status:'completed',force:true,reason:'Ausnahmsweise manuell freigegeben'});
    expect(forced.status).toBe(200);
    expect(forced.body.closure_note).toBe('Ausnahmsweise manuell freigegeben');
    const resolved=await post(`/einsatz/alarms/${ctx.alarm}/resolve`,{reason:'Ursache behoben'});
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('resolved');
    expect(resolved.body.resolved_at).not.toBeNull();
  });

  it('blockiert den Vorfallabschluss bei offenen Maßnahmen und gibt ihn nach Erledigung frei',async()=>{
    const incident=await createIncident();
    expect((await post(`/einsatz/incidents/${incident.id}/status`,{status:'en_route'})).status).toBe(200);
    expect((await post(`/einsatz/incidents/${incident.id}/status`,{status:'on_site'})).status).toBe(200);
    const measure=await post('/operations/measures',{
      title:'Störung vor Ort prüfen',module:'einsatz',incident_id:incident.id,site_id:ctx.siteA,
    });
    expect(measure.status).toBe(201);
    const blocked=await post(`/einsatz/incidents/${incident.id}/status`,{status:'completed'});
    expect(blocked.status).toBe(409);
    expect(blocked.body.reason_code).toBe('closure_conditions');
    expect(blocked.body.details?.open_measures??blocked.body.open_measures).toEqual(
      expect.arrayContaining([expect.objectContaining({id:measure.body.id})]));
    expect((await patch(`/operations/measures/${measure.body.id}`,{status:'done',reason:'Prüfung abgeschlossen'})).status).toBe(200);
    const completed=await post(`/einsatz/incidents/${incident.id}/status`,{status:'completed',reason:'Störung behoben'});
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('completed');
    expect(completed.body.closed_by).toBe(ctx.admin);
    const detail=await get(`/einsatz/incidents/${incident.id}`);
    expect(detail.body.history.map((entry:{event_type:string})=>entry.event_type)).toContain('closed');
  });

  it('verknüpft nur freigegebene DMS-Dokumente und gibt ausschließlich Downloadlinks zurück',async()=>{
    const incident=await createIncident();
    const linked=await post(`/einsatz/incidents/${incident.id}/documents`,{
      document_id:ctx.documentApproved,category:'evidence',note:'Foto der Anlage',
    });
    expect(linked.status).toBe(201);
    expect(linked.body.download_url).toMatch(/^\/api\/v1\/dms\/documents\/.+\/versions\/.+\/download$/);
    expect(linked.body.preview_url).toMatch(/^\/api\/v1\/dms\/documents\/.+\/versions\/.+\/preview$/);
    expect(JSON.stringify(linked.body)).not.toContain('object_key');
    expect(JSON.stringify(linked.body)).not.toContain('qa/einsatz');
    const pending=await post(`/einsatz/incidents/${incident.id}/documents`,{document_id:ctx.documentPending});
    expect(pending.status).toBe(409);
    expect((await post(`/einsatz/incidents/${incident.id}/documents`,{document_id:ctx.documentApproved},ctx.headersViewer)).status).toBe(403);
    const listed=await get(`/einsatz/incidents/${incident.id}/documents`,ctx.headersViewer);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    const removed=await request(app!).delete(`/api/v1/einsatz/incidents/${incident.id}/documents`)
      .set(ctx.headersAdmin).query({link_id:linked.body.id});
    expect(removed.status).toBe(200);
    expect((await get(`/einsatz/incidents/${incident.id}/documents`)).body).toEqual([]);
  });

  it('eskaliert konfigurierbar, protokolliert und zeigt nur echte Zustellzustände',async()=>{
    await ctx.pool.query(`INSERT INTO notification_subscriptions(tenant_id,event_type,channel,recipient,role)
      VALUES ($1,'incident.escalated','email','ops@example.invalid','admin')`,[ctx.tenantA]);
    const incident=await createIncident();
    const configured=await patch(`/einsatz/escalation-rules/${ctx.rule}`,{
      target_status:'acknowledged',notify_enabled:false,reason:'Regel für QA angepasst',
    });
    expect(configured.status).toBe(200);
    expect(configured.body.target_status).toBe('acknowledged');
    expect(configured.body.notify_enabled).toBe(false);
    const first=await post(`/einsatz/incidents/${incident.id}/escalations`,{rule_id:ctx.rule});
    expect(first.status).toBe(201);
    expect(first.body.to_status).toBe('acknowledged');
    expect(first.body.trigger).toBe('manual');
    const beforeDelivery=await ctx.pool.query(`SELECT count(*)::int count FROM notification_deliveries WHERE tenant_id=$1 AND event_key LIKE $2`,[ctx.tenantA,`incident:${incident.id}:%`]);
    expect(beforeDelivery.rows[0].count).toBe(0);
    expect((await patch(`/einsatz/escalation-rules/${ctx.rule}`,{notify_enabled:true})).status).toBe(200);
    expect((await post(`/einsatz/incidents/${incident.id}/escalations`,{rule_id:ctx.rule})).status).toBe(201);
    await waitFor(async()=>{
      const result=await ctx.pool.query(`SELECT count(*)::int count FROM notification_deliveries WHERE tenant_id=$1 AND event_key LIKE $2`,[ctx.tenantA,`incident:${incident.id}:%`]);
      return result.rows[0].count>0;
    });
    const notifications=await get(`/einsatz/notifications/${incident.id}`);
    expect(notifications.status).toBe(200);
    expect(notifications.body.length).toBeGreaterThan(0);
    expect(notifications.body.every((delivery:{status:string})=>['pending','processing','failed','sent'].includes(delivery.status))).toBe(true);
    expect(notifications.body.every((delivery:{recipient_masked:string})=>!delivery.recipient_masked.includes('ops@example.invalid'))).toBe(true);
    const log=await get(`/einsatz/incidents/${incident.id}/escalations`);
    expect(log.body).toHaveLength(2);
    const forwards=await ctx.pool.query('SELECT count(*)::int count FROM alarm_forwarding_deliveries WHERE tenant_id=$1',[ctx.tenantA]);
    expect(forwards.rows[0].count).toBe(0);
  });

  it('führt einen revisionsfähigen Einsatzbericht mit Dokumentenlink',async()=>{
    const incident=await createIncident();
    const created=await patch(`/einsatz/incidents/${incident.id}/report`,{
      summary:'Alarm geprüft',cause:'Sensor defekt',actions:'Sensor getauscht',result:'Anlage wieder aktiv',
      document_id:ctx.documentApproved,
    });
    expect(created.status).toBe(200);
    const updated=await patch(`/einsatz/incidents/${incident.id}/report`,{result:'Anlage freigegeben'});
    expect(updated.status).toBe(200);
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body.cause).toBe('Sensor defekt');
    expect(updated.body.result).toBe('Anlage freigegeben');
    const report=await get(`/einsatz/incidents/${incident.id}/report`);
    expect(report.body.documents).toHaveLength(1);
    expect(report.body.documents[0].download_url).toContain('/download');
    expect((await patch(`/einsatz/incidents/${incident.id}/report`,{summary:'Nur Viewer'},ctx.headersViewer)).status).toBe(403);
  });

  it('erstellt Auswertungen ausschließlich aus echten Vorfalls-, Alarm- und Maßnahmendaten',async()=>{
    const incident=await createIncident({alarm_id:ctx.alarm});
    await post(`/einsatz/alarms/${ctx.alarm}/acknowledge`,{});
    await post(`/einsatz/incidents/${incident.id}/escalations`,{reason:'QA Eskalation'});
    expect((await post('/operations/measures',{title:'QA Auswertung',module:'einsatz',site_id:ctx.siteA})).status).toBe(201);
    const stats=await get('/einsatz/reports');
    expect(stats.status).toBe(200);
    expect(stats.body.totals.incidents).toBe(1);
    expect(stats.body.totals.alarms).toBe(1);
    expect(stats.body.totals.acknowledged_alarms).toBe(1);
    expect(stats.body.totals.escalations).toBe(1);
    expect(stats.body.totals.open_measures).toBe(1);
    expect(stats.body.by_site).toEqual([expect.objectContaining({site_id:ctx.siteA,incidents:1,alarms:1})]);
    const csv=await request(app!).get('/api/v1/einsatz/reports?format=csv').set(ctx.headersAdmin);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('objekt_id;objekt;vorfaelle');
    expect(csv.text).toContain('GESAMT');
    expect((await get('/einsatz/reports',ctx.headersViewer)).status).toBe(200);
    const foreign=await get('/einsatz/reports',ctx.headersOther);
    expect(foreign.status).toBe(200);
    expect(foreign.body.totals.incidents).toBe(0);
    expect(foreign.body.by_site.map((site:{site_id:string})=>site.site_id)).not.toContain(ctx.siteA);
  });

  it('trennt Mandanten und Rechte serverseitig für alle Einsatzendpunkte',async()=>{
    const incident=await createIncident();
    expect((await post('/einsatz/incidents',incidentBody(),ctx.headersViewer)).status).toBe(403);
    expect((await post(`/einsatz/alarms/${ctx.alarm}/acknowledge`,{},ctx.headersViewer)).status).toBe(403);
    expect((await patch(`/einsatz/incidents/${incident.id}/report`,{summary:'x'},ctx.headersViewer)).status).toBe(403);
    expect((await post(`/einsatz/incidents/${incident.id}/escalations`,{},ctx.headersViewer)).status).toBe(403);
    expect((await get(`/einsatz/incidents/${incident.id}`,ctx.headersOther)).status).toBe(404);
    expect((await get(`/einsatz/alarms/${ctx.alarm}/history`,ctx.headersOther)).status).toBe(404);
    const foreignList=await get('/einsatz/incidents',ctx.headersOther);
    expect(foreignList.status).toBe(200);
    expect(foreignList.body).toEqual([]);
    const foreignMeasures=await get('/einsatz/measures',ctx.headersOther);
    expect(foreignMeasures.body).toEqual([]);
  });

  it('wendet Objekt-Scopes an und unterstützt Suche, Sortierung und Pagination',async()=>{
    const permissions=(await ctx.pool.query<{key:string;id:string}>(`SELECT key,id FROM permissions WHERE key = ANY($1::text[])`,[
      ['incidents:read','incidents:write','alarms:read','alarms:write','incident_documents:read','incident_documents:write',
        'incident_reports:read','incident_reports:write','incidents:escalate','escalation_log:read',
        'einsatz:reports:read','escalation_rules:read','escalation_rules:write','notifications:read',
        'operations_measures:read','operations_measures:write','dms:read'],
    ])).rows;
    originalScopes=(await ctx.pool.query<{role:string;permission_id:string;scope:string}>(
      `SELECT role,permission_id,scope FROM role_permissions WHERE role='operator' AND permission_id = ANY($1::uuid[])`,
      [permissions.map(row=>row.id)],
    )).rows;
    try{
      await ctx.pool.query(`UPDATE role_permissions SET scope='site',updated_at=now() WHERE role='operator' AND permission_id = ANY($1::uuid[])`,[permissions.map(row=>row.id)]);
      await ctx.pool.query('INSERT INTO user_sites(tenant_id,user_id,site_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.tenantA,ctx.operator,ctx.siteA]);
      const first=await createIncident();
      await createIncident({description:'Zweite Störung zur Suche'});
      const scoped=await get('/einsatz/incidents',ctx.headersOperator);
      expect(scoped.status).toBe(200);
      expect(scoped.body).toHaveLength(2);
      expect((await post('/einsatz/incidents',incidentBody({site_id:ctx.siteB}),ctx.headersOperator)).status).toBe(403);
      expect((await get(`/einsatz/incidents?site_id=${ctx.siteB}`,ctx.headersOperator)).status).toBe(403);
      const search=await get('/einsatz/incidents?q=Zweite%20St%C3%B6rung&sort=incident_number&dir=asc&page=1&pageSize=1');
      expect(search.status).toBe(200);
      expect(search.body).toEqual([expect.objectContaining({description:'Zweite Störung zur Suche'})]);
      expect(Number(search.headers['x-total-count'])).toBe(1);
      expect(Number(search.headers['x-page-count'])).toBe(1);
      const invalidPage=await get('/einsatz/incidents?page=0');
      expect(invalidPage.status).toBe(400);
      const alarmList=await get('/einsatz/alarms?status=open&severity=high&site_id='+ctx.siteA);
      expect(alarmList.status).toBe(200);
      expect(alarmList.body.map((alarm:{id:string})=>alarm.id)).toContain(ctx.alarm);
      const detail=await get(`/einsatz/incidents/${first.id}`,ctx.headersOperator);
      expect(detail.status).toBe(200);
      expect(detail.body.incident_number).toEqual(expect.stringMatching(/^INC-[0-9]{4}-[0-9]{6}$/));
    } finally {
      for(const row of originalScopes){
        await ctx.pool.query('UPDATE role_permissions SET scope=$1,updated_at=now() WHERE role=$2 AND permission_id=$3',[row.scope,row.role,row.permission_id]);
      }
      originalScopes=[];
    }
  });
});
