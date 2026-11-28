import {randomUUID} from 'node:crypto';
import {expect,test,type APIRequestContext} from '@playwright/test';
import {
  adminEmail,adminPassword,createIsolatedSite,decommissionSite,email,errorJson,
  expectStatus,fixture,loginApi,loginUi,password,readJson,viewerEmail,
  type Session,
} from './helpers/operative-e2e';

/**
 * E2E-Abdeckung des professionellen Dokumentenmanagements.
 *
 * Alle schreibenden Zugriffe laufen gegen ein eigens für diesen Lauf angelegtes
 * Isolationsobjekt. Es werden keine produktiven Dokumente verändert. Der
 * Operator lädt hoch und gibt zur Prüfung frei, der Administrator freigibt,
 * der Viewer darf nur lesen und herunterladen.
 */
test.skip(!email||!password,'Set E2E_EMAIL and E2E_PASSWORD to run the DMS E2E tests.');

type Row=Record<string,any>;

const runId=`${Date.now().toString(36)}${randomUUID().slice(0,6)}`;
const title=`E2E DMSFreigabe ${runId}`;
const cleanContent=`DMS-E2E-Testinhalt ${runId}\nKeine personenbezogenen Daten.\n`;
const base64=Buffer.from(cleanContent,'utf8').toString('base64');

let operator:Session;
let admin:Session;
let viewer:Session;
let siteId:string|undefined;
let documentId:string|undefined;
const mutationIds:string[]=[];

async function post(session:Session,path:string,data:unknown,expected:number):Promise<Row>{
  const response=await session.context.post(path,{headers:session.headers,data});
  return readJson(response,`POST ${path}`).then(body=>{
    expect(response.status(),`POST ${path}: ${JSON.stringify(body)}`).toBe(expected);
    return body;
  });
}

async function send(session:Session,path:string,data:unknown,expected:number):Promise<Row>{
  const response=await session.context.post(path,{headers:session.headers,data});
  if(expected>=400)return errorJson(response,expected,`POST ${path}`);
  return readJson(response,`POST ${path}`);
}

async function uploadBody(overrides:Row={}):Promise<Row>{
  const mutationId=randomUUID();mutationIds.push(mutationId);
  return {
    title,description:'Isolierter E2E-Test des Freigabeworkflows.',site_id:siteId,
    document_number:`E2E-DMS-${runId}`,document_type:'E2E-Test',
    content_type:'text/plain',content_base64:base64,client_mutation_id:mutationId,
    ...overrides,
  };
}

async function queryDocuments(session:Session,query:Row):Promise<Row>{
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(query))params.set(key,String(value));
  const response=await session.context.get(`/api/v1/dms/documents/query?${params.toString()}`,{headers:session.headers});
  return readJson(response,'DMS-Abfrage');
}

test.beforeAll(async ({playwright})=>{
  operator=await loginApi(playwright,email,password,'dms-e2e-operator');
  admin=await loginApi(playwright,adminEmail,adminPassword,'dms-e2e-admin');
  viewer=await loginApi(playwright,viewerEmail,password,'dms-e2e-viewer');
  siteId=await createIsolatedSite(operator,'DMS',runId);
});

test.afterAll(async ()=>{
  if(documentId&&admin){
    const response=await admin.context.delete(`/api/v1/dms/documents/${documentId}`,{
      headers:admin.headers,data:{reason:`E2E ${runId} aufgeräumt`},
    });
    if(![200,404,409].includes(response.status()))console.warn(`Cleanup DMS-Dokument: HTTP ${response.status()}`);
  }
  if(siteId&&operator)await decommissionSite(operator,siteId,`DMS ${runId}`);
});

