import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import {
  apiBase,berlinDate,createIsolatedSite,decommissionSite,email,errorJson,
  fixture,hasPath,isoIn,loginApi,loginUi,openApiPaths,password,permissionList,readJson,
  type Row,type Session,
} from './helpers/operative-e2e';

/**
 * Operative Leitstelle: Die Aggregation wird ausschließlich über den autorisierten
 * Serverendpunkt geprüft; Maßnahmen werden über echte APIs angelegt und bearbeitet.
 * Alle Schreibzugriffe laufen gegen den isolierten Fixture-Tenant. Ein Abschluss
 * bleibt gesperrt, solange die verknüpfte Alarmursache fortbesteht.
 */
test.skip(process.env.E2E_FIXTURE!=='isolated',
  'Nur gegen den isolierten Fixture-Tenant ausführen (E2E_FIXTURE=isolated).');
test.skip(!email||!password,'Set E2E_EMAIL and E2E_PASSWORD to run the Leitstelle E2E tests.');

const runId=`${Date.now().toString(36)}${randomUUID().slice(0,6)}`;
const administrativeReason=`E2E Leitstelle ${runId}`;

let admin:Session;
let operator:Session;
let viewer:Session;
let foreign:Session;
let siteId='';
const measureIds:string[]=[];
const alarmIds:string[]=[];
const capabilities={
  controlCenter:false,
  candidates:false,
  measuresRead:false,
  measuresWrite:false,
  einsatzAlarms:false,
};

function measurePayload(title:string,overrides:Row={}):Row{
  return {
    title,description:`E2E Leitstellenmaßnahme ${runId}`,module:'leitstelle',priority:'high',
    status:'open',site_id:siteId,assigned_employee_id:fixture.employeeId,
    due_at:isoIn(1),reason:administrativeReason,...overrides,
  };
}

test.beforeAll(async({request,playwright})=>{
  const ready=await request.get(`${apiBase}/ready`);
  expect(ready.ok(),`Backend ${apiBase}/ready nicht bereit: HTTP ${ready.status()}`).toBeTruthy();
  const paths=await openApiPaths(request);
  capabilities.controlCenter=hasPath(paths,'/operations/control-center','get');
  capabilities.candidates=hasPath(paths,'/operations/control-center/candidates','get');
  capabilities.measuresRead=hasPath(paths,'/operations/measures','get');
  capabilities.measuresWrite=hasPath(paths,'/operations/measures','post')
    &&hasPath(paths,'/operations/measures/{id}','patch');
  capabilities.einsatzAlarms=hasPath(paths,'/einsatz/alarms','post')
    &&hasPath(paths,'/einsatz/alarms/{id}/acknowledge','post')
    &&hasPath(paths,'/einsatz/alarms/{id}/resolve','post');

  admin=await loginApi(playwright,process.env.E2E_ADMIN_EMAIL??'e2e-qm-admin@example.invalid',
    process.env.E2E_ADMIN_PASSWORD??password,'playwright-leitstelle-admin');
  operator=await loginApi(playwright,email,password,'playwright-leitstelle-operator');
  viewer=await loginApi(playwright,process.env.E2E_VIEWER_EMAIL??'e2e-viewer@example.invalid',
    password,'playwright-leitstelle-viewer');
  foreign=await loginApi(playwright,process.env.E2E_FOREIGN_EMAIL??'admin@example.com',
    process.env.E2E_FOREIGN_PASSWORD??'password','playwright-leitstelle-foreign');

  expect(admin.tenantId,`Admin-Mandant entspricht nicht dem Fixture-Tenant: ${admin.tenantId}`).toBe(fixture.tenantId);
  expect(operator.tenantId).toBe(fixture.tenantId);
  expect(viewer.tenantId).toBe(fixture.tenantId);
  expect(foreign.tenantId).not.toBe(fixture.tenantId);
  expect(permissionList(admin)).toEqual(expect.arrayContaining(['nsl:read','operations_measures:read','operations_measures:write']));
  expect(permissionList(operator)).toEqual(expect.arrayContaining(['nsl:read','operations_measures:read','operations_measures:write']));
  expect(permissionList(viewer)).toEqual(expect.arrayContaining(['nsl:read','operations_measures:read']));
  expect(permissionList(viewer)).not.toContain('operations_measures:write');

  siteId=await createIsolatedSite(admin,'Leitstelle',runId);
});

