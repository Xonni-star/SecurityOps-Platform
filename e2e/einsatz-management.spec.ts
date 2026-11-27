import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import {
  apiBase,createIsolatedSite,decommissionSite,email,errorJson,expectStatus,fixture,hasPath,
  isoIn,loginApi,loginUi,openApiPaths,password,permissionList,readJson,type Row,type Session,
} from './helpers/operative-e2e';

/**
 * Einsatzmanagement: Vorfälle, Alarme, Eskalationen, Maßnahmen und Auswertungen
 * werden über die echten Backend-Endpunkte gegen den isolierten Fixture-Tenant
 * geprüft. Es gibt keine externen Notrufe und keine simulierten Zustellungen.
 */
test.skip(process.env.E2E_FIXTURE!=='isolated',
  'Nur gegen den isolierten Fixture-Tenant ausführen (E2E_FIXTURE=isolated).');
test.skip(!email||!password,'Set E2E_EMAIL and E2E_PASSWORD to run the Einsatzmanagement E2E tests.');

const runId=`${Date.now().toString(36)}${randomUUID().slice(0,6)}`;
const administrativeReason=`E2E Einsatzmanagement ${runId}`;

let admin:Session;
let operator:Session;
let viewer:Session;
let foreign:Session;
let siteId='';
const incidentIds:string[]=[];
const alarmIds:string[]=[];
const measureIds:string[]=[];
const originalRules:Row[]=[];
const capabilities={
  incidents:false,
  status:false,
  assignments:false,
  reports:false,
  escalations:false,
  alarms:false,
  rules:false,
  notifications:false,
  measures:false,
};

async function createIncident(label:string,overrides:Row={}):Promise<Row>{
  const response=await admin.context.post('/api/v1/einsatz/incidents',{headers:admin.headers,data:{
    incident_type_code:'technical_fault',priority_id:fixture.criticalPriorityId,
    description:`E2E ${label} ${runId}`,site_id:siteId,employee_id:fixture.employeeId,
    source:'playwright-einsatz',source_key:`e2e-einsatz-${label.toLowerCase().replace(/[^a-z0-9]/g,'-')}-${runId}`,
    client_mutation_id:randomUUID(),reason:administrativeReason,...overrides,
  }});
  const row=await readJson(response,`Vorfall anlegen (${label})`);
  expect(response.status()).toBe(201);
  const id=String(row.id);
  incidentIds.push(id);
  return row;
}

async function createAlarm(label:string,overrides:Row={}):Promise<Row>{
  const response=await admin.context.post('/api/v1/einsatz/alarms',{headers:admin.headers,data:{
    type:'alarm',priority_code:'critical',source:'playwright-einsatz',
    description:`E2E ${label} ${runId}`,site_id:siteId,device_id:fixture.operationalDeviceId,
    source_key:`e2e-alarm-${label.toLowerCase().replace(/[^a-z0-9]/g,'-')}-${runId}`,
    client_mutation_id:randomUUID(),reason:administrativeReason,...overrides,
  }});
  const row=await readJson(response,`Alarm anlegen (${label})`);
  expect(response.status()).toBe(201);
  const id=String(row.id);
  alarmIds.push(id);
  return row;
}

async function createLinkedMeasure(incidentId:string):Promise<string>{
  const response=await admin.context.post('/api/v1/operations/measures',{headers:admin.headers,data:{
    title:`E2E Einsatzmaßnahme ${runId}`,description:administrativeReason,module:'einsatz',priority:'high',
    status:'open',site_id:siteId,incident_id:incidentId,assigned_employee_id:fixture.employeeId,
    due_at:isoIn(1),source_key:`e2e-einsatz-measure-${incidentId}`,reason:administrativeReason,
  }});
  const row=await readJson(response,'Verknüpfte Maßnahme anlegen');
  expect(response.status()).toBe(201);
  const id=String(row.id);
  measureIds.push(id);
  return id;
}

