import {randomUUID} from 'node:crypto';
import {expect,test,type APIRequestContext,type Page} from '@playwright/test';

/**
 * E2E-Abdeckung der Qualifikationsverwaltung.
 *
 * Schreibende Zugriffe laufen gegen den isolierten Fixture-Tenant und den
 * Fixture-Mitarbeiter aus backend/src/e2e-fixture.ts. Da der Fixture-Operator
 * keine Katalog-, Schreib- oder Erinnerungsrechte besitzt, stellt genau dieser
 * Fixture einen Admin im selben Tenant bereit (ohne `account_security:manage`
 * über die API zu benötigen). Es werden ausschließlich Datensätze dieser Spec
 * verändert.
 */
const email=process.env.E2E_EMAIL??'e2e-scale-20261126@example.invalid';
const password=process.env.E2E_PASSWORD??'local-e2e-password-20261126';
const authorEmail=process.env.E2E_AUTHOR_EMAIL??'e2e-author@example.invalid';
const viewerEmail=process.env.E2E_VIEWER_EMAIL??'e2e-viewer@example.invalid';
const runId=`${Date.now().toString(36)}${randomUUID().slice(0,6)}`;
const adminEmail=process.env.E2E_ADMIN_EMAIL??'e2e-qm-admin@example.invalid';
const adminPassword=process.env.E2E_ADMIN_PASSWORD??password;
/** Dokumentierter lokaler Seed für den Mandantenwechsel-Test (nur lesend). */
const foreignEmail=process.env.E2E_FOREIGN_EMAIL??'admin@example.com';
const foreignPassword=process.env.E2E_FOREIGN_PASSWORD??'password';
const apiBase=process.env.E2E_API_BASE_URL??'http://localhost:3000';
const siteId=process.env.E2E_SITE_ID??'00000000-0000-4000-8000-000000000103';
const employeeId=process.env.E2E_EMPLOYEE_ID??'00000000-0000-4000-8000-000000000104';
const ruleProfileId=process.env.E2E_RULE_PROFILE_ID??'00000000-0000-4000-8000-000000000116';
const cleanupReason=`E2E Qualifikationsverwaltung ${runId} aufgeräumt`;

test.skip(!email||!password,'Set E2E_EMAIL and E2E_PASSWORD to run the qualification-management E2E tests.');

type Session={context:APIRequestContext;headers:Record<string,string>};
type Catalog={id:string;code:string;name:string;default_validity_days:number|null;active:boolean};

let operator:Session;
let admin:Session; // Admin aus dem isolierten Fixture-Tenant, nur für Setup/Aufräumen
let author:Session;
let viewer:Session;
let foreign:Session;
let permissions:string[]=[];
let remindersBefore:number[]|undefined;

const createdCatalog:{id:string;session:Session}[]=[];
const createdAssignmentIds:string[]=[];
const createdRequirements:{id:string;siteId:string}[]=[];

function dateIn(days:number):string{
  const now=new Date();
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const [year,month,day]=today.split('-').map(Number);
  return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10);
}

function berlinDate(value:unknown):string{
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value.trim()))return value.trim();
  const date=new Date(String(value));
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}

function isoIn(days:number,hour=0):string{
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  date.setUTCHours(hour,0,0,0);
  return date.toISOString();
}

function uniqueCode(label:string):string{
  return `e2e_${label}_${runId}`.replace(/[^a-z0-9_-]/g,'_').slice(0,80);
}

async function loginApi(playwright:{request:{newContext(options?:{baseURL?:string}):Promise<APIRequestContext>}},userEmail:string,userPassword:string):Promise<Session>{
  const context=await playwright.request.newContext({baseURL:process.env.E2E_BASE_URL??'http://localhost:5173'});
  const response=await context.post('/api/v1/auth/login',{data:{
    email:userEmail,password:userPassword,device_id:randomUUID(),
    metadata:{platform:'playwright-qualification-e2e',app_version:'e2e'},
  }});
  expect(response.status(),`Login ${userEmail}: HTTP ${response.status()} ${await response.text()}`).toBe(200);
  const token=(await context.cookies()).find(cookie=>cookie.name==='securityops_csrf')?.value;
  if(!token)throw new Error(`Kein CSRF-Cookie für ${userEmail} erhalten.`);
  return {context,headers:{'x-csrf-token':decodeURIComponent(token)}};
}

async function login(page:Page):Promise<void>{
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await expect(page).toHaveURL(/\/$/);
}

