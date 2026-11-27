import {randomUUID} from 'node:crypto';
import {expect,test,type APIRequestContext,type APIResponse} from '@playwright/test';

/**
 * Integrationsaudit A–F: Mitarbeiter, Qualifikation, DMS-Freigabe, Objektanforderung
 * und verbindliche Einsatzprüfung (Lese- und Schreibweg) in einem realen Zug.
 *
 * Alle schreibenden Zugriffe laufen gegen den isolierten Fixture-Tenant aus
 * backend/src/e2e-fixture.ts (E2E_FIXTURE=isolated). Es werden ausschließlich
 * in dieser Spec angelegte Mitarbeiter, Kataloge, Zuordnungen, Anforderungen und
 * Dokumente verändert; der Seed-Mitarbeiter bleibt unberührt. DMS-Nachweise
 * werden über den echten Upload- und Virenscan-Workflow angelegt und ausschließlich
 * über /request-review + /approve freigegeben — es gibt keinen DB- oder API-Shortcut
 * und keinen simulierten Scanner. Fehlt die Approve-API oder ist der Scanner nicht
 * bereit, werden die betroffenen Tests mit explizitem Grund übersprungen.
 *
 * Bekannte API-Grenze: es gibt keine DELETE-Endpunkte für Mitarbeiter, Dienstplan-
 * zeiträume, Schichten, Schichtzuweisungen oder DMS-Dokumente. Der Cleanup deaktiviert
 * Kataloge/Anforderungen, beendet Objektzuordnungen, invalidiert Qualifikationen und
 * archiviert die angelegten Mitarbeiter; die übrigen E2E-Datensätze verbleiben als
 * klar markierte Artefakte im isolierten Tenant.
 */
const email=process.env.E2E_EMAIL??'e2e-scale-20261126@example.invalid';
const password=process.env.E2E_PASSWORD??'local-e2e-password-20261126';
const authorEmail=process.env.E2E_AUTHOR_EMAIL??'e2e-author@example.invalid';
const viewerEmail=process.env.E2E_VIEWER_EMAIL??'e2e-viewer@example.invalid';
const adminEmail=process.env.E2E_ADMIN_EMAIL??'e2e-qm-admin@example.invalid';
const adminPassword=process.env.E2E_ADMIN_PASSWORD??password;
const foreignEmail=process.env.E2E_FOREIGN_EMAIL??'admin@example.com';
const foreignPassword=process.env.E2E_FOREIGN_PASSWORD??'password';
const apiBase=process.env.E2E_API_BASE_URL??'http://localhost:3000';
const fixtureSiteId=process.env.E2E_SITE_ID??'00000000-0000-4000-8000-000000000103';
/** Die Spec arbeitet auf einem eigenen, unbelasteten E2E-Objekt ohne fremde Dienstanweisungen/Anforderungen. */
let siteId=fixtureSiteId;
let createdSiteId='';
const ruleProfileId=process.env.E2E_RULE_PROFILE_ID??'00000000-0000-4000-8000-000000000116';
const runId=`${Date.now().toString(36)}${randomUUID().slice(0,6)}`;
const cleanupReason=`E2E Integrationsaudit ${runId} aufgeräumt`;
const evidenceType='Qualifikationsnachweis';
/** Klartext-Nachweis: wird unverändert vom echten DMS hochgeladen und gescannt. */
const evidenceText=`E2E Integrationsaudit Nachweis ${runId}`;
const evidenceBase64=Buffer.from(evidenceText,'utf8').toString('base64');

test.skip(!email||!password,'Set E2E_EMAIL and E2E_PASSWORD to run the integration-audit E2E tests.');

type Session={context:APIRequestContext;headers:Record<string,string>};
type Row=Record<string,any>;
type EmployeeFixture={id:string;profile:Row;objectAssignments:string[]};
type PlaywrightLike={request:{newContext(options?:{baseURL?:string}):Promise<APIRequestContext>}};

let admin:Session;
let author:Session;
let viewer:Session;
let foreign:Session;
let viewerPermissions:string[]=[];
let adminTenantId='';
let foreignTenantId='';
const capabilities={dmsApproveApi:false,dmsReady:false};
const shared={periodId:''};
const createdEmployees:EmployeeFixture[]=[];
const createdCatalogs:{id:string;session:Session}[]=[];
const createdQualifications:{employeeId:string;id:string}[]=[];
const createdRequirements:{id:string;siteId:string}[]=[];
const createdDocuments:string[]=[];

function uniqueCode(label:string):string{
  // Labels wie A–F müssen als Buchstabe erhalten bleiben: sonst kollidieren
  // B/D/F nach dem Ersetzen von Großbuchstaben auf denselben employee_number.
  return `e2e_audit_${label.toLowerCase()}_${runId}`.replace(/[^a-z0-9_-]/g,'_').slice(0,80);
}

function dateIn(days:number):string{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const [year,month,day]=today.split('-').map(Number);
  return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10);
}

function isoIn(days:number,hour=0):string{
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  date.setUTCHours(hour,0,0,0);
  return date.toISOString();
}