test('Dokumente zuverlässig hochladen, freigeben, versionieren und löschen',async ()=>{
  const initialBody=await uploadBody();
  const initial=await post(operator,'/api/v1/dms/documents',initialBody,201);
  documentId=String(initial.document.id);
  expect(initial.version.lifecycle_state).toBe('available');
  expect(initial.document.approval_status).toBe('draft');

  const replayBody=await uploadBody();
  // Die Wiederholung verwendet bewusst dieselbe Mutations-ID wie der erste Upload.
  replayBody.client_mutation_id=mutationIds[0];
  const replay=await post(operator,'/api/v1/dms/documents',replayBody,200);
  expect(replay.document.id).toBe(documentId);
  const listed=await queryDocuments(operator,{site_id:siteId,q:title});
  expect(listed.total).toBe(1);

  await send(operator,'/api/v1/dms/documents',{...replayBody,title:`${title} verändert`},409);

  const beforeApproval=await operator.context.get(
    `/api/v1/dms/documents/${documentId}/versions/${initial.version.id}/download`,{headers:operator.headers},
  );
  expect([403,409]).toContain(beforeApproval.status());

  await post(operator,`/api/v1/dms/documents/${documentId}/request-review`,{},200);
  const approved=await post(admin,`/api/v1/dms/documents/${documentId}/approve`,{feedback:`E2E ${runId}`},200);
  expect(approved.approval_status).toBe('approved');

  const download=await viewer.context.get(
    `/api/v1/dms/documents/${documentId}/versions/${initial.version.id}/download`,{headers:viewer.headers},
  );
  await expectStatus(download,200,'Viewer-Download nach Freigabe');
  expect(await download.text()).toBe(cleanContent);

  const version=await post(operator,`/api/v1/dms/documents/${documentId}/versions`,{
    content_base64:base64,content_type:'text/plain',client_mutation_id:randomUUID(),
  },201);
  expect(version.version_no).toBe(2);
  expect(version.approval_invalidated).toBe(true);

  const filtered=await queryDocuments(operator,{
    site_id:siteId,q:title,approval_status:'pending_approval',scan_status:'available',
    sort:'valid_until',order:'desc',page:1,page_size:10,
  });
  expect(filtered.total).toBe(1);
  expect(filtered.rows[0].id).toBe(documentId);
  expect(filtered.rows[0].approval_status).toBe('pending_approval');
  expect(filtered.stats.pending_approval).toBeGreaterThan(0);
  expect(filtered.filter_options.sites.some((site:Row)=>site.id===siteId)).toBe(true);

  const overview=await operator.context.get('/api/v1/dms/overview',{headers:operator.headers});
  const overviewBody=await readJson(overview,'DMS-Übersicht');
  expect(overviewBody.stats.pending_approval).toBeGreaterThan(0);
  expect(overviewBody.approvals.some((row:Row)=>row.id===documentId)).toBe(true);

  await post(operator,`/api/v1/dms/documents/${documentId}/archive`,{},200);
  await post(operator,`/api/v1/dms/documents/${documentId}/restore`,{},200);

  const history=await operator.context.get(`/api/v1/dms/documents/${documentId}/history`,{headers:operator.headers});
  const events=await readJson(history,'DMS-Historie');
  const eventTypes=events.map((row:Row)=>String(row.event_type));
  for(const event of [
    'dms.document.uploaded','dms.document.approved','dms.document.approval_invalidated',
    'dms.document.archived','dms.document.restored',
  ])expect(eventTypes).toContain(event);

  const deleted=await admin.context.delete(`/api/v1/dms/documents/${documentId}`,{
    headers:admin.headers,data:{reason:`E2E ${runId} Remove-Test`},
  });
  await expectStatus(deleted,200,'Dokument löschen');
  const afterDelete=await queryDocuments(operator,{site_id:siteId,q:title});
  expect(afterDelete.total).toBe(0);
  documentId=undefined;
});

test('DMS-Oberfläche zeigt Kennzahlen, Filter und Freigaben ohne Browserfehler',async ({page})=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await loginUi(page,email,password);
  await page.goto('/dms');
  await expect(page.getByRole('heading',{name:'Dokumentenmanagement'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Nach Gesamt filtern'})).toBeVisible();
  await expect(page.getByRole('table',{name:'Gefilterte Dokumente'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Offene Freigaben'})).toBeVisible();
  await page.getByLabel('Freigabestatus').selectOption('approved');
  await page.getByRole('button',{name:'Filter anwenden'}).click();
  await expect(page.getByLabel('Freigabestatus')).toHaveValue('approved');
  expect(errors,`Browserfehler auf der DMS-Seite: ${errors.join(' | ')}`).toEqual([]);
});