test.beforeAll(async({request,playwright})=>{
  const ready=await request.get(`${apiBase}/ready`);
  expect(ready.ok(),`Qualifikations-E2E: Backend ${apiBase}/ready ist nicht bereit (${ready.status()}).`).toBeTruthy();

  // Der Operator darf keine Konten verwalten; der isolierte Fixture-Tenant
  // enthält deshalb bereits einen Admin mit den benötigten Schreibrechten.
  operator=await loginApi(playwright,email,password);
  admin=await loginApi(playwright,adminEmail,adminPassword);

  author=await loginApi(playwright,authorEmail,password);
  viewer=await loginApi(playwright,viewerEmail,password);
  foreign=await loginApi(playwright,foreignEmail,foreignPassword);
  const me=await operator.context.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);
  permissions=((await me.json()).user?.permissions??[]) as string[];
  const reminders=await admin.context.get('/api/v1/qualifications/reminders');
  expect(reminders.status()).toBe(200);
  remindersBefore=((await reminders.json()).reminder_days as number[]|undefined);
});

test.afterAll(async()=>{
  if(admin){
    for(const requirement of [...createdRequirements].reverse()){
      const response=await admin.context.delete(`/api/v1/sites/${requirement.siteId}/qualification-requirements/${requirement.id}`,{
        headers:admin.headers,data:{reason:cleanupReason},
      });
      if(![200,204,404].includes(response.status()))console.warn(`Cleanup Anforderung ${requirement.id}: HTTP ${response.status()}`);
    }
    for(const id of [...createdAssignmentIds].reverse()){
      const response=await admin.context.delete(`/api/v1/employees/${employeeId}/qualifications/${id}`,{
        headers:admin.headers,data:{reason:cleanupReason},
      });
      // 409 ist erwartet, wenn der Datensatz bewusst als Historie widerrufen wurde.
      if(![200,204,404,409].includes(response.status()))console.warn(`Cleanup Qualifikation ${id}: HTTP ${response.status()}`);
    }
    for(const {id,session} of [...createdCatalog].reverse()){
      const response=await session.context.patch(`/api/v1/qualifications/catalog/${id}`,{
        headers:session.headers,data:{active:false,name:`E2E-CLEANUP ${runId} ${id}`,reason:cleanupReason},
      });
      if(response.status()!==200)console.warn(`Cleanup Katalog ${id}: HTTP ${response.status()}`);
    }
    if(remindersBefore){
      const response=await admin.context.put('/api/v1/qualifications/reminders',{
        headers:admin.headers,data:{reminder_days:remindersBefore,reason:cleanupReason},
      });
      if(response.status()!==200)console.warn(`Cleanup Erinnerungstage: HTTP ${response.status()}`);
    }
  }
  for(const session of [operator,admin,author,viewer,foreign])await session?.context.dispose();
});

async function createCatalog(session:Session,label:string,overrides:Record<string,unknown>={}):Promise<{catalog:Catalog;payload:Record<string,unknown>}>{
  const payload:Record<string,unknown>={
    code:uniqueCode(label),name:`E2E ${label} ${runId}`,
    description:`Isolierter E2E-Katalogeintrag ${runId}`,category:'Interne Schulungen',
    default_validity_days:365,required:true,required_document_type:'qualification',
    required_documents:['Qualifikationsnachweis'],active:true,reason:`E2E Katalog ${label} ${runId} angelegt`,
    ...overrides,
  };
  const response=await session.context.post('/api/v1/qualifications/catalog',{headers:session.headers,data:payload});
  expect(response.status(),`Katalog ${label}: HTTP ${response.status()} ${await response.text()}`).toBe(201);
  const catalog=(await response.json()) as Catalog;
  createdCatalog.push({id:catalog.id,session});
  expect(catalog).toMatchObject({code:payload.code,name:payload.name,active:true});
  return {catalog,payload};
}

async function expectCatalogWriteDenied(session:Session,body:Record<string,unknown>,label:string):Promise<void>{
  const response=await session.context.post('/api/v1/qualifications/catalog',{headers:session.headers,data:body});
  expect(response.status(),`${label}: ohne qualifications:catalog:write muss 403 kommen.`).toBe(403);
  expect(permissions).not.toContain('qualifications:catalog:write');
}

async function assignQualification(catalog:Catalog,overrides:Record<string,unknown>={}):Promise<Record<string,any>>{
  const payload={catalog_id:catalog.id,code:catalog.code,valid_from:dateIn(0),reason:`E2E Zuordnung ${catalog.code}`,...overrides};
  const response=await admin.context.post(`/api/v1/employees/${employeeId}/qualifications`,{headers:admin.headers,data:payload});
  expect(response.status(),`Zuordnung ${catalog.code}: HTTP ${response.status()} ${await response.text()}`).toBe(201);
  const row=(await response.json()) as Record<string,any>;
  createdAssignmentIds.push(row.id);
  return row;
}

async function getAssignment(id:string):Promise<Record<string,any>>{
  const response=await operator.context.get(`/api/v1/qualifications/assignments/${id}`);
  expect(response.status(),`Detail ${id}: HTTP ${response.status()} ${await response.text()}`).toBe(200);
  return (await response.json()) as Record<string,any>;
}