async function loginApi(playwright:PlaywrightLike,userEmail:string,userPassword:string):Promise<Session>{
  const context=await playwright.request.newContext({baseURL:process.env.E2E_BASE_URL??'http://localhost:5173'});
  const response=await context.post('/api/v1/auth/login',{data:{
    email:userEmail,password:userPassword,device_id:randomUUID(),
    metadata:{platform:'playwright-integration-audit',app_version:'e2e'},
  }});
  expect(response.status(),`Login ${userEmail}: HTTP ${response.status()} ${await response.text()}`).toBe(200);
  const token=(await context.cookies()).find(cookie=>cookie.name==='securityops_csrf')?.value;
  if(!token)throw new Error(`Kein CSRF-Cookie für ${userEmail} erhalten.`);
  return {context,headers:{'x-csrf-token':decodeURIComponent(token)}};
}

async function expectStatus(response:APIResponse,status:number,label:string):Promise<void>{
  expect(response.status(),`${label}: HTTP ${response.status()} ${await response.text()}`).toBe(status);
}

async function expectStatusIn(response:APIResponse,statuses:number[],label:string):Promise<void>{
  expect(statuses,`${label}: HTTP ${response.status()} ${await response.text()}`).toContain(response.status());
}

function skipUnlessDmsWorkflow():void{
  test.skip(!capabilities.dmsApproveApi,
    'SKIP: DMS-Upload-/Request-Review-/Approve-API fehlt in /api/openapi.json – echter Freigabeworkflow nicht testbar');
  test.skip(!capabilities.dmsReady,
    'SKIP: lokaler DMS-Virenscan-/Speicherdienst (/ready/dms) nicht bereit – kein Ersatzscanner und keine DB-Freigabe');
}

test.beforeAll(async({request,playwright})=>{
  const ready=await request.get(`${apiBase}/ready`);
  expect(ready.ok(),`Integrationsaudit: Backend ${apiBase}/ready ist nicht bereit (${ready.status()}).`).toBeTruthy();
  admin=await loginApi(playwright,adminEmail,adminPassword);
  author=await loginApi(playwright,authorEmail,password);
  viewer=await loginApi(playwright,viewerEmail,password);
  foreign=await loginApi(playwright,foreignEmail,foreignPassword);

  const adminMe=await admin.context.get('/api/v1/auth/me');
  await expectStatus(adminMe,200,'Admin /auth/me');
  const adminUser=((await adminMe.json()) as Row).user as Row;
  adminTenantId=String(adminUser.tenantId??adminUser.tenant_id??'');
  expect(adminUser.permissions,'Fixture-Admin benötigt alle vier Schreibrechte.').toEqual(expect.arrayContaining([
    'employees:write','qualifications:write','dms:write','scheduling:write','sites:write',
  ]));

  const auditSite=await admin.context.post('/api/v1/sites',{headers:admin.headers,data:{
    name:`E2E Integrationsaudit ${runId}`,site_number:uniqueCode('objekt'),
    site_type:'E2E Isolationsobjekt',status:'active',required_staff_count:0,
  }});
  await expectStatus(auditSite,201,'Isoliertes E2E-Objekt');
  createdSiteId=String(((await auditSite.json()) as Row).id);
  expect(createdSiteId).toBeTruthy();
  siteId=createdSiteId;

  const viewerMe=await viewer.context.get('/api/v1/auth/me');
  await expectStatus(viewerMe,200,'Viewer /auth/me');
  viewerPermissions=(((await viewerMe.json()) as Row).user?.permissions??[]) as string[];
  for(const permission of ['employees:write','qualifications:write','dms:write','scheduling:write']){
    expect(viewPermissions(),`Viewer darf ${permission} nicht besitzen.`).not.toContain(permission);
  }
  const foreignMe=await foreign.context.get('/api/v1/auth/me');
  await expectStatus(foreignMe,200,'Fremder Mandant /auth/me');
  const foreignUser=((await foreignMe.json()) as Row).user as Row;
  foreignTenantId=String(foreignUser.tenantId??foreignUser.tenant_id??'');
  expect(foreignTenantId&&foreignTenantId!==adminTenantId,
    'Der Fremdmandant muss einen anderen Tenant als der Fixture-Admin haben.').toBeTruthy();

  const openApi=await request.get(`${apiBase}/api/openapi.json`);
  if(openApi.ok()){
    const paths=(((await openApi.json()) as Row).paths??{}) as Record<string,Record<string,unknown>>;
    capabilities.dmsApproveApi=Boolean(
      paths['/dms/documents']?.post
      &&paths['/dms/documents/{documentId}/request-review']?.post
      &&paths['/dms/documents/{documentId}/approve']?.post
      &&paths['/dms/documents/{documentId}/return-for-revision']?.post
      &&paths['/dms/documents/{documentId}/versions/{versionId}/download']?.get);
  }
  const dmsReady=await request.get(`${apiBase}/ready/dms`);
  capabilities.dmsReady=dmsReady.ok();

  const period=await admin.context.post('/api/v1/scheduling/periods',{headers:admin.headers,data:{
    site_id:siteId,rule_profile_id:ruleProfileId,name:`E2E Integrationsaudit Plan ${runId}`,
    starts_at:isoIn(-1),ends_at:isoIn(60),status:'published',client_mutation_id:randomUUID(),
  }});
  await expectStatusIn(period,[200,201],'Gemeinsamer Dienstplanzeitraum');
  shared.periodId=String(((await period.json()) as Row).id);
  expect(shared.periodId).toBeTruthy();
});

function viewPermissions():string[]{return viewerPermissions;}