test.beforeAll(async({request,playwright})=>{
  const ready=await request.get(`${apiBase}/ready`);
  expect(ready.ok(),`Backend ${apiBase}/ready nicht bereit: HTTP ${ready.status()}`).toBeTruthy();
  const paths=await openApiPaths(request);
  capabilities.incidents=hasPath(paths,'/einsatz/incidents','get')&&hasPath(paths,'/einsatz/incidents','post')
    &&hasPath(paths,'/einsatz/incidents/{id}','get')&&hasPath(paths,'/einsatz/incidents/{id}','patch');
  capabilities.status=hasPath(paths,'/einsatz/incidents/{id}/status','post');
  capabilities.assignments=hasPath(paths,'/einsatz/incidents/{id}/assignments','post');
  capabilities.reports=hasPath(paths,'/einsatz/reports','get')
    &&hasPath(paths,'/einsatz/incidents/{id}/report','get')
    &&hasPath(paths,'/einsatz/incidents/{id}/report','patch');
  capabilities.escalations=hasPath(paths,'/einsatz/incidents/{id}/escalations','get')
    &&hasPath(paths,'/einsatz/incidents/{id}/escalations','post');
  capabilities.alarms=hasPath(paths,'/einsatz/alarms','get')&&hasPath(paths,'/einsatz/alarms','post')
    &&hasPath(paths,'/einsatz/alarms/{id}/acknowledge','post')
    &&hasPath(paths,'/einsatz/alarms/{id}/resolve','post')
    &&hasPath(paths,'/einsatz/alarms/{id}/history','get');
  capabilities.rules=hasPath(paths,'/einsatz/escalation-rules','get')
    &&hasPath(paths,'/einsatz/escalation-rules/{id}','patch');
  capabilities.notifications=hasPath(paths,'/einsatz/notifications/{incidentId}','get');
  capabilities.measures=hasPath(paths,'/einsatz/measures','get');

  admin=await loginApi(playwright,process.env.E2E_ADMIN_EMAIL??'e2e-qm-admin@example.invalid',
    process.env.E2E_ADMIN_PASSWORD??password,'playwright-einsatz-admin');
  operator=await loginApi(playwright,email,password,'playwright-einsatz-operator');
  viewer=await loginApi(playwright,process.env.E2E_VIEWER_EMAIL??'e2e-viewer@example.invalid',
    password,'playwright-einsatz-viewer');
  foreign=await loginApi(playwright,process.env.E2E_FOREIGN_EMAIL??'admin@example.com',
    process.env.E2E_FOREIGN_PASSWORD??'password','playwright-einsatz-foreign');

  expect(admin.tenantId).toBe(fixture.tenantId);
  expect(operator.tenantId).toBe(fixture.tenantId);
  expect(viewer.tenantId).toBe(fixture.tenantId);
  expect(foreign.tenantId).not.toBe(fixture.tenantId);
  for(const permission of ['incidents:write','alarms:write','incidents:escalate','escalation_rules:write']){
    expect(permissionList(admin)).toContain(permission);
    expect(permissionList(operator)).toContain(permission);
    expect(permissionList(viewer)).not.toContain(permission);
  }
  siteId=await createIsolatedSite(admin,'Einsatz',runId);
});