async function overview(params:Record<string,string|number>):Promise<{response:import('@playwright/test').APIResponse;rows:Record<string,any>[]}>{
  const response=await operator.context.get('/api/v1/qualifications/overview',{params});
  expect(response.status(),`Übersicht: HTTP ${response.status()} ${await response.text()}`).toBe(200);
  return {response,rows:(await response.json()) as Record<string,any>[]};
}

async function auditEvents():Promise<Record<string,any>[]>{
  const response=await operator.context.get('/api/v1/audit?limit=1000');
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string,any>[];
}

test('01 Login und Navigation zu Qualifikationen',async({page})=>{
  await login(page);
  await page.getByRole('link',{name:/Qualifikationen/}).click();
  await expect(page).toHaveURL(/\/qualifications$/);
  await expect(page.getByRole('heading',{name:'Qualifikationen',level:1})).toBeVisible();
  await expect(page.getByText('Zentrale Übersicht über Qualifikationen, Nachweise, Katalog und Erinnerungen.')).toBeVisible();
  await expect(page.getByLabel('Mitarbeiter filtern')).toBeVisible();
  expect(permissions).toContain('qualifications:read');
});

test('02 Katalogeintrag mit eindeutigem Code und Pflichtbegründung anlegen',async({page})=>{
  const withoutReason=await admin.context.post('/api/v1/qualifications/catalog',{headers:admin.headers,data:{
    code:uniqueCode('ohne_grund'),name:`E2E Ohne Grund ${runId}`,reason:'   ',
  }});
  expect(withoutReason.status(),'Begründung ist Pflichtfeld.').toBe(400);

  const {catalog}=await createCatalog(admin,'katalog_anlage',{default_validity_days:180,category:'Brandschutz',required_documents:['Brandschutznachweis']});
  expect(catalog).toMatchObject({default_validity_days:180,category:'Brandschutz',required:true});
  expect(catalog.code).toMatch(/^[a-z0-9][a-z0-9_-]{1,79}$/);

  const byCode=await operator.context.get('/api/v1/qualifications/catalog',{params:{q:catalog.code}});
  expect(byCode.status()).toBe(200);
  expect((await byCode.json() as Record<string,any>[]).map(row=>row.id)).toContain(catalog.id);
  const categories=await operator.context.get('/api/v1/qualifications/categories');
  expect((await categories.json() as string[])).toContain('Brandschutz');

  await login(page);
  await page.goto('/qualifications');
  await expect(page.getByRole('table',{name:'Qualifikationskatalog'}).getByText(catalog.name)).toBeVisible();
});

test('03 Duplicate-Code erzeugt 409 und eine deutsche Fehlermeldung',async()=>{
  const {catalog}=await createCatalog(admin,'duplicate');
  const duplicate=await admin.context.post('/api/v1/qualifications/catalog',{headers:admin.headers,data:{
    code:catalog.code,name:`E2E Duplikat ${runId}`,reason:`E2E Duplikatversuch ${runId}`,
  }});
  expect(duplicate.status(),'Duplicate-Code muss mit 409 abgelehnt werden.').toBe(409);
  expect((await duplicate.json()).error).toContain('bereits');
  const list=await operator.context.get('/api/v1/qualifications/catalog',{params:{q:catalog.code}});
  expect((await list.json() as Record<string,any>[]).filter(row=>row.code===catalog.code)).toHaveLength(1);
  await expectCatalogWriteDenied(operator,{code:uniqueCode('rbac_dup'),name:`E2E RBAC ${runId}`,reason:`E2E RBAC ${runId}`},'Operator');
});

test('04 Katalogeintrag bearbeiten und deaktivieren',async()=>{
  const {catalog}=await createCatalog(admin,'katalog_aenderung',{default_validity_days:90});
  const patch=await admin.context.patch(`/api/v1/qualifications/catalog/${catalog.id}`,{headers:admin.headers,data:{
    name:`E2E geändert ${runId}`,category:'Arbeitsschutz',default_validity_days:120,
    required_documents:['Unterweisung'],reason:`E2E Katalogänderung ${runId}`,
  }});
  expect(patch.status()).toBe(200);
  expect(await patch.json()).toMatchObject({id:catalog.id,name:`E2E geändert ${runId}`,category:'Arbeitsschutz',default_validity_days:120,active:true});

  const deactivate=await admin.context.patch(`/api/v1/qualifications/catalog/${catalog.id}`,{headers:admin.headers,data:{
    active:false,reason:`E2E Deaktivierung ${runId}`,
  }});
  expect(deactivate.status()).toBe(200);
  expect((await deactivate.json()).active).toBe(false);
  const inactive=await operator.context.get('/api/v1/qualifications/catalog',{params:{q:catalog.code,active:'false'}});
  expect((await inactive.json() as Record<string,any>[]).map(row=>row.id)).toContain(catalog.id);
  const active=await operator.context.get('/api/v1/qualifications/catalog',{params:{q:catalog.code,active:'true'}});
  expect((await active.json() as Record<string,any>[]).map(row=>row.id)).not.toContain(catalog.id);

  const events=(await auditEvents()).filter(event=>event.entity_id===catalog.id);
  expect(events.map(event=>event.event_type)).toEqual(expect.arrayContaining(['qualification.catalog.updated']));
  expect(events.some(event=>event.details?.reason===`E2E Deaktivierung ${runId}`)).toBe(true);
});