test.afterEach(async()=>{
  if(!admin)return;
  for(const requirement of [...createdRequirements].reverse()){
    const response=await admin.context.delete(`/api/v1/sites/${requirement.siteId}/qualification-requirements/${requirement.id}`,{
      headers:admin.headers,data:{reason:cleanupReason},
    });
    if(![200,204,404].includes(response.status()))console.warn(`Cleanup Anforderung ${requirement.id}: HTTP ${response.status()}`);
  }
  createdRequirements.length=0;
});

test.afterAll(async()=>{
  if(admin){
    for(const {employeeId,id} of [...createdQualifications].reverse()){
      const response=await admin.context.delete(`/api/v1/employees/${employeeId}/qualifications/${id}`,{
        headers:admin.headers,data:{reason:cleanupReason},
      });
      // 409 ist erwartet, wenn ein Datensatz bewusst als Historie widerrufen wurde.
      if(![200,204,404,409].includes(response.status()))console.warn(`Cleanup Qualifikation ${id}: HTTP ${response.status()}`);
    }
    for(const employee of [...createdEmployees].reverse()){
      for(const assignmentId of [...employee.objectAssignments].reverse()){
        const response=await admin.context.patch(`/api/v1/employees/${employee.id}/object-assignments/${assignmentId}`,{
          headers:admin.headers,data:{ends_on:dateIn(-1),reason:cleanupReason},
        });
        if(![200,404].includes(response.status()))console.warn(`Cleanup Objektzuordnung ${assignmentId}: HTTP ${response.status()}`);
      }
      const archived=profilePayload({...employee.profile,employment_status:'terminated',termination_date:dateIn(-1)},cleanupReason);
      const response=await admin.context.patch(`/api/v1/employees/${employee.id}/profile`,{headers:admin.headers,data:archived});
      if(response.status()!==200)console.warn(`Cleanup Mitarbeiter ${employee.id}: HTTP ${response.status()}`);
    }
    for(const {id,session} of [...createdCatalogs].reverse()){
      const response=await session.context.patch(`/api/v1/qualifications/catalog/${id}`,{
        headers:session.headers,data:{active:false,reason:cleanupReason},
      });
      if(response.status()!==200)console.warn(`Cleanup Katalog ${id}: HTTP ${response.status()}`);
    }
    if(createdSiteId){
      const decommissioned=await admin.context.patch(`/api/v1/sites/${createdSiteId}`,{
        headers:admin.headers,data:{status:'decommissioned'},
      });
      if(decommissioned.status()!==200)console.warn(`Cleanup Objekt ${createdSiteId} → decommissioned: HTTP ${decommissioned.status()}`);
      const archived=await admin.context.patch(`/api/v1/sites/${createdSiteId}`,{
        headers:admin.headers,data:{status:'archived'},
      });
      if(archived.status()!==200)console.warn(`Cleanup Objekt ${createdSiteId} → archived: HTTP ${archived.status()}`);
    }
  }
  for(const session of [admin,author,viewer,foreign])await session?.context.dispose();
});

function profilePayload(profile:Row,reason:string):Row{
  const fields=['name','email','title','employee_number','first_name','last_name','phone','mobile','address',
    'date_of_birth','hire_date','termination_date','employment_status','employment_type','department',
    'position','work_location','weekly_hours','user_id'] as const;
  const payload:Row={};
  for(const field of fields)payload[field]=profile[field]??null;
  payload.reason=reason;
  return payload;
}

async function createEmployee(label:string,overrides:Row={}):Promise<Row>{
  const profile:Row={
    name:`E2E Audit ${label} ${runId}`,email:`${uniqueCode(`mail_${label}`)}@example.invalid`,
    title:'Wachschutz',employee_number:uniqueCode(`pers_${label}`),
    first_name:`E2E${label}`,last_name:`Audit${runId}`,phone:'+49 30 000000',
    address:'E2E-Teststraße 1',date_of_birth:null,hire_date:dateIn(-60),termination_date:null,
    employment_status:'active',employment_type:'employee',department:'E2E Qualitätssicherung',
    position:'Wachschutz',work_location:siteId,weekly_hours:40,user_id:null,
    reason:`E2E Integrationsaudit ${label} ${runId} angelegt`,...overrides,
  };
  const response=await admin.context.post('/api/v1/employees',{headers:admin.headers,data:profile});
  await expectStatus(response,201,`Mitarbeiter ${label}`);
  const row=(await response.json()) as Row;
  createdEmployees.push({id:row.id,profile,objectAssignments:[]});
  return row;
}

async function assignEmployeeToSite(employeeId:string,label:string,overrides:Row={}):Promise<Row>{
  const payload:Row={
    site_id:siteId,assignment_type:'operational',role:`E2E ${label}`,starts_on:dateIn(-60),
    ends_on:null,primary_assignment:false,notes:`E2E Integrationsaudit ${label}`,
    reason:`E2E Objektzuordnung ${label} ${runId}`,...overrides,
  };
  const response=await admin.context.post(`/api/v1/employees/${employeeId}/object-assignments`,{headers:admin.headers,data:payload});
  await expectStatus(response,201,`Objektzuordnung ${label}`);
  const row=(await response.json()) as Row;
  createdEmployees.find(employee=>employee.id===employeeId)?.objectAssignments.push(row.id);
  return row;
}

async function patchEmployee(employeeId:string,changes:Row):Promise<Row>{
  const stored=createdEmployees.find(employee=>employee.id===employeeId);
  expect(stored,`Mitarbeiter ${employeeId} muss aus dieser Spec stammen.`).toBeTruthy();
  const payload=profilePayload({...stored!.profile,...changes},`E2E Statusänderung ${runId}`);
  const response=await admin.context.patch(`/api/v1/employees/${employeeId}/profile`,{headers:admin.headers,data:payload});
  await expectStatus(response,200,`Profiländerung ${employeeId}`);
  return (await response.json()) as Row;
}