test.afterAll(async()=>{
  if(admin){
    for(const id of [...alarmIds].reverse()){
      const acknowledged=await admin.context.post(`/api/v1/einsatz/alarms/${id}/acknowledge`,{headers:admin.headers});
      if(![200,409,404].includes(acknowledged.status()))console.warn(`Cleanup Alarm ${id} acknowledge: HTTP ${acknowledged.status()}`);
      const resolved=await admin.context.post(`/api/v1/einsatz/alarms/${id}/resolve`,{
        headers:admin.headers,data:{reason:`Cleanup ${administrativeReason}`},
      });
      if(![200,409,404].includes(resolved.status()))console.warn(`Cleanup Alarm ${id} resolve: HTTP ${resolved.status()}`);
    }
    for(const id of [...measureIds].reverse()){
      const response=await admin.context.patch(`/api/v1/operations/measures/${id}`,{
        headers:admin.headers,data:{status:'cancelled',reason:`Cleanup ${administrativeReason}`},
      });
      if(![200,404].includes(response.status()))console.warn(`Cleanup Maßnahme ${id}: HTTP ${response.status()}`);
    }
    for(const id of [...incidentIds].reverse()){
      const detail=await admin.context.get(`/api/v1/einsatz/incidents/${id}`,{headers:admin.headers});
      if(!detail.ok())continue;
      const row=await detail.json() as Row;
      if(['completed','cancelled'].includes(String(row.status)))continue;
      const cancelled=await admin.context.post(`/api/v1/einsatz/incidents/${id}/status`,{
        headers:admin.headers,data:{status:'cancelled',force:true,reason:`Cleanup ${administrativeReason}`},
      });
      if(![200,409].includes(cancelled.status()))console.warn(`Cleanup Vorfall ${id}: HTTP ${cancelled.status()}`);
    }
    for(const rule of originalRules){
      const data:Row={reason:`Cleanup ${administrativeReason}`,enabled:rule.enabled,
        notify_enabled:rule.notify_enabled,target_user_id:rule.target_user_id??null};
      if(['escalated','acknowledged'].includes(String(rule.target_status)))data.target_status=rule.target_status;
      const response=await admin.context.patch(`/api/v1/einsatz/escalation-rules/${rule.id}`,{
        headers:admin.headers,data,
      });
      if(response.status()!==200)console.warn(`Cleanup Eskalationsregel ${rule.id}: HTTP ${response.status()}`);
    }
    if(siteId)await decommissionSite(admin,siteId,`Einsatz ${runId}`);
  }
  for(const session of [admin,operator,viewer,foreign])await session?.context.dispose();
});

test('Vorfälle werden idempotent angelegt, gesucht, bearbeitet und zugewiesen',async()=>{
  test.skip(!capabilities.incidents||!capabilities.assignments,
    'SKIP: Vorfalls- oder Zuweisungs-API fehlt in /api/openapi.json');
  const sourceKey=`e2e-einsatz-create-${runId}`;
  const payload={
    incident_type_code:'technical_fault',priority_id:fixture.criticalPriorityId,
    description:`E2E Vorfall ${runId}`,site_id:siteId,employee_id:fixture.employeeId,
    source:'playwright-einsatz',source_key:sourceKey,client_mutation_id:randomUUID(),reason:administrativeReason,
  };
  const created=await admin.context.post('/api/v1/einsatz/incidents',{headers:admin.headers,data:payload});
  const row=await readJson(created,'Vorfall anlegen');
  expect(created.status()).toBe(201);
  const incidentId=String(row.id);
  incidentIds.push(incidentId);
  expect(row.status).toBe('initiated');
  expect(row.incident_number).toBeTruthy();

  const replay=await admin.context.post('/api/v1/einsatz/incidents',{headers:admin.headers,data:payload});
  expect((await readJson(replay,'Idempotente Vorfallswiedergabe')).id).toBe(incidentId);
  expect(replay.status()).toBe(200);
  const conflict=await admin.context.post('/api/v1/einsatz/incidents',{headers:admin.headers,data:{
    ...payload,description:`E2E Vorfall geändert ${runId}`,
  }});
  expect((await errorJson(conflict,409,'Idempotenzkonflikt Vorfall')).reason_code).toBe('idempotency_conflict');

  const list=await admin.context.get('/api/v1/einsatz/incidents',{headers:admin.headers,params:{
    q:runId,site_id:siteId,status:'initiated',page:1,page_size:25,
  }});
  const rows=await readJson(list,'Vorfallliste');
  expect(rows.some((item:Row)=>String(item.id)===incidentId)).toBeTruthy();
  expect(Number(list.headers()['x-total-count'])).toBeGreaterThanOrEqual(1);

  const detail=await readJson(await admin.context.get(`/api/v1/einsatz/incidents/${incidentId}`,{
    headers:admin.headers,
  }),'Vorfallakte');
  for(const key of ['history','assignees','documents','measures','report','escalation_log','notifications']){
    expect(detail[key],`Vorfallakte enthält ${key} nicht`).toBeDefined();
  }

  const updated=await admin.context.patch(`/api/v1/einsatz/incidents/${incidentId}`,{
    headers:admin.headers,data:{description:`E2E Vorfall bearbeitet ${runId}`,reason:administrativeReason},
  });
  expect((await readJson(updated,'Vorfall bearbeiten')).description).toContain('bearbeitet');

  const assignment=await admin.context.post(`/api/v1/einsatz/incidents/${incidentId}/assignments`,{
    headers:admin.headers,data:{employee_id:fixture.employeeId},
  });
  await expectStatus(assignment,201,'Vorfallzuweisung');
  const afterAssignment=await readJson(await admin.context.get(`/api/v1/einsatz/incidents/${incidentId}`,{
    headers:admin.headers,
  }),'Vorfallakte nach Zuweisung');
  expect(afterAssignment.assignees.some((item:Row)=>String(item.id)===fixture.employeeId)).toBeTruthy();
});