test('05 Qualifikation mit Standardgültigkeit zuweisen',async({page})=>{
  const {catalog}=await createCatalog(admin,'zuordnung',{default_validity_days:365});
  const row=await assignQualification(catalog);
  expect(row).toMatchObject({employee_id:employeeId,code:catalog.code,status:'valid',valid_until_source:'catalog_default',change_reason:`E2E Zuordnung ${catalog.code}`});
  expect(berlinDate(row.valid_from)).toBe(dateIn(0));
  expect(berlinDate(row.valid_until)).toBe(dateIn(365));

  const employeeQualifications=await operator.context.get(`/api/v1/employees/${employeeId}/qualifications`);
  expect(employeeQualifications.status()).toBe(200);
  expect((await employeeQualifications.json() as Record<string,any>[]).some(item=>item.id===row.id)).toBe(true);

  await login(page);
  await page.goto(`/employees/${employeeId}/qualifikationen`);
  await expect(page.getByRole('row').filter({hasText:catalog.name})).toBeVisible();
});

test('06 Dokument verknüpfen: Prüfung ausstehend bis DMS-Freigabe',async({page})=>{
  const {catalog}=await createCatalog(admin,'nachweis',{default_validity_days:365});
  const documentTitle=`E2E Qualifikationsnachweis ${runId}`;
  const upload=await author.context.post('/api/v1/dms/documents',{headers:author.headers,data:{
    title:documentTitle,site_id:siteId,employee_id:employeeId,employee_document_category:'qualification',
    document_type:'Qualifikationsnachweis',description:'Nachweis für die E2E-Qualifikationsverwaltung',
    valid_from:dateIn(-1),valid_until:dateIn(365),review_on:null,
    content_base64:Buffer.from('E2E qualification evidence').toString('base64'),
    content_type:'text/plain',client_mutation_id:randomUUID(),
  }});
  expect(upload.status(),`DMS-Upload: HTTP ${upload.status()} ${await upload.text()}`).toBe(201);
  const document=((await upload.json()) as any).document as Record<string,any>;

  const review=await author.context.post(`/api/v1/dms/documents/${document.id}/request-review`,{headers:author.headers,data:{}});
  expect(review.status()).toBe(200);

  const row=await assignQualification(catalog,{document_id:document.id,valid_until:dateIn(365)});
  let detail=await getAssignment(row.id);
  expect(detail).toMatchObject({computed_status:'awaiting_review',status_label:'Prüfung ausstehend',document_status:'pruefung_ausstehend',document_id:document.id});

  const blockedDownload=await operator.context.get(`/api/v1/qualifications/assignments/${row.id}/document`);
  expect(blockedDownload.status(),'Nachweis darf vor Freigabe nicht heruntergeladen werden.').toBe(409);

  const approval=await admin.context.post(`/api/v1/dms/documents/${document.id}/approve`,{headers:admin.headers,data:{feedback:`E2E Freigabe ${runId}`}});
  expect(approval.status(),`DMS-Freigabe: HTTP ${approval.status()} ${await approval.text()}`).toBe(200);
  expect((await approval.json()).approval_status).toBe('approved');

  detail=await getAssignment(row.id);
  expect(detail).toMatchObject({computed_status:'valid',status_label:'Gültig',document_status:'gueltig'});
  const download=await operator.context.get(`/api/v1/qualifications/assignments/${row.id}/document`);
  expect(download.status()).toBe(200);
  const link=(await download.json()) as Record<string,string>;
  expect(link.download_url).toMatch(new RegExp(`^/api/v1/dms/documents/${document.id}/versions/[0-9a-f-]{36}/download$`));
  expect(link.download_url).not.toContain('latest');
  expect(link.preview_url).toBe(link.download_url.replace('/download','/preview'));

  const listed=await operator.context.get('/api/v1/dms/documents',{params:{employee_id:employeeId}});
  expect(listed.status(),`DMS-Mitarbeiterfilter: HTTP ${listed.status()} ${await listed.text()}`).toBe(200);
  const listedDocument=(await listed.json() as Record<string,any>[]).find(item=>item.id===document.id);
  expect(listedDocument).toBeTruthy();
  const versionId=(listedDocument?.versions??[]).find((item:Record<string,any>)=>item.lifecycle_state==='available')?.id as string|undefined;
  expect(versionId).toBeTruthy();
  expect(link.download_url).toBe(`/api/v1/dms/documents/${document.id}/versions/${versionId}/download`);

  const bytes=await operator.context.get(link.download_url);
  expect(bytes.status(),`Nachweisdownload: HTTP ${bytes.status()} ${await bytes.text()}`).toBe(200);
  expect(bytes.headers()['content-type']).toContain('text/plain');
  expect(await bytes.text()).toBe('E2E qualification evidence');
  const preview=await operator.context.get(link.preview_url!);
  expect(preview.status(),`Nachweisvorschau: HTTP ${preview.status()} ${await preview.text()}`).toBe(200);
  expect(preview.headers()['content-disposition']).toContain('inline');

  await login(page);
  await page.goto(`/employees/${employeeId}/qualifikationen?document=${document.id}`);
  await expect(page.getByRole('region',{name:'Geöffneter Nachweis'})).toBeVisible();
});