async function createCatalog(label:string,overrides:Row={}):Promise<Row>{
  const payload:Row={
    code:uniqueCode(label),name:`E2E Audit ${label} ${runId}`,
    description:`Isolierter E2E-Katalogeintrag ${runId}`,category:'Interne Schulungen',
    default_validity_days:365,required:true,required_document_type:null,required_documents:[],
    active:true,reason:`E2E Katalog ${label} ${runId} angelegt`,...overrides,
  };
  const response=await admin.context.post('/api/v1/qualifications/catalog',{headers:admin.headers,data:payload});
  await expectStatus(response,201,`Katalog ${label}`);
  const row=(await response.json()) as Row;
  createdCatalogs.push({id:row.id,session:admin});
  return row;
}

async function createQualification(employeeId:string,catalog:Row,overrides:Row={}):Promise<Row>{
  const payload:Row={
    catalog_id:catalog.id,code:catalog.code,valid_from:dateIn(0),
    reason:`E2E Zuordnung ${catalog.code} ${runId}`,...overrides,
  };
  const response=await admin.context.post(`/api/v1/employees/${employeeId}/qualifications`,{headers:admin.headers,data:payload});
  await expectStatus(response,201,`Qualifikation ${catalog.code}`);
  const row=(await response.json()) as Row;
  createdQualifications.push({employeeId,id:row.id});
  return row;
}

async function qualificationDetail(id:string):Promise<Row>{
  const response=await admin.context.get(`/api/v1/qualifications/assignments/${id}`);
  await expectStatus(response,200,`Qualifikationsdetail ${id}`);
  return (await response.json()) as Row;
}

async function createShift(label:string,requiredCodes:string[]):Promise<Row>{
  const response=await admin.context.post(`/api/v1/scheduling/periods/${shared.periodId}/shifts`,{headers:admin.headers,data:{
    site_id:siteId,role_code:`E2E-AUDIT-${label}`.slice(0,80),starts_at:isoIn(7,8),ends_at:isoIn(7,16),
    required_qualification_codes:requiredCodes,notes:`E2E Einsatzprüfung ${label} ${runId}`,
    client_mutation_id:randomUUID(),
  }});
  await expectStatusIn(response,[200,201],`Schicht ${label}`);
  return (await response.json()) as Row;
}

async function verdictFor(shiftId:string,employeeId:string):Promise<Row>{
  const response=await admin.context.get(`/api/v1/sites/${siteId}/shifts/${shiftId}/eligibility`);
  await expectStatus(response,200,`Einsatzfähigkeit Schicht ${shiftId}`);
  const verdict=((await response.json()) as Row).employees.find((entry:Row)=>entry.employee_id===employeeId) as Row|undefined;
  expect(verdict,`Mitarbeiter ${employeeId} muss für die Schicht ${shiftId} bewertet werden.`).toBeTruthy();
  return verdict!;
}

async function assignToShift(shiftId:string,employeeId:string):Promise<APIResponse>{
  return admin.context.post(`/api/v1/scheduling/shifts/${shiftId}/assignments`,{headers:admin.headers,data:{
    employee_id:employeeId,client_mutation_id:randomUUID(),
  }});
}

async function uploadEvidence(label:string,employeeId:string):Promise<{document:Row;version:Row}>{
  const response=await author.context.post('/api/v1/dms/documents',{headers:author.headers,data:{
    title:`E2E Scan ${label} ${runId}`,site_id:siteId,employee_id:employeeId,
    employee_document_category:'qualification',document_type:evidenceType,
    description:`E2E-gescannter Nachweis ${runId}; Upload durch echten DMS-Workflow geprüft`,
    valid_from:dateIn(-1),valid_until:dateIn(365),review_on:null,
    content_base64:evidenceBase64,content_type:'text/plain',client_mutation_id:randomUUID(),
  }});
  await expectStatus(response,201,`DMS-Upload ${label}`);
  const body=(await response.json()) as Row;
  expect(body.version?.lifecycle_state,'Upload muss den echten Virenscan durchlaufen haben.').toBe('available');
  createdDocuments.push(String(body.document.id));
  return {document:body.document as Row,version:body.version as Row};
}

async function requestReview(documentId:string):Promise<void>{
  const response=await author.context.post(`/api/v1/dms/documents/${documentId}/request-review`,{headers:author.headers,data:{}});
  await expectStatus(response,200,`Freigabeantrag Dokument ${documentId}`);
}

async function approveDocument(documentId:string):Promise<void>{
  const response=await admin.context.post(`/api/v1/dms/documents/${documentId}/approve`,{headers:admin.headers,data:{
    feedback:`E2E Freigabe ${runId} durch anderen Benutzer als den Hochladenden`,
  }});
  await expectStatus(response,200,`DMS-Freigabe Dokument ${documentId}`);
  expect(((await response.json()) as Row).approval_status).toBe('approved');
}