test('Statuswechsel prüft Übergänge, Abschlussbedingungen und Begründungen',async()=>{
  test.skip(!capabilities.incidents||!capabilities.status,
    'SKIP: Vorfalls- oder Status-API fehlt in /api/openapi.json');
  const incident=await createIncident('Statusvorfall');
  const incidentId=String(incident.id);
  const invalid=await admin.context.post(`/api/v1/einsatz/incidents/${incidentId}/status`,{
    headers:admin.headers,data:{status:'on_site',reason:administrativeReason},
  });
  expect((await errorJson(invalid,409,'Ungültiger Statuswechsel')).reason_code).toBe('invalid_transition');

  const measureId=await createLinkedMeasure(incidentId);
  for(const status of ['en_route','on_site']){
    const response=await admin.context.post(`/api/v1/einsatz/incidents/${incidentId}/status`,{
      headers:admin.headers,data:{status,reason:administrativeReason},
    });
    expect((await readJson(response,`Status ${status}`)).status).toBe(status);
  }
  const shortForce=await admin.context.post(`/api/v1/einsatz/incidents/${incidentId}/status`,{
    headers:admin.headers,data:{status:'completed',force:true,reason:'kurz'},
  });
  await errorJson(shortForce,400,'Erzwungener Abschluss ohne Begründung');

  const blocked=await admin.context.post(`/api/v1/einsatz/incidents/${incidentId}/status`,{
    headers:admin.headers,data:{status:'completed',reason:administrativeReason},
  });
  const blockedBody=await errorJson(blocked,409,'Abschluss mit offener Maßnahme');
  expect(blockedBody.reason_code).toBe('closure_conditions');
  expect(blockedBody.details.open_measures.some((item:Row)=>String(item.id)===measureId)).toBeTruthy();

  const closedMeasure=await admin.context.patch(`/api/v1/operations/measures/${measureId}`,{
    headers:admin.headers,data:{status:'done',reason:administrativeReason},
  });
  expect((await readJson(closedMeasure,'Maßnahme abschließen')).status).toBe('done');
  const completed=await admin.context.post(`/api/v1/einsatz/incidents/${incidentId}/status`,{
    headers:admin.headers,data:{status:'completed',reason:`E2E Abschluss ${runId}`},
  });
  const completedRow=await readJson(completed,'Vorfall abschließen');
  expect(completedRow.status).toBe('completed');
  expect(completedRow.closed_at).toBeTruthy();
});