test.afterAll(async()=>{
  if(admin){
    for(const id of [...measureIds].reverse()){
      const response=await admin.context.patch(`/api/v1/operations/measures/${id}`,{
        headers:admin.headers,data:{status:'cancelled',reason:`Cleanup ${administrativeReason}`},
      });
      if(![200,404].includes(response.status()))console.warn(`Cleanup Maßnahme ${id}: HTTP ${response.status()}`);
    }
    for(const id of [...alarmIds].reverse()){
      const acknowledged=await admin.context.post(`/api/v1/einsatz/alarms/${id}/acknowledge`,{headers:admin.headers});
      if(![200,409,404].includes(acknowledged.status()))console.warn(`Cleanup Alarm ${id} acknowledge: HTTP ${acknowledged.status()}`);
      const resolved=await admin.context.post(`/api/v1/einsatz/alarms/${id}/resolve`,{
        headers:admin.headers,data:{reason:`Cleanup ${administrativeReason}`},
      });
      if(![200,409,404].includes(resolved.status()))console.warn(`Cleanup Alarm ${id} resolve: HTTP ${resolved.status()}`);
    }
    if(siteId)await decommissionSite(admin,siteId,`Leitstelle ${runId}`);
  }
  for(const session of [admin,operator,viewer,foreign])await session?.context.dispose();
});

test('Leitstelle liefert autorisierte Aggregation aus echten Fachdaten',async()=>{
  test.skip(!capabilities.controlCenter,'SKIP: /operations/control-center fehlt in /api/openapi.json');
  const response=await operator.context.get('/api/v1/operations/control-center',{headers:operator.headers,params:{
    date:berlinDate(),site_id:siteId,page:1,page_size:10,
  }});
  const body=await readJson(response,'Operative Leitstelle');
  for(const key of ['sections','kpis','alerts','shifts','employees','sites','qualifications','documents',
    'document_requirements','devices','keys','alarms','hazards','measures','summary','filter_options']){
    expect(body[key],`Aggregationsschlüssel ${key} fehlt`).toBeDefined();
  }
  expect(Array.isArray(body.kpis)).toBeTruthy();
  expect(body.kpis.length).toBeGreaterThan(0);
  expect(body.kpis.every((kpi:Row)=>typeof kpi.key==='string'&&typeof kpi.value==='number')).toBeTruthy();
  expect(body.date).toBe(berlinDate());
  expect(typeof body.summary.measures_open).toBe('number');
  expect(typeof body.summary.measures_overdue).toBe('number');
  expect(body.summary.measures_open).toBeGreaterThanOrEqual(0);
  for(const row of (body.sites as Row[])){
    expect(row.site_id??row.id).toBeTruthy();
  }
  const foreignResponse=await foreign.context.get('/api/v1/operations/control-center',{
    headers:foreign.headers,params:{date:berlinDate(),site_id:siteId,page:1,page_size:10},
  });
  const foreignBody=await readJson(foreignResponse,'Fremdmandant Leitstelle');
  expect((foreignBody.filter_options as Row).sites).toEqual([]);
});

test('Kandidatenermittlung nutzt die verbindliche Einsatzprüfung',async()=>{
  test.skip(!capabilities.candidates,'SKIP: /operations/control-center/candidates fehlt in /api/openapi.json');
  const response=await operator.context.get('/api/v1/operations/control-center/candidates',{
    headers:operator.headers,params:{shift_id:randomUUID()},
  });
  await errorJson(response,404,'Unbekannte Schicht');
});