async function createRequirement(catalogId:string,employeeId:string,label:string):Promise<Row>{
  const response=await admin.context.post(`/api/v1/sites/${siteId}/qualification-requirements`,{headers:admin.headers,data:{
    catalog_id:catalogId,required:true,active:true,responsible_employee_id:employeeId,
    notes:`E2E Anforderung ${label} ${runId}`,reason:`E2E Anforderung ${label} ${runId}`,
  }});
  await expectStatus(response,201,`Objektanforderung ${label}`);
  const row=(await response.json()) as Row;
  createdRequirements.push({id:row.id,siteId});
  return row;
}

async function deactivateRequirement(id:string):Promise<void>{
  const response=await admin.context.delete(`/api/v1/sites/${siteId}/qualification-requirements/${id}`,{
    headers:admin.headers,data:{reason:`E2E Anforderungswechsel ${runId}`},
  });
  expect([200,204,404],`Anforderung ${id} deaktivieren`).toContain(response.status());
  createdRequirements.splice(createdRequirements.findIndex(requirement=>requirement.id===id),1);
}

test('A Neuer Mitarbeiter mit Pflichtqualifikation und gescantem Nachweis wird einsatzfähig (SKIP ohne DMS-Approve-API/Scanner)',async()=>{
  skipUnlessDmsWorkflow();
  const employee=await createEmployee('A');
  await assignEmployeeToSite(employee.id,'A');
  const catalog=await createCatalog('A_pflicht',{
    required:true,required_document_type:evidenceType,required_documents:[evidenceType],default_validity_days:365,
  });
  const {document}=await uploadEvidence('A',employee.id);
  await requestReview(document.id);
  await approveDocument(document.id);
  const assignment=await createQualification(employee.id,catalog,{document_id:document.id,valid_from:dateIn(0)});
  const detail=await qualificationDetail(assignment.id);
  expect(detail).toMatchObject({
    employee_id:employee.id,code:catalog.code,document_id:document.id,
    computed_status:'valid',status_label:'Gültig',document_status:'gueltig',document_approval_status:'approved',
  });

  const profileResponse=await admin.context.get(`/api/v1/employees/${employee.id}/profile`);
  await expectStatus(profileResponse,200,'Mitarbeiterprofil A');
  const profile=(await profileResponse.json()) as Row;
  expect(profile.qualifications.some((row:Row)=>row.id===assignment.id&&row.computed_status==='valid')).toBe(true);
  expect(profile.documents.some((row:Row)=>row.id===document.id&&row.document_status==='active')).toBe(true);

  const shift=await createShift('A',[catalog.code]);
  const verdict=await verdictFor(shift.id,employee.id);
  expect(verdict.status).not.toBe('ineligible');
  expect(verdict.matched_qualification_codes).toContain(catalog.code);
  const assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,201,'Einsatzzuweisung A');
  expect((await assigned.json()) as Row).toMatchObject({employee_id:employee.id,shift_id:shift.id});
});

test('B abgelaufene Qualifikation: ineligible, Status "Abgelaufen" und abgelehnte Einsatzzuweisung (read+write)',async()=>{
  const employee=await createEmployee('B');
  await assignEmployeeToSite(employee.id,'B');
  const catalog=await createCatalog('B_ablauf',{default_validity_days:1});
  const assignment=await createQualification(employee.id,catalog,{
    valid_from:dateIn(-30),valid_until:dateIn(-1),
  });
  const detail=await qualificationDetail(assignment.id);
  expect(detail).toMatchObject({computed_status:'expired',status_label:'Abgelaufen',issue_code:'expired'});

  const overview=await admin.context.get('/api/v1/qualifications/overview',{params:{status:'expired',employee_id:employee.id}});
  await expectStatus(overview,200,'Qualifikationsübersicht B');
  expect(((await overview.json()) as Row[]).map(row=>row.id)).toContain(assignment.id);

  const shift=await createShift('B',[catalog.code]);
  const verdict=await verdictFor(shift.id,employee.id);
  expect(verdict.status).toBe('ineligible');
  expect(verdict.missing_qualification_codes).toContain(catalog.code);
  expect(verdict.reasons.map((reason:Row)=>reason.code)).toContain('qualification_expired');

  const assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,409,'Schreibweg B muss die abgelaufene Qualifikation ablehnen');
  expect((await assigned.json()) as Row).toMatchObject({reason_code:'qualification_expired'});
});

test('C Freigabeentzug und Qualifikationswiderruf wirken bis zum abgelehnten Einsatz (SKIP ohne DMS-Approve-API/Scanner)',async()=>{
  skipUnlessDmsWorkflow();
  const employee=await createEmployee('C');
  await assignEmployeeToSite(employee.id,'C');
  const catalog=await createCatalog('C_nachweis',{
    required:true,required_document_type:evidenceType,required_documents:[evidenceType],
  });
  const {document}=await uploadEvidence('C',employee.id);
  await requestReview(document.id);
  await approveDocument(document.id);
  const assignment=await createQualification(employee.id,catalog,{document_id:document.id});
  const shift=await createShift('C',[catalog.code]);
  expect((await verdictFor(shift.id,employee.id)).status).not.toBe('ineligible');

  const withdrawal=await admin.context.post(`/api/v1/dms/documents/${document.id}/return-for-revision`,{
    headers:admin.headers,data:{reason:`E2E Freigabeentzug ${runId}`},
  });
  await expectStatus(withdrawal,200,'Freigabeentzug Dokument C');
  expect(((await withdrawal.json()) as Row).approval_status).toBe('rejected');
  let detail=await qualificationDetail(assignment.id);
  expect(detail).toMatchObject({computed_status:'awaiting_review',document_status:'nicht_freigegeben'});
  let verdict=await verdictFor(shift.id,employee.id);
  expect(verdict.status).toBe('ineligible');
  expect(verdict.reasons.map((reason:Row)=>reason.code)).toContain('qualification_evidence_unapproved');
  let assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,409,'Einsatz nach Freigabeentzug');
  expect((await assigned.json()) as Row).toMatchObject({reason_code:'qualification_evidence_unapproved'});

  await approveDocument(document.id);
  expect((await verdictFor(shift.id,employee.id)).status).not.toBe('ineligible');

  const revoke=await admin.context.post(`/api/v1/employees/${employee.id}/qualifications/${assignment.id}/revoke`,{
    headers:admin.headers,data:{reason:`E2E Widerruf Kette ${runId}`},
  });
  await expectStatus(revoke,200,'Qualifikationswiderruf C');
  detail=await qualificationDetail(assignment.id);
  expect(detail).toMatchObject({computed_status:'revoked',status_label:'Widerrufen',issue_code:'revoked'});
  verdict=await verdictFor(shift.id,employee.id);
  expect(verdict.status).toBe('ineligible');
  expect(verdict.reasons.map((reason:Row)=>reason.code)).toContain('qualification_revoked');
  assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,409,'Einsatz nach Widerruf');
  expect((await assigned.json()) as Row).toMatchObject({reason_code:'qualification_revoked'});
});