test('Alarme werden dedupliziert, quittiert und erst nach Beseitigung der Ursache gelöst',async()=>{
  test.skip(!capabilities.alarms||!capabilities.incidents,
    'SKIP: Alarm- oder Vorfall-API fehlt in /api/openapi.json');
  const alarm=await createAlarm('Alarmkreislauf');
  const alarmId=String(alarm.id);
  const replay=await admin.context.post('/api/v1/einsatz/alarms',{headers:admin.headers,data:{
    type:'alarm',priority_code:'critical',source:'playwright-einsatz',
    description:`E2E Alarmkreislauf ${runId}`,site_id:siteId,device_id:fixture.operationalDeviceId,
    source_key:`e2e-alarm-alarmkreislauf-${runId}`,client_mutation_id:randomUUID(),reason:administrativeReason,
  }});
  expect((await readJson(replay,'Idempotente Alarmwiedergabe')).id).toBe(alarmId);
  expect(replay.status()).toBe(200);
  const conflict=await admin.context.post('/api/v1/einsatz/alarms',{headers:admin.headers,data:{
    type:'alarm',priority_code:'critical',source:'playwright-einsatz',
    description:`E2E Alarm abweichend ${runId}`,site_id:siteId,
    source_key:`e2e-alarm-alarmkreislauf-${runId}`,reason:administrativeReason,
  }});
  expect((await errorJson(conflict,409,'Idempotenzkonflikt Alarm')).reason_code).toBe('idempotency_conflict');

  const list=await admin.context.get('/api/v1/einsatz/alarms',{headers:admin.headers,params:{
    q:runId,status:'open',severity:'critical',site_id:siteId,page:1,page_size:25,
  }});
  expect((await readJson(list,'AlarmListe')).some((item:Row)=>String(item.id)===alarmId)).toBeTruthy();

  const acknowledged=await admin.context.post(`/api/v1/einsatz/alarms/${alarmId}/acknowledge`,{
    headers:admin.headers,
  });
  expect((await readJson(acknowledged,'Alarm quittieren')).status).toBe('acknowledged');
  const secondAck=await admin.context.post(`/api/v1/einsatz/alarms/${alarmId}/acknowledge`,{
    headers:admin.headers,
  });
  expect((await errorJson(secondAck,409,'Zweite Quittierung')).error).toContain('Nur offene Alarme können bestätigt werden');
  const history=await readJson(await admin.context.get(`/api/v1/einsatz/alarms/${alarmId}/history`,{
    headers:admin.headers,
  }),'Alarmhistorie');
  expect(history.some((entry:Row)=>String(entry.note).includes('Bestätigung beseitigt die Ursache nicht'))).toBeTruthy();

  const linkedIncident=await createIncident('Alarmvorfall',{alarm_id:alarmId});
  const blocked=await admin.context.post(`/api/v1/einsatz/alarms/${alarmId}/resolve`,{
    headers:admin.headers,data:{reason:`E2E Alarm gelöst ${runId}`},
  });
  const blockedBody=await errorJson(blocked,409,'Alarm mit offenem Vorfall');
  expect(blockedBody.reason_code).toBe('linked_incident_open');
  const cancelled=await admin.context.post(`/api/v1/einsatz/incidents/${String(linkedIncident.id)}/status`,{
    headers:admin.headers,data:{status:'cancelled',force:true,reason:`E2E Vorfall mit offenem Alarm abgebrochen ${runId}`},
  });
  expect((await readJson(cancelled,'Verknüpften Vorfall abbrechen')).status).toBe('cancelled');
  const resolved=await admin.context.post(`/api/v1/einsatz/alarms/${alarmId}/resolve`,{
    headers:admin.headers,data:{reason:`E2E Alarm gelöst ${runId}`},
  });
  expect((await readJson(resolved,'Alarm auflösen')).status).toBe('resolved');
});