test('Maßnahmen werden idempotent angelegt, gefiltert und revisionssicher bearbeitet',async()=>{
  test.skip(!capabilities.measuresRead||!capabilities.measuresWrite,
    'SKIP: /operations/measures Lese-/Schreib-API fehlt in /api/openapi.json');
  const title=`Leitstellenmaßnahme ${runId}`;
  const sourceKey=`e2e-lst-manual-${runId}`;
  const payload=measurePayload(title,{source_key:sourceKey,client_mutation_id:randomUUID()});
  const created=await operator.context.post('/api/v1/operations/measures',{
    headers:operator.headers,data:payload,
  });
  const row=await readJson(created,'Maßnahme anlegen');
  expect(created.status()).toBe(201);
  const measureId=String(row.id);
  measureIds.push(measureId);

  const replay=await operator.context.post('/api/v1/operations/measures',{
    headers:operator.headers,data:payload,
  });
  const replayed=await readJson(replay,'Idempotente Maßnahmenwiedergabe');
  expect(replay.status()).toBe(200);
  expect(String(replayed.id)).toBe(measureId);

  const list=await operator.context.get('/api/v1/operations/measures',{headers:operator.headers,params:{
    q:runId,status:'open',module:'leitstelle',site_id:siteId,page:1,page_size:25,
  }});
  const rows=await readJson(list,'Maßnahmenliste');
  expect(rows.some((item:Row)=>String(item.id)===measureId)).toBeTruthy();
  expect(Number(list.headers()['x-total-count'])).toBeGreaterThanOrEqual(1);
  expect(Number(list.headers()['x-page-count'])).toBeGreaterThanOrEqual(1);

  const patched=await operator.context.patch(`/api/v1/operations/measures/${measureId}`,{
    headers:operator.headers,data:{status:'in_progress',reason:`E2E Status ${runId}`},
  });
  const patchedRow=await readJson(patched,'Maßnahmenstatus ändern');
  expect(patchedRow.status).toBe('in_progress');

  await errorJson(await operator.context.patch('/api/v1/operations/measures/not-a-uuid',{
    headers:operator.headers,data:{status:'in_progress'},
  }),400,'Ungültige Maßnahmen-ID');
  await errorJson(await operator.context.patch(`/api/v1/operations/measures/${measureId}`,{
    headers:operator.headers,data:{reason:'nur Begründung'},
  }),400,'Maßnahme ohne Änderung');

  await errorJson(await viewer.context.post('/api/v1/operations/measures',{
    headers:viewer.headers,data:measurePayload(`Viewer Maßnahme ${runId}`,{source_key:`e2e-viewer-${runId}`}),
  }),403,'Viewer-Schreibzugriff Maßnahme');
  await errorJson(await operator.context.post('/api/v1/operations/measures',{
    data:measurePayload(`CSRF Maßnahme ${runId}`,{source_key:`e2e-csrf-${runId}`}),
  }),403,'Maßnahme ohne CSRF-Token');

  const foreignList=await foreign.context.get('/api/v1/operations/measures',{
    headers:foreign.headers,params:{q:runId,page:1,page_size:25},
  });
  expect(await readJson(foreignList,'Fremdmandant Maßnahmenliste')).toEqual([]);
  expect(foreignList.headers()['x-total-count']).toBe('0');
  await errorJson(await foreign.context.patch(`/api/v1/operations/measures/${measureId}`,{
    headers:foreign.headers,data:{status:'done'},
  }),404,'Fremdmandant Maßnahme ändern');
});

test('Abschluss bleibt bei fortbestehender Alarmursache gesperrt',async()=>{
  test.skip(!capabilities.measuresWrite||!capabilities.einsatzAlarms,
    'SKIP: Maßnahmen- oder Alarm-API fehlt in /api/openapi.json');
  const alarm=await admin.context.post('/api/v1/einsatz/alarms',{headers:admin.headers,data:{
    type:'alarm',priority_code:'critical',source:'playwright-leitstelle',
    description:`E2E Leitstellen-Alarm ${runId}`,site_id:siteId,
    source_key:`e2e-lst-alarm-${runId}`,client_mutation_id:randomUUID(),reason:administrativeReason,
  }});
  const alarmRow=await readJson(alarm,'E2E Alarm anlegen');
  expect(alarm.status()).toBe(201);
  const alarmId=String(alarmRow.id);
  alarmIds.push(alarmId);

  const measure=await admin.context.post('/api/v1/operations/measures',{headers:admin.headers,data:
    measurePayload(`Quellenmaßnahme ${runId}`,{
      source_key:`e2e-lst-source-${runId}`,source_type:'alarm',source_id:alarmId,
    })});
  const measureRow=await readJson(measure,'Quellenmaßnahme anlegen');
  expect(measure.status()).toBe(201);
  const measureId=String(measureRow.id);
  measureIds.push(measureId);

  const blocked=await admin.context.patch(`/api/v1/operations/measures/${measureId}`,{
    headers:admin.headers,data:{status:'done',reason:`E2E Abschluss ${runId}`},
  });
  const blockedBody=await errorJson(blocked,409,'Abschluss bei offener Ursache');
  expect(blockedBody.reason_code).toBe('source_open');
  expect(blockedBody.error).toContain('Die Ursache der Maßnahme besteht weiterhin');

  const acknowledged=await admin.context.post(`/api/v1/einsatz/alarms/${alarmId}/acknowledge`,{headers:admin.headers});
  const acknowledgedRow=await readJson(acknowledged,'Alarm quittieren');
  expect(acknowledgedRow.status).toBe('acknowledged');
  const history=await readJson(await admin.context.get(`/api/v1/einsatz/alarms/${alarmId}/history`,{
    headers:admin.headers,
  }),'Alarmhistorie');
  expect(history.some((entry:Row)=>String(entry.note).includes('Bestätigung beseitigt die Ursache nicht'))).toBeTruthy();

  await errorJson(await admin.context.patch(`/api/v1/operations/measures/${measureId}`,{
    headers:admin.headers,data:{status:'done',reason:`E2E Abschluss ${runId}`},
  }),409,'Abschluss nach Quittierung');

  const resolved=await admin.context.post(`/api/v1/einsatz/alarms/${alarmId}/resolve`,{
    headers:admin.headers,data:{reason:`E2E Alarm gelöst ${runId}`},
  });
  const resolvedRow=await readJson(resolved,'Alarm auflösen');
  expect(resolvedRow.status).toBe('resolved');
  const closed=await admin.context.patch(`/api/v1/operations/measures/${measureId}`,{
    headers:admin.headers,data:{status:'done',reason:`E2E Abschluss ${runId}`},
  });
  expect((await readJson(closed,'Maßnahme nach Ursachenbeseitigung abschließen')).status).toBe('done');
});