test('D Mitarbeiteraustritt per Beschäftigungsstatus und Austrittsdatum verhindert den Einsatz',async()=>{
  const employee=await createEmployee('D',{hire_date:dateIn(-90)});
  await assignEmployeeToSite(employee.id,'D',{starts_on:dateIn(-90)});
  const catalog=await createCatalog('D_qualifikation');
  await createQualification(employee.id,catalog,{valid_from:dateIn(-30)});
  const shift=await createShift('D',[catalog.code]);
  expect((await verdictFor(shift.id,employee.id)).status).not.toBe('ineligible');

  await patchEmployee(employee.id,{termination_date:dateIn(1),employment_status:'active'});
  let verdict=await verdictFor(shift.id,employee.id);
  expect(verdict.status).toBe('ineligible');
  expect(verdict.reasons.map((reason:Row)=>reason.code)).toContain('employment_ended');
  let assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,409,'Austrittsdatum vor Schichtende');
  expect((await assigned.json()) as Row).toMatchObject({reason_code:'employment_ended'});

  await patchEmployee(employee.id,{termination_date:dateIn(-1),employment_status:'terminated'});
  verdict=await verdictFor(shift.id,employee.id);
  expect(verdict.status).toBe('ineligible');
  expect(verdict.reasons.map((reason:Row)=>reason.code)).toContain('employment_status');
  assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,409,'Status terminated');
  expect((await assigned.json()) as Row).toMatchObject({reason_code:'employment_status'});
});

test('E Objektanforderungsänderung: neue Pflichtqualifikation wird in Lese- und Schreibweg wirksam',async()=>{
  const employee=await createEmployee('E');
  await assignEmployeeToSite(employee.id,'E');
  const first=await createCatalog('E_alt');
  const second=await createCatalog('E_neu');
  await createQualification(employee.id,first,{valid_from:dateIn(-30)});
  // Die Schicht selbst fordert keine Qualifikation; die Objektanforderung ist die einzige Quelle.
  const shift=await createShift('E',[]);
  const firstRequirement=await createRequirement(first.id,employee.id,'alt');
  let eligibility=await admin.context.get(`/api/v1/sites/${siteId}/shifts/${shift.id}/eligibility`);
  await expectStatus(eligibility,200,'Einsatzfähigkeit E vor Anforderungswechsel');
  let body=(await eligibility.json()) as Row;
  expect(body.required_qualification_codes).toContain(first.code);
  expect(body.required_qualification_codes).not.toContain(second.code);
  expect(body.employees.find((entry:Row)=>entry.employee_id===employee.id)?.status).not.toBe('ineligible');

  await deactivateRequirement(firstRequirement.id);
  await createRequirement(second.id,employee.id,'neu');
  eligibility=await admin.context.get(`/api/v1/sites/${siteId}/shifts/${shift.id}/eligibility`);
  await expectStatus(eligibility,200,'Einsatzfähigkeit E nach Anforderungswechsel');
  body=(await eligibility.json()) as Row;
  expect(body.required_qualification_codes).toContain(second.code);
  expect(body.required_qualification_codes).not.toContain(first.code);
  const verdict=body.employees.find((entry:Row)=>entry.employee_id===employee.id) as Row;
  expect(verdict.status).toBe('ineligible');
  expect(verdict.missing_qualification_codes).toContain(second.code);
  expect(verdict.reasons.map((reason:Row)=>reason.code)).toContain('qualification_missing');
  const assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,409,'Schreibweg E nach Anforderungswechsel');
  expect((await assigned.json()) as Row).toMatchObject({reason_code:'qualification_missing'});
});