test('07 Übersicht: Suche, Filter, Sortierung und Pagination',async()=>{
  const sharedPrefix=uniqueCode('uebersicht');
  const first=await createCatalog(admin,'uebersicht_1',{code:`${sharedPrefix}_a`,required:false,required_document_type:null,required_documents:[]});
  const second=await createCatalog(admin,'uebersicht_2',{code:`${sharedPrefix}_b`,required:false,required_document_type:null,required_documents:[]});
  const firstRow=await assignQualification(first.catalog,{valid_until:dateIn(10)});
  const secondRow=await assignQualification(second.catalog,{valid_until:dateIn(20)});

  const searched=await overview({q:firstRow.code,employee_id:employeeId});
  expect(searched.rows.map(row=>row.id)).toContain(firstRow.id);
  expect(searched.rows.map(row=>row.id)).not.toContain(secondRow.id);
  expect(Number(searched.response.headers()['x-total-count'])).toBeGreaterThanOrEqual(1);

  const expiring=await overview({code:firstRow.code,status:'expiring',days:30,sort:'valid_until',dir:'asc'});
  expect(expiring.rows.map(row=>row.id)).toContain(firstRow.id);
  expect(expiring.rows.find(row=>row.id===firstRow.id)?.status_label).toBe('Läuft bald ab');
  const valid=await overview({code:firstRow.code,status:'valid'});
  expect(valid.rows.map(row=>row.id)).not.toContain(firstRow.id);

  const sorted=await overview({q:sharedPrefix,sort:'valid_until',dir:'asc',pageSize:100});
  const relevant=sorted.rows.filter(row=>[firstRow.id,secondRow.id].includes(row.id));
  expect(relevant.map(row=>row.id)).toEqual([firstRow.id,secondRow.id]);

  const sharedQuery=sharedPrefix;
  const pageOne=await overview({q:sharedQuery,page:1,pageSize:1,sort:'valid_until',dir:'desc'});
  const pageTwo=await overview({q:sharedQuery,page:2,pageSize:1,sort:'valid_until',dir:'desc'});
  expect(Number(pageOne.response.headers()['x-total-count'])).toBe(2);
  expect(Number(pageOne.response.headers()['x-page-count'])).toBe(2);
  expect(pageOne.rows).toHaveLength(1);
  expect(pageTwo.rows).toHaveLength(1);
  expect(pageTwo.rows[0].id).not.toBe(pageOne.rows[0].id);
});

test('08 CSV-Export der Qualifikationsübersicht',async()=>{
  const {catalog}=await createCatalog(admin,'csv_export',{required:false,required_document_type:null,required_documents:[]});
  const row=await assignQualification(catalog,{valid_until:dateIn(365)});
  const response=await operator.context.get('/api/v1/qualifications/export',{params:{code:row.code}});
  expect(response.status(),`CSV-Export: HTTP ${response.status()} ${await response.text()}`).toBe(200);
  expect(response.headers()['content-type']).toContain('text/csv');
  const csv=await response.text();
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('Mitarbeiter;Personalnummer;Qualifikation;Kategorie;Ausstellungsdatum;Gültig ab;Gültig bis;Restlaufzeit;Status;Objekt;Dokument;Dokumentstatus');
  expect(csv).toContain(catalog.name);
  expect(csv).toContain(dateIn(0));
  expect(csv).toContain(dateIn(365));
  expect(csv).toContain('Gültig');
  expect(row.employee_id).toBe(employeeId);
  expect((await auditEvents()).some(event=>event.event_type==='qualifications.exported'&&event.details?.reason==='CSV-Export')).toBe(true);
});