test('UI zeigt echte Maßnahmen aus dem Backend und erlaubt Statuswechsel',async({page}:{page:Page})=>{
  test.skip(!capabilities.measuresRead||!capabilities.measuresWrite,
    'SKIP: /operations/measures Lese-/Schreib-API fehlt in /api/openapi.json');
  const title=`UI Maßnahme ${runId}`;
  const created=await operator.context.post('/api/v1/operations/measures',{
    headers:operator.headers,data:measurePayload(title,{source_key:`e2e-lst-ui-${runId}`}),
  });
  const createdRow=await readJson(created,'UI Maßnahme anlegen');
  measureIds.push(String(createdRow.id));

  await loginUi(page,email,password);
  await page.goto('/operative-leitstelle');
  await expect(page.getByRole('heading',{level:2,name:'Operative Leitstelle'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Operative Leitstelle'})).toBeVisible();
  const form=page.locator('form[aria-label="Leitstelle filtern"]');
  await expect(form).toBeVisible();
  const filterFields=['Datum','Objekt','Kunde','Mitarbeiter','Suche','Maßnahmen-Modul','Maßnahmenstatus',
    'Nur überfällige Maßnahmen','Einträge pro Seite'];
  await expect(form.locator('label')).toHaveCount(filterFields.length);
  for(const [index,label] of filterFields.entries()){
    await expect(form.locator('label').nth(index),`Filterfeld ${label} fehlt`).toBeVisible();
  }
  await expect(form.getByRole('button',{name:'Filter anwenden'})).toBeVisible();
  await expect(form.getByRole('button',{name:'Zurücksetzen'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Aktualisieren'})).toBeVisible();
  for(const section of ['Kennzahlen','Sofortiger Handlungsbedarf','Tagesübersicht Schichten','Verfügbarkeit',
    'Objektstatus','Qualifikationen und Nachweise','NFC- und Schlüsselstatus','Offene Maßnahmen']){
    await expect(page.getByRole('heading',{name:section})).toBeVisible();
  }

  await form.locator('input[type="search"]').fill(runId);
  await form.getByRole('button',{name:'Filter anwenden'}).click();
  const row=page.getByRole('row').filter({hasText:title});
  await expect(row).toBeVisible();
  await row.getByRole('button',{name:'In Bearbeitung'}).click();
  const dialog=page.getByRole('dialog',{name:`Status ändern: ${title}`});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Begründung').fill(`E2E UI Status ${runId}`);
  await dialog.getByRole('button',{name:'Status speichern'}).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByText('In Bearbeitung')).toBeVisible();
});

test('operative views remain usable at narrow viewport widths',async({page}:{page:Page})=>{
  await loginUi(page,email,password);
  for(const viewport of [{width:390,height:844},{width:768,height:1024}]){
    await page.setViewportSize(viewport);
    for(const [path,heading] of [['/operative-leitstelle','Operative Leitstelle'],['/einsatz','Einsatzmanagement']]){
      await page.goto(path);
      await expect(page.getByRole('heading',{level:2,name:heading})).toBeVisible();
      const dimensions=await page.evaluate(()=>({
        width:window.innerWidth,
        scrollWidth:document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth,`Horizontaler Überlauf bei ${viewport.width}px auf ${path}`)
        .toBeLessThanOrEqual(dimensions.width+1);
    }
  }
});