test('F Nur freigegebene Dokumente werden zum Nachweis und erlauben den Einsatz (SKIP ohne DMS-Approve-API/Scanner)',async()=>{
  skipUnlessDmsWorkflow();
  const employee=await createEmployee('F');
  await assignEmployeeToSite(employee.id,'F');
  const catalog=await createCatalog('F_nachweis',{
    required:true,required_document_type:evidenceType,required_documents:[evidenceType],
  });
  const {document,version}=await uploadEvidence('F',employee.id);
  await requestReview(document.id);
  const assignment=await createQualification(employee.id,catalog,{document_id:document.id});
  const shift=await createShift('F',[catalog.code]);

  let detail=await qualificationDetail(assignment.id);
  expect(detail).toMatchObject({computed_status:'awaiting_review',document_status:'pruefung_ausstehend'});
  const blockedDownload=await admin.context.get(`/api/v1/qualifications/assignments/${assignment.id}/document`);
  await expectStatus(blockedDownload,409,'Nachweis vor Freigabe darf nicht heruntergeladen werden');
  let verdict=await verdictFor(shift.id,employee.id);
  expect(verdict.status).toBe('ineligible');
  expect(verdict.reasons.map((reason:Row)=>reason.code)).toContain('qualification_evidence_unapproved');
  let assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,409,'Einsatz vor Dokumentfreigabe');
  expect((await assigned.json()) as Row).toMatchObject({reason_code:'qualification_evidence_unapproved'});

  const documents=await admin.context.get('/api/v1/dms/documents',{params:{employee_id:employee.id}});
  await expectStatus(documents,200,'DMS-Liste F');
  let documentRow=((await documents.json()) as Row[]).find(row=>row.id===document.id) as Row|undefined;
  expect(documentRow?.approval_status,'Dokument darf nur über die Approve-API freigegeben werden.').toBe('pending_approval');

  await approveDocument(document.id);
  detail=await qualificationDetail(assignment.id);
  expect(detail).toMatchObject({computed_status:'valid',status_label:'Gültig',document_status:'gueltig'});
  const linkResponse=await admin.context.get(`/api/v1/qualifications/assignments/${assignment.id}/document`);
  await expectStatus(linkResponse,200,'Freigegebener Nachweisschritt');
  const link=(await linkResponse.json()) as Row;
  expect(link.download_url).toBe(`/api/v1/dms/documents/${document.id}/versions/${version.id}/download`);
  const bytes=await admin.context.get(link.download_url);
  await expectStatus(bytes,200,'Download des freigegebenen Nachweises');
  expect(bytes.headers()['content-type']).toContain('text/plain');
  expect(await bytes.text()).toBe(evidenceText);
  const documentsAfter=await admin.context.get('/api/v1/dms/documents',{params:{employee_id:employee.id}});
  documentRow=((await documentsAfter.json()) as Row[]).find(row=>row.id===document.id) as Row|undefined;
  expect(documentRow).toMatchObject({approval_status:'approved',computed_status:'gueltig'});

  verdict=await verdictFor(shift.id,employee.id);
  expect(verdict.status).not.toBe('ineligible');
  expect(verdict.matched_qualification_codes).toContain(catalog.code);
  assigned=await assignToShift(shift.id,employee.id);
  await expectStatus(assigned,201,'Einsatz nach Approve-API');
});

test('RBAC: fachliche Leserolle ohne employees:/qualifications:/dms:/scheduling:write darf keine Kette verändern',async()=>{
  const employee=await createEmployee('RBAC');
  const catalog=await createCatalog('RBAC');
  const qualification=await createQualification(employee.id,catalog);
  const unknown=randomUUID();

  // Lesen ist erlaubt, Schreiben in allen vier Domänen nicht.
  await expectStatus(await viewer.context.get(`/api/v1/employees/${employee.id}/profile`),200,'Viewer darf Mitarbeiter lesen');
  await expectStatus(await viewer.context.get('/api/v1/qualifications/overview'),200,'Viewer darf Qualifikationen lesen');
  await expectStatus(await viewer.context.get('/api/v1/dms/documents'),200,'Viewer darf Dokumente lesen');
  await expectStatus(await viewer.context.get('/api/v1/scheduling/periods'),200,'Viewer darf Dienstpläne lesen');

  const writes:Array<[string,Promise<APIResponse>]>=[
    ['Mitarbeiter anlegen',viewer.context.post('/api/v1/employees',{headers:viewer.headers,data:profilePayload({
      name:`E2E RBAC ${runId}`,email:`${uniqueCode('rbac_mail')}@example.invalid`,
      employment_status:'active',employment_type:'employee',
    },'E2E RBAC')})],
    ['Mitarbeiterprofil ändern',viewer.context.patch(`/api/v1/employees/${employee.id}/profile`,{headers:viewer.headers,data:profilePayload({
      name:`E2E RBAC ${runId}`,email:`${uniqueCode('rbac_patch')}@example.invalid`,
      employment_status:'terminated',employment_type:'employee',
    },'E2E RBAC')})],
    ['Qualifikationskatalog anlegen',viewer.context.post('/api/v1/qualifications/catalog',{headers:viewer.headers,data:{
      code:uniqueCode('rbac_catalog'),name:`E2E RBAC ${runId}`,reason:`E2E RBAC ${runId}`,
    }})],
    ['Qualifikation ändern',viewer.context.patch(`/api/v1/employees/${employee.id}/qualifications/${qualification.id}`,{
      headers:viewer.headers,data:{notes:`E2E RBAC ${runId}`,reason:`E2E RBAC ${runId}`},
    })],
    ['DMS-Dokument hochladen',viewer.context.post('/api/v1/dms/documents',{headers:viewer.headers,data:{
      title:`E2E RBAC ${runId}`,site_id:siteId,content_base64:evidenceBase64,content_type:'text/plain',
      client_mutation_id:randomUUID(),
    }})],
    ['DMS-Freigabe erteilen',viewer.context.post(`/api/v1/dms/documents/${unknown}/approve`,{headers:viewer.headers,data:{}})],
    ['Dienstplanzeitraum anlegen',viewer.context.post('/api/v1/scheduling/periods',{headers:viewer.headers,data:{
      site_id:siteId,rule_profile_id:ruleProfileId,name:`E2E RBAC ${runId}`,
      starts_at:isoIn(0),ends_at:isoIn(30),client_mutation_id:randomUUID(),
    }})],
    ['Schichtzuweisung schreiben',viewer.context.post(`/api/v1/scheduling/shifts/${unknown}/assignments`,{
      headers:viewer.headers,data:{employee_id:employee.id,client_mutation_id:randomUUID()},
    })],
    ['Objektanforderung schreiben',viewer.context.post(`/api/v1/sites/${siteId}/qualification-requirements`,{
      headers:viewer.headers,data:{catalog_id:catalog.id,reason:`E2E RBAC ${runId}`},
    })],
  ];
  for(const [label,promise] of writes){
    const response=await promise;
    await expectStatus(response,403,`RBAC ${label}`);
  }
  const unchanged=await qualificationDetail(qualification.id);
  expect(unchanged).toMatchObject({id:qualification.id,code:catalog.code,status:'valid'});
  expect(viewPermissions()).toEqual(expect.arrayContaining([
    'employees:read','qualifications:read','dms:read','scheduling:read',
  ]));
});