test('09 Detailansicht und Historie einer Zuordnung',async({page})=>{
  const {catalog}=await createCatalog(admin,'detail');
  const row=await assignQualification(catalog,{reason:`E2E Detail ${runId}`,valid_until:dateIn(365)});
  const detail=await getAssignment(row.id);
  expect(detail).toMatchObject({id:row.id,employee_id:employeeId,code:row.code});
  expect(Array.isArray(detail.history)).toBe(true);
  expect(detail.history.some((event:Record<string,any>)=>event.event_type==='qualification.employee.created'&&event.details?.reason===`E2E Detail ${runId}`)).toBe(true);

  const patch=await admin.context.patch(`/api/v1/employees/${employeeId}/qualifications/${row.id}`,{headers:admin.headers,data:{
    notes:`E2E Notiz ${runId}`,reason:`E2E Detailänderung ${runId}`,
  }});
  expect(patch.status()).toBe(200);
  const changed=await getAssignment(row.id);
  expect(changed.notes).toBe(`E2E Notiz ${runId}`);
  expect(changed.history.some((event:Record<string,any>)=>event.event_type==='qualification.employee.updated'&&event.details?.reason===`E2E Detailänderung ${runId}`)).toBe(true);

  await login(page);
  await page.goto(`/employees/${employeeId}/qualifikationen?qualification=${row.id}`);
  const focus=page.getByRole('region',{name:'Geöffneter Nachweis'});
  await expect(focus).toBeVisible();
  await expect(focus.getByRole('heading',{name:catalog.name})).toBeVisible();
});

test('10 Bearbeiten mit Begründung',async()=>{
  const {catalog}=await createCatalog(admin,'bearbeitung',{default_validity_days:365});
  const row=await assignQualification(catalog,{valid_until:dateIn(365)});
  const withoutReason=await admin.context.patch(`/api/v1/employees/${employeeId}/qualifications/${row.id}`,{headers:admin.headers,data:{
    notes:`Ohne Grund ${runId}`,
  }});
  expect(withoutReason.status(),'Begründung ist auch beim Bearbeiten Pflichtfeld.').toBe(400);

  const changedUntil=dateIn(400);
  const patch=await admin.context.patch(`/api/v1/employees/${employeeId}/qualifications/${row.id}`,{headers:admin.headers,data:{
    valid_until:changedUntil,issuing_authority:`E2E Stelle ${runId}`,notes:`E2E Bearbeitung ${runId}`,reason:`E2E Änderungsgrund ${runId}`,
  }});
  expect(patch.status()).toBe(200);
  const patched=(await patch.json()) as Record<string,any>;
  expect(berlinDate(patched.valid_until)).toBe(changedUntil);
  expect(patched).toMatchObject({issuing_authority:`E2E Stelle ${runId}`,notes:`E2E Bearbeitung ${runId}`,change_reason:`E2E Änderungsgrund ${runId}`});
  const events=(await auditEvents()).filter(event=>event.entity_id===row.id&&event.event_type==='qualification.employee.updated');
  expect(events.some(event=>event.details?.reason===`E2E Änderungsgrund ${runId}`
    &&berlinDate(event.details?.previous?.valid_until)===dateIn(365)
    &&berlinDate(event.details?.current?.valid_until)===changedUntil)).toBe(true);
});

test('11 Widerruf und Entfernen mit Begründung',async()=>{
  const revokedCatalog=(await createCatalog(admin,'widerruf',{default_validity_days:365})).catalog;
  const removedCatalog=(await createCatalog(admin,'entfernung',{default_validity_days:365})).catalog;
  const revokedRow=await assignQualification(revokedCatalog,{valid_until:dateIn(365)});
  const removedRow=await assignQualification(removedCatalog,{valid_until:dateIn(365)});

  const withoutReason=await admin.context.post(`/api/v1/employees/${employeeId}/qualifications/${revokedRow.id}/revoke`,{headers:admin.headers,data:{}});
  expect(withoutReason.status(),'Widerruf ohne Begründung muss abgelehnt werden.').toBe(400);
  const revoke=await admin.context.post(`/api/v1/employees/${employeeId}/qualifications/${revokedRow.id}/revoke`,{headers:admin.headers,data:{reason:`E2E Widerruf ${runId}`}});
  expect(revoke.status()).toBe(200);
  expect((await revoke.json()).status).toBe('revoked');
  expect(await getAssignment(revokedRow.id)).toMatchObject({status_label:'Widerrufen',issue_code:'revoked'});
  const reassign=await admin.context.post(`/api/v1/employees/${employeeId}/qualifications`,{headers:admin.headers,data:{
    catalog_id:revokedCatalog.id,valid_from:dateIn(0),reason:`E2E Neuzertifizierung ${runId}`,
  }});
  expect(reassign.status(),'Nach einem Widerruf muss eine neue Zertifizierung möglich sein.').toBe(201);
  const recertified=(await reassign.json()) as Record<string,any>;
  createdAssignmentIds.push(recertified.id);
  expect(recertified.id).not.toBe(revokedRow.id);
  expect(recertified).toMatchObject({status:'valid',valid_until_source:'catalog_default',code:revokedCatalog.code});
  expect(await getAssignment(revokedRow.id)).toMatchObject({status:'revoked',computed_status:'revoked'});
  const audit=await auditEvents();
  expect(audit.some(event=>event.entity_id===recertified.id&&event.event_type==='qualification.employee.created'
    &&event.details?.reason===`E2E Neuzertifizierung ${runId}`)).toBe(true);

  const remove=await admin.context.delete(`/api/v1/employees/${employeeId}/qualifications/${removedRow.id}`,{headers:admin.headers,data:{reason:`E2E Entfernung ${runId}`}});
  expect(remove.status()).toBe(204);
  expect(await getAssignment(removedRow.id)).toMatchObject({status:'invalid',status_label:'Ungültig'});

  const events=await auditEvents();
  expect(events.some(event=>event.entity_id===revokedRow.id&&event.event_type==='qualification.employee.revoked'&&event.details?.reason===`E2E Widerruf ${runId}`)).toBe(true);
  expect(events.some(event=>event.entity_id===removedRow.id&&event.event_type==='qualification.employee.removed'&&event.details?.reason===`E2E Entfernung ${runId}`)).toBe(true);
});