test('Eskalation, Benachrichtigungsstatus, Regeln und Auswertung stammen aus echten Daten',async()=>{
  test.skip(!capabilities.incidents||!capabilities.escalations||!capabilities.reports,
    'SKIP: Eskalations- oder Berichts-API fehlt in /api/openapi.json');
  const incident=await createIncident('Eskalationsvorfall');
  const incidentId=String(incident.id);
  const escalation=await admin.context.post(`/api/v1/einsatz/incidents/${incidentId}/escalations`,{
    headers:admin.headers,data:{
      target_status:'escalated',target_user_id:fixture.adminUserId,reason:`E2E Eskalation ${runId}`,
    },
  });
  await expectStatus(escalation,201,'Manuelle Eskalation');
  const log=await readJson(await admin.context.get(`/api/v1/einsatz/incidents/${incidentId}/escalations`,{
    headers:admin.headers,
  }),'Eskalationsprotokoll');
  expect(log.some((entry:Row)=>String(entry.reason).includes(runId))).toBeTruthy();

  if(capabilities.rules){
    const rules=await readJson(await admin.context.get('/api/v1/einsatz/escalation-rules',{
      headers:admin.headers,
    }),'Eskalationsregeln');
    if(rules.length>0){
      const rule=rules[0] as Row;
      originalRules.push({id:String(rule.id),enabled:rule.enabled,target_status:rule.target_status,
        notify_enabled:rule.notify_enabled,target_user_id:rule.target_user_id??null});
      const patched=await admin.context.patch(`/api/v1/einsatz/escalation-rules/${rule.id}`,{
        headers:admin.headers,data:{
          enabled:false,target_status:'acknowledged',notify_enabled:false,reason:`E2E Regeldeaktivierung ${runId}`,
        },
      });
      expect((await readJson(patched,'Eskalationsregel deaktivieren')).enabled).toBe(false);
    }
  }

  const report=await admin.context.patch(`/api/v1/einsatz/incidents/${incidentId}/report`,{
    headers:admin.headers,data:{
      summary:`E2E Bericht ${runId}`,cause:'Technischer Fehler',
      actions:'Maßnahme veranlasst',result:`E2E Abschluss ${runId}`,
    },
  });
  expect((await readJson(report,'Einsatzbericht speichern')).summary).toContain(runId);
  expect((await readJson(await admin.context.get(`/api/v1/einsatz/incidents/${incidentId}/report`,{
    headers:admin.headers,
  }),'Einsatzbericht lesen')).summary).toContain(runId);

  const params={from:isoIn(-1),to:isoIn(1),site_id:siteId,format:'json'};
  const stats=await readJson(await admin.context.get('/api/v1/einsatz/reports',{
    headers:admin.headers,params,
  }),'Einsatzauswertung');
  expect(stats.totals.incidents).toBeGreaterThanOrEqual(1);
  expect(stats.totals.escalations).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(stats.by_site)).toBeTruthy();

  const csv=await admin.context.get('/api/v1/einsatz/reports',{
    headers:admin.headers,params:{...params,format:'csv'},
  });
  await expectStatus(csv,200,'Einsatzbericht CSV');
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect(await csv.text()).toContain('objekt_id');

  if(capabilities.notifications){
    const notifications=await readJson(await admin.context.get(`/api/v1/einsatz/notifications/${incidentId}`,{
      headers:admin.headers,
    }),'Benachrichtigungsstatus');
    for(const delivery of notifications){
      expect(['pending','processing','sent','failed']).toContain(delivery.status);
      expect(delivery.recipient_masked).toBeTruthy();
      expect(delivery.recipient).toBeUndefined();
      expect(delivery.token).toBeUndefined();
    }
  }
});