test('Mandantentrennung: fremder Mandant sieht Employee, Qualifikation, Dokument und Schicht nicht',async()=>{
  const employee=await createEmployee('MANDANT');
  await assignEmployeeToSite(employee.id,'MANDANT');
  const catalog=await createCatalog('MANDANT');
  const qualification=await createQualification(employee.id,catalog);
  const shift=await createShift('MANDANT',[catalog.code]);
  let document:Row|undefined;
  let version:Row|undefined;
  if(capabilities.dmsApproveApi&&capabilities.dmsReady){
    const uploaded=await uploadEvidence('MANDANT',employee.id);
    await requestReview(uploaded.document.id);
    await approveDocument(uploaded.document.id);
    document=uploaded.document;
    version=uploaded.version;
  }

  // Der Fremdtenant darf weder lesen …
  await expectStatus(await foreign.context.get(`/api/v1/employees/${employee.id}/profile`),404,'Cross-Tenant Employee lesen');
  await expectStatus(await foreign.context.get(`/api/v1/qualifications/assignments/${qualification.id}`),404,'Cross-Tenant Qualifikation lesen');
  await expectStatus(await foreign.context.get(`/api/v1/qualifications/catalog/${catalog.id}`),404,'Cross-Tenant Katalog lesen');
  await expectStatusIn(await foreign.context.get(`/api/v1/sites/${siteId}/shifts/${shift.id}/eligibility`),[403,404],'Cross-Tenant Einsatzprüfung lesen');
  const foreignDocuments=await foreign.context.get('/api/v1/dms/documents',{params:{employee_id:employee.id}});
  await expectStatus(foreignDocuments,200,'Cross-Tenant DMS-Liste');
  expect((await foreignDocuments.json() as Row[]).map(row=>row.id)).not.toContain(document?.id??unknownDocumentSentinel());
  if(document&&version){
    await expectStatus(await foreign.context.get(
      `/api/v1/dms/documents/${document.id}/versions/${version.id}/download`),404,'Cross-Tenant Nachweis lesen');
  }

  // … noch schreiben (alle Writes laufen gegen Datensätze des Fixture-Tenants).
  const employeeWrite=await foreign.context.patch(`/api/v1/employees/${employee.id}/profile`,{headers:foreign.headers,data:profilePayload({
    name:`E2E Cross-Tenant ${runId}`,email:`${uniqueCode('cross_mail')}@example.invalid`,
    employment_status:'terminated',employment_type:'employee',
  },`E2E Cross-Tenant ${runId}`)});
  await expectStatus(employeeWrite,404,'Cross-Tenant Employee schreiben');
  const qualificationWrite=await foreign.context.post(`/api/v1/employees/${employee.id}/qualifications`,{headers:foreign.headers,data:{
    catalog_id:catalog.id,valid_from:dateIn(0),reason:`E2E Cross-Tenant ${runId}`,
  }});
  await expectStatus(qualificationWrite,404,'Cross-Tenant Qualifikation schreiben');
  const shiftWrite=await foreign.context.post(`/api/v1/scheduling/shifts/${shift.id}/assignments`,{headers:foreign.headers,data:{
    employee_id:employee.id,client_mutation_id:randomUUID(),
  }});
  await expectStatusIn(shiftWrite,[403,404],'Cross-Tenant Schicht schreiben');
  if(document){
    await expectStatus(await foreign.context.post(`/api/v1/dms/documents/${document.id}/approve`,{
      headers:foreign.headers,data:{feedback:`E2E Cross-Tenant ${runId}`},
    }),404,'Cross-Tenant Dokument freigeben');
  }

  const ownProfile=await admin.context.get(`/api/v1/employees/${employee.id}/profile`);
  await expectStatus(ownProfile,200,'Eigener Tenant bleibt unberührt');
  const ownEmployee=((await ownProfile.json()) as Row).employee as Row;
  expect(ownEmployee.employment_status).toBe('active');
});

function unknownDocumentSentinel():string{
  return '00000000-0000-4000-8000-000000000000';
}