test('12 Objektanforderung, Einsatzprüfung, Erinnerungen, RBAC und Mandantentrennung',async()=>{
  await test.step('Objektanforderung mit dienstplanerischer Einsatzprüfung',async()=>{
    const {catalog}=await createCatalog(admin,'objektanforderung',{default_validity_days:365});
    const requirement=await admin.context.post(`/api/v1/sites/${siteId}/qualification-requirements`,{headers:admin.headers,data:{
      catalog_id:catalog.id,required:true,active:true,responsible_employee_id:employeeId,
      notes:`E2E Anforderung ${runId}`,reason:`E2E Anforderung ${runId}`,
    }});
    expect(requirement.status(),`Anforderung: HTTP ${requirement.status()} ${await requirement.text()}`).toBe(201);
    const requirementRow=(await requirement.json()) as Record<string,any>;
    createdRequirements.push({id:requirementRow.id,siteId});
    const list=await operator.context.get(`/api/v1/sites/${siteId}/qualification-requirements`);
    expect(list.status()).toBe(200);
    expect((await list.json() as Record<string,any>[]).map(row=>row.id)).toContain(requirementRow.id);

    const period=await admin.context.post('/api/v1/scheduling/periods',{headers:admin.headers,data:{
      site_id:siteId,rule_profile_id:ruleProfileId,name:`E2E Qualifikationsplan ${runId}`,
      starts_at:isoIn(0),ends_at:isoIn(30),status:'published',client_mutation_id:randomUUID(),
    }});
    expect([200,201]).toContain(period.status());
    const periodRow=(await period.json()) as Record<string,any>;
    const shift=await admin.context.post(`/api/v1/scheduling/periods/${periodRow.id}/shifts`,{headers:admin.headers,data:{
      site_id:siteId,role_code:'E2E-QUAL',starts_at:isoIn(7,8),ends_at:isoIn(7,16),
      required_qualification_codes:[catalog.code],client_mutation_id:randomUUID(),
    }});
    expect([200,201]).toContain(shift.status());
    const shiftRow=(await shift.json()) as Record<string,any>;
    const eligibility=await operator.context.get(`/api/v1/sites/${siteId}/shifts/${shiftRow.id}/eligibility`);
    expect(eligibility.status()).toBe(200);
    const verdict:Record<string,any>=(await eligibility.json()).employees.find((entry:Record<string,any>)=>entry.employee_id===employeeId);
    expect(verdict).toBeTruthy();
    expect(verdict.status).toBe('ineligible');
    expect(verdict.missing_qualification_codes).toContain(catalog.code);
  });

  await test.step('Erinnerungseinstellungen und Erinnerungshistorie',async()=>{
    const before=await operator.context.get('/api/v1/qualifications/reminders');
    expect(before.status()).toBe(200);
    expect(Array.isArray((await before.json()).reminder_days)).toBe(true);
    const update=await admin.context.put('/api/v1/qualifications/reminders',{headers:admin.headers,data:{
      reminder_days:[45,7],reason:`E2E Erinnerungen ${runId}`,
    }});
    expect(update.status(),`Erinnerungen: HTTP ${update.status()} ${await update.text()}`).toBe(200);
    expect((await update.json()).reminder_days).toEqual([45,7]);
    expect((await (await operator.context.get('/api/v1/qualifications/reminders')).json()).reminder_days).toEqual([45,7]);
    const history=await operator.context.get('/api/v1/qualifications/reminders/history');
    expect(history.status()).toBe(200);
    const rows=(await history.json()) as Record<string,any>[];
    expect(rows.every(row=>typeof row.event_key==='string'&&typeof row.event_type==='string')).toBe(true);
  });

  await test.step('RBAC: Leser darf nicht schreiben oder exportieren',async()=>{
    const read=await viewer.context.get('/api/v1/qualifications/catalog');
    expect(read.status()).toBe(200);
    const write=await viewer.context.post('/api/v1/qualifications/catalog',{headers:viewer.headers,data:{
      code:uniqueCode('rbac'),name:`E2E RBAC ${runId}`,reason:`E2E RBAC ${runId}`,
    }});
    expect(write.status(),'Viewer darf keinen Katalogeintrag anlegen.').toBe(403);
    const exportResponse=await viewer.context.get('/api/v1/qualifications/export');
    expect(exportResponse.status(),'Viewer darf nicht exportieren.').toBe(403);
    const reminders=await viewer.context.put('/api/v1/qualifications/reminders',{headers:viewer.headers,data:{
      reminder_days:[1],reason:`E2E RBAC ${runId}`,
    }});
    expect(reminders.status(),'Viewer darf keine Erinnerungen ändern.').toBe(403);
  });

  await test.step('Mandantentrennung: fremder Mandant sieht keine Fixture-Daten',async()=>{
    const {catalog}=await createCatalog(admin,'mandant');
    const foreignCatalog=await foreign.context.get('/api/v1/qualifications/catalog',{params:{q:catalog.code}});
    expect(foreignCatalog.status()).toBe(200);
    expect((await foreignCatalog.json() as Record<string,any>[]).map(row=>row.id)).not.toContain(catalog.id);
    const foreignDetail=await foreign.context.get(`/api/v1/qualifications/catalog/${catalog.id}`);
    expect(foreignDetail.status(),'Katalogdetail ist mandantengebunden.').toBe(404);
    const row=await assignQualification(catalog,{valid_until:dateIn(365)});
    const foreignAssignment=await foreign.context.get(`/api/v1/qualifications/assignments/${row.id}`);
    expect(foreignAssignment.status(),'Qualifikationsdetail ist mandantengebunden.').toBe(404);
  });
});