test('Rollen- und Mandantengrenzen gelten für Lese- und Schreibzugriffe',async()=>{
  test.skip(!capabilities.incidents||!capabilities.alarms||!capabilities.status,
    'SKIP: Vorfalls-, Alarm- oder Status-API fehlt in /api/openapi.json');
  const incident=await createIncident('RBAC-Vorfall');
  const incidentId=String(incident.id);
  const alarm=await createAlarm('RBAC-Alarm');
  const alarmId=String(alarm.id);

  await expectStatus(await viewer.context.get('/api/v1/einsatz/incidents',{
    headers:viewer.headers,params:{q:runId,page:1,page_size:25},
  }),200,'Viewer Vorfallliste');
  await expectStatus(await viewer.context.get('/api/v1/einsatz/alarms',{
    headers:viewer.headers,params:{q:runId,page:1,page_size:25},
  }),200,'Viewer AlarmListe');
  await errorJson(await viewer.context.post('/api/v1/einsatz/incidents',{headers:viewer.headers,data:{
    incident_type_code:'technical_fault',priority_id:fixture.criticalPriorityId,
    description:`E2E Viewer Vorfall ${runId}`,site_id:siteId,source_key:`e2e-viewer-incident-${runId}`,
  }}),403,'Viewer Vorfall anlegen');
  await errorJson(await viewer.context.post(`/api/v1/einsatz/incidents/${incidentId}/status`,{
    headers:viewer.headers,data:{status:'en_route',reason:administrativeReason},
  }),403,'Viewer Vorfallstatus ändern');
  await errorJson(await viewer.context.post('/api/v1/einsatz/alarms',{headers:viewer.headers,data:{
    priority_code:'critical',description:`E2E Viewer Alarm ${runId}`,site_id:siteId,
    source_key:`e2e-viewer-alarm-${runId}`,
  }}),403,'Viewer Alarm anlegen');
  await errorJson(await viewer.context.post(`/api/v1/einsatz/alarms/${alarmId}/acknowledge`,{
    headers:viewer.headers,
  }),403,'Viewer Alarm quittieren');
  if(capabilities.rules){
    const rules=await readJson(await admin.context.get('/api/v1/einsatz/escalation-rules',{
      headers:admin.headers,
    }),'Eskalationsregeln für RBAC');
    if(rules.length>0){
      await errorJson(await viewer.context.patch(`/api/v1/einsatz/escalation-rules/${rules[0].id}`,{
        headers:viewer.headers,data:{enabled:false,reason:administrativeReason},
      }),403,'Viewer Eskalationsregel ändern');
    }
  }

  await errorJson(await foreign.context.get(`/api/v1/einsatz/incidents/${incidentId}`,{
    headers:foreign.headers,
  }),404,'Fremdmandant Vorfalldetail');
  await errorJson(await foreign.context.get(`/api/v1/einsatz/alarms/${alarmId}/history`,{
    headers:foreign.headers,
  }),404,'Fremdmandant Alarmhistorie');
  expect(await readJson(await foreign.context.get('/api/v1/einsatz/incidents',{
    headers:foreign.headers,params:{q:runId,site_id:siteId,page:1,page_size:25},
  }),'Fremdmandant Vorfallliste')).toEqual([]);
});

test('UI zeigt echte Vorfälle und die vollständige Vorfallakte',async({page}:{page:Page})=>{
  test.skip(!capabilities.incidents,'SKIP: Vorfall-API fehlt in /api/openapi.json');
  const incident=await createIncident('UI-Vorfall');
  const description=`E2E UI-Vorfall ${runId}`;

  await loginUi(page,email,password);
  await page.goto('/einsatz');
  await expect(page.getByRole('heading',{level:2,name:'Einsatzmanagement'})).toBeVisible();
  const nav=page.locator('[aria-label="Bereiche des Einsatzmanagements"]');
  for(const tab of ['Übersicht','Vorfälle','Alarme','Maßnahmen','Eskalationen','Auswertungen']){
    await expect(nav.getByRole('button',{name:tab})).toBeVisible();
  }
  await expect(page.getByRole('button',{name:'Vorfall erfassen'})).toBeVisible();

  await nav.getByRole('button',{name:'Vorfälle'}).click();
  const form=page.locator('form[aria-label="Einsatzdaten filtern"]');
  await expect(form).toBeVisible();
  await form.getByLabel('Suche').fill(runId);
  await form.getByRole('button',{name:'Filter anwenden'}).click();
  const row=page.getByRole('row').filter({hasText:description});
  await expect(row).toBeVisible();
  await row.getByRole('link',{name:'Details'}).click();
  await expect(page).toHaveURL(new RegExp(`/einsatz/vorfaelle/${String(incident.id)}$`));
  await expect(page.getByRole('heading').filter({hasText:String(incident.incident_number)})).toBeVisible();
  for(const section of ['Vorfalldaten','Status und Abschlussbedingungen','Bearbeitungsverlauf',
    'Benachrichtigungsstellungen','Beteiligte','Anhänge und Nachweise','Maßnahmen','Bericht','Eskalationen']){
    await expect(page.getByRole('heading',{name:section})).toBeVisible();
  }
  for(const button of ['Zuordnung speichern','Dokument verknüpfen','Bericht speichern','Eskalation auslösen']){
    await expect(page.getByRole('button',{name:button})).toBeVisible();
  }
});