test('13 Gültigkeits-Herkunft, Tri-State und Filtervalidierung',async({page})=>{
  const unlimitedCatalog=(await createCatalog(admin,'unbefristet',{default_validity_days:365,required:false,required_document_type:null,required_documents:[]})).catalog;
  const manualCatalog=(await createCatalog(admin,'manuell',{default_validity_days:365,required:false,required_document_type:null,required_documents:[]})).catalog;
  const defaultCatalog=(await createCatalog(admin,'standard',{default_validity_days:365,required:false,required_document_type:null,required_documents:[]})).catalog;

  const unlimited=await assignQualification(unlimitedCatalog,{valid_until:null});
  const manual=await assignQualification(manualCatalog,{valid_until:dateIn(30)});
  const fromCatalog=await assignQualification(defaultCatalog);
  expect(unlimited).toMatchObject({valid_until:null,valid_until_source:'unlimited'});
  expect(manual).toMatchObject({valid_until_source:'manual'});
  expect(berlinDate(manual.valid_until)).toBe(dateIn(30));
  expect(fromCatalog).toMatchObject({valid_until_source:'catalog_default'});
  expect(berlinDate(fromCatalog.valid_until)).toBe(dateIn(365));

  const kept=await admin.context.patch(`/api/v1/employees/${employeeId}/qualifications/${manual.id}`,{headers:admin.headers,data:{
    notes:`E2E Tri-State Notiz ${runId}`,reason:`E2E Tri-State Änderung ${runId}`,
  }});
  expect(kept.status()).toBe(200);
  expect((await kept.json() as Record<string,any>)).toMatchObject({valid_until_source:'manual'});
  expect(berlinDate((await kept.json() as Record<string,any>).valid_until)).toBe(dateIn(30));

  const changed=await admin.context.patch(`/api/v1/employees/${employeeId}/qualifications/${fromCatalog.id}`,{headers:admin.headers,data:{
    valid_until:null,reason:`E2E Unbefristet per Änderung ${runId}`,
  }});
  expect(changed.status()).toBe(200);
  expect(await changed.json()).toMatchObject({valid_until:null,valid_until_source:'unlimited'});

  for(const query of ['employee_id=not-a-uuid','expires_from=31.12.2026','status=unknown','page=0','days=-1']){
    const response=await operator.context.get(`/api/v1/qualifications/overview?${query}`);
    expect(response.status(),`Ungültiger Filter ${query} muss 400 liefern.`).toBe(400);
  }

  await login(page);
  await page.goto('/qualifications');
  await expect(page.getByLabel('Mitarbeiter filtern')).toBeVisible();
  await expect(page.getByRole('table',{name:'Qualifikationsübersicht'})).toBeVisible();
});
