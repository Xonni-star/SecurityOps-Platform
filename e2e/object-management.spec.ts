import {randomUUID} from 'node:crypto';
import {expect,test,type Playwright} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;
const authorEmail=process.env.E2E_AUTHOR_EMAIL??'e2e-author@example.invalid';
const apiBase=process.env.E2E_API_BASE_URL??'http://127.0.0.1:3000';
const siteId='00000000-0000-4000-8000-000000000103';
const employeeId='00000000-0000-4000-8000-000000000104';
const ruleProfileId='00000000-0000-4000-8000-000000000116';
const operationalDeviceId='00000000-0000-4000-8000-000000000117';

test.skip(!email||!password,'Set isolated E2E_EMAIL and E2E_PASSWORD to run real object-management browser tests.');

test.beforeAll(async({request})=>{
  const ready=await request.get(`${apiBase}/ready`);
  if(!ready.ok())throw new Error(`Object-management E2E backend is not ready (${ready.status()}).`);
});

function dateIn(days:number){
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}

function isoIn(days:number,hour=0){
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  date.setUTCHours(hour,0,0,0);
  return date.toISOString();
}

async function login(page:import('@playwright/test').Page){
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email!);
  await page.getByLabel('Passwort').fill(password!);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await expect(page).toHaveURL(/\/$/);
}

async function csrf(page:import('@playwright/test').Page){
  const token=(await page.context().cookies()).find(cookie=>cookie.name==='securityops_csrf')?.value;
  if(!token)throw new Error('Authenticated E2E session did not receive a CSRF cookie.');
  return {'x-csrf-token':decodeURIComponent(token)};
}

async function loginApi(playwright:Playwright,userEmail:string,userPassword:string){
  const context=await playwright.request.newContext({baseURL:process.env.E2E_BASE_URL??'http://127.0.0.1:5173'});
  const response=await context.post('/api/v1/auth/login',{data:{
    email:userEmail,password:userPassword,device_id:randomUUID(),
    metadata:{platform:'playwright-api',app_version:'e2e'},
  }});
  expect(response.status()).toBe(200);
  const token=(await context.cookies()).find(cookie=>cookie.name==='securityops_csrf')?.value;
  if(!token)throw new Error('API E2E session did not receive a CSRF cookie.');
  return {context,headers:{'x-csrf-token':decodeURIComponent(token)}};
}

test('real API and browser flows manage the digital object file',async({page})=>{
  test.setTimeout(60_000);
  await login(page);
  const headers=await csrf(page);
  const identity=await page.request.get('/api/v1/auth/me');
  const {user}=await identity.json();
  expect(user.permissions).toContain('contracts:write');
  expect(user.permissions).toContain('customer_contacts:read');
  const suffix=Date.now();
  const customerResponse=await page.request.post('/api/v1/customers',{headers,data:{name:`E2E Objektkunde ${suffix}`}});
  expect(customerResponse.status()).toBe(201);
  const customer=await customerResponse.json();
  const contractResponse=await page.request.post(`/api/v1/customers/${customer.id}/contracts`,{
    headers,data:{contract_number:`E2E-${suffix}`,contract_type:'Objektschutz',starts_on:'2026-01-01',status:'active'},
  });
  expect(contractResponse.status()).toBe(201);

  await page.goto(`/sites/${siteId}/stammdaten`);
  await expect(page.getByRole('heading',{name:'E2E Leitstellenobjekt'})).toBeVisible();
  await page.getByLabel('Alias').fill(`Objekt-${suffix}`);
  await page.getByLabel('Objektleitung').selectOption(employeeId);
  await page.getByRole('button',{name:'Stammdaten speichern'}).click();
  await expect(page.getByText('Objektleitung: E2E Streife')).toBeVisible();

  await page.getByRole('button',{name:'Kunden & Verträge'}).click();
  await page.getByLabel('Kunde verknüpfen').selectOption(customer.id);
  const customerLink=page.waitForResponse(response=>response.url().includes(`/sites/${siteId}/customer-links`)&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Verknüpfen',exact:true}).click();
  expect((await customerLink).status()).toBe(201);
  await expect(page.getByRole('listitem').filter({hasText:`E2E Objektkunde ${suffix}`})).toBeVisible();
  await page.getByRole('combobox',{name:'Kunde',exact:true}).selectOption(customer.id);
  await page.getByRole('combobox',{name:'Vertrag',exact:true}).selectOption({label:`E2E-${suffix}`});
  const contractLink=page.waitForResponse(response=>response.url().includes(`/customers/${customer.id}/contracts/`)&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Vertrag verknüpfen'}).click();
  expect((await contractLink).status()).toBe(201);
  await expect(page.getByRole('listitem').filter({hasText:new RegExp(`E2E Objektkunde ${suffix}`)}).first()).toBeVisible();
  await expect(page.getByRole('listitem').filter({hasText:`E2E-${suffix}`})).toBeVisible();

  await page.getByRole('button',{name:'Gebäude & Bereiche'}).click();
  await page.getByLabel('Bezeichnung').fill(`Gebäude ${suffix}`);
  await page.getByLabel('Code').fill(`G-${suffix}`);
  await page.getByRole('button',{name:'Struktur anlegen'}).click();
  await expect(page.getByRole('listitem').filter({hasText:new RegExp(`Gebäude ${suffix}`)})).toBeVisible();
  await page.getByLabel('Bezeichnung').fill(`Bereich ${suffix}`);
  await page.getByLabel('Code').fill(`B-${suffix}`);
  await page.getByRole('combobox',{name:'Strukturtyp'}).selectOption('area');
  await page.getByRole('combobox',{name:'Übergeordnete Struktur'}).selectOption({label:`Gebäude ${suffix}`});
  await page.getByRole('button',{name:'Struktur anlegen'}).click();
  await expect(page.getByRole('listitem').filter({hasText:new RegExp(`Bereich ${suffix}`)})).toBeVisible();
  await page.getByLabel('Bezeichnung').fill(`Zone ${suffix}`);
  await page.getByRole('combobox',{name:'Strukturtyp'}).selectOption('zone');
  await page.getByRole('combobox',{name:'Übergeordnete Struktur'}).selectOption({label:`Gebäude ${suffix} / Bereich ${suffix}`});
  await page.getByRole('combobox',{name:'Verantwortliche Person'}).selectOption(employeeId);
  await page.getByRole('button',{name:'Struktur anlegen'}).click();
  await expect(page.getByRole('listitem').filter({hasText:new RegExp(`Zone ${suffix} .* Verantwortlich: E2E Streife`)})).toBeVisible();

  await page.getByRole('button',{name:'Gefährdungen'}).click();
  await page.getByLabel('Titel').fill(`E2E Gefährdung ${suffix}`);
  await page.getByLabel('Beschreibung').fill('Realer Test der Gefährdungserfassung');
  await page.getByLabel('Gefährdungsbereich').selectOption({label:`Zone ${suffix}`});
  await page.getByLabel('Gefährdungsverantwortliche Person').selectOption(employeeId);
  await page.getByLabel('Eintritt').fill('3');
  await page.getByLabel('Auswirkung').fill('4');
  const hazardResponse=page.waitForResponse(response=>response.url().includes(`/sites/${siteId}/hazards`)&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Gefährdung erfassen'}).click();
  expect((await hazardResponse).status()).toBe(201);
  const hazardItem=page.getByRole('listitem').filter({hasText:new RegExp(`E2E Gefährdung ${suffix} · Risiko 12`)});
  await expect(hazardItem).toBeVisible();
  await hazardItem.getByRole('button',{name:'Maßnahme hinzufügen'}).click();
  await page.getByLabel('Maßnahmentitel').fill(`E2E Maßnahme ${suffix}`);
  await page.getByLabel('Maßnahme fällig am').fill('2026-12-01');
  await page.getByLabel('Maßnahmenstatus').selectOption('in_progress');
  const measureResponse=page.waitForResponse(response=>response.url().includes('/measures')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Maßnahme erfassen'}).click();
  expect((await measureResponse).status()).toBe(201);
  await expect(hazardItem.getByText(`E2E Maßnahme ${suffix} · in_progress`)).toBeVisible();

  await page.getByRole('button',{name:'Dienstanweisungen'}).click();
  await expect(page).toHaveURL(new RegExp(`/sites/${siteId}/anweisungen$`));
  await expect(page.getByRole('heading',{name:'Dienstanweisungen'})).toBeVisible();
  const instructionTitle=page.getByRole('textbox',{name:'Titel'});
  await instructionTitle.fill(`E2E Anweisung ${suffix}`);
  await expect(instructionTitle).toHaveValue(`E2E Anweisung ${suffix}`);
  await page.getByLabel('Inhalt').fill('Dokumentierter Ablauf für den E2E-Test.');
  await page.getByLabel('Anweisungsbereich').selectOption({label:`Zone ${suffix}`});
  await page.getByLabel('Anweisungsstatus').selectOption('pending_approval');
  await page.getByLabel('Kenntnisnahme erforderlich').check();
  const instructionResponse=page.waitForResponse(response=>response.url().includes(`/sites/${siteId}/instructions`)&&response.request().method()==='POST',{timeout:10000});
  await page.getByRole('button',{name:'Anweisung speichern'}).click();
  expect((await instructionResponse).status()).toBe(201);
  const instructionItem=page.getByRole('listitem').filter({hasText:`E2E Anweisung ${suffix} v1`});
  await expect(instructionItem).toBeVisible();
  await expect(instructionItem.getByRole('button',{name:'Freigabe erteilen'})).toHaveCount(0);
  await expect(instructionItem.getByText(/Kenntnisnahmen: 0/)).toBeVisible();

  const chronicleResponse=await page.request.get(`/api/v1/sites/${siteId}/chronicle?type=site.hazard.created&limit=100`);
  expect(chronicleResponse.status()).toBe(200);
  const chronicle=await chronicleResponse.json();
  expect(chronicle.events.some((event:any)=>event.event_kind==='site.hazard.created'&&event.link?.label==='Gefährdung öffnen'&&event.link?.target?.includes(`/sites/${siteId}/gefaehrdungen?hazard=`))).toBe(true);
  await page.getByRole('button',{name:'Journal'}).click();
  await expect(page.getByRole('heading',{name:'Serverchronik mit Filtern'})).toBeVisible();
  await page.getByLabel('Chronik von').fill(dateIn(-1));
  const filteredChronicle=page.waitForResponse(response=>response.url().includes('/chronicle?')&&response.request().method()==='GET');
  await page.getByRole('button',{name:'Chronik filtern'}).click();
  expect((await filteredChronicle).status()).toBe(200);
  await expect(page.getByRole('heading',{name:'Serverchronik mit Filtern'})).toBeVisible();
  await page.getByRole('link',{name:'Gefährdung öffnen'}).first().click();
  await expect(page.getByRole('region',{name:'Geöffneter Datensatz'})).toBeVisible();
  await expect(page).toHaveURL(/\/sites\/[^/]+\/gefaehrdungen\?hazard=/);

  await page.goto('/sites');
  const dashboard=page.getByRole('region',{name:'Dringende Aufgaben in allen Objekten'});
  await expect(dashboard).toBeVisible();
  await expect(dashboard.getByRole('link',{name:`Freigabe ausstehend: E2E Anweisung ${suffix}`})).toBeVisible();
  await expect(dashboard.getByRole('link',{name:/Qualifikation prüfen: E2E Streife/})).toBeVisible();
});

test('object overview exposes concrete qualification issues and binding shift eligibility',async({page})=>{
  test.setTimeout(60_000);
  await login(page);
  const headers=await csrf(page);
  const response=await page.request.get(`/api/v1/sites/${siteId}/object-context`);
  expect(response.status()).toBe(200);
  const context:any=await response.json();
  const qualification=context.qualifications.find((entry:any)=>entry.code==='erste_hilfe');
  expect(qualification).toBeTruthy();
  expect(qualification.issue.code).toBe('expiring');
  expect(qualification.evidence_status).toBe('missing');
  expect(qualification.evidence_label).toBe('Kein Nachweis verknüpft');
  expect(qualification.employee_url).toBe(`/employees/${employeeId}/qualifikationen`);
  expect(context.personnelSummary.qualification_issue_count).toBeGreaterThan(0);
  expect(context.personnelSummary.qualification_issues.some((issue:any)=>issue.id===qualification.id)).toBe(true);
  expect(context.priorityActions.length).toBeGreaterThan(0);
  expect(context.priorityActions.every((action:any)=>action.id&&action.title&&action.tab&&action.target&&['A','B','C'].includes(action.priority))).toBe(true);

  const suffix=Date.now();
  const periodResponse=await page.request.post('/api/v1/scheduling/periods',{headers,data:{
    site_id:siteId,rule_profile_id:ruleProfileId,name:`E2E Plan ${suffix}`,
    starts_at:isoIn(0),ends_at:isoIn(60),status:'published',client_mutation_id:randomUUID(),
  }});
  expect([200,201]).toContain(periodResponse.status());
  const period=await periodResponse.json();
  const shiftResponse=await page.request.post(`/api/v1/scheduling/periods/${period.id}/shifts`,{headers,data:{
    site_id:siteId,role_code:'NACHT',starts_at:isoIn(30),ends_at:isoIn(30,8),
    required_qualification_codes:['erste_hilfe'],client_mutation_id:randomUUID(),
  }});
  expect([200,201]).toContain(shiftResponse.status());
  const shift=await shiftResponse.json();
  const eligibilityResponse=await page.request.get(`/api/v1/sites/${siteId}/shifts/${shift.id}/eligibility`);
  expect(eligibilityResponse.status()).toBe(200);
  const eligibility:any=await eligibilityResponse.json();
  expect(eligibility.required_qualification_codes).toContain('erste_hilfe');
  const verdict=eligibility.employees.find((entry:any)=>entry.employee_id===employeeId);
  expect(verdict).toBeTruthy();
  expect(verdict.status).toBe('ineligible');
  expect(verdict.reasons.some((reason:any)=>reason.code==='qualification_expired'||reason.code==='qualification_expiring')).toBe(true);

  await page.goto(`/sites/${siteId}/uebersicht`);
  const priorities=page.getByRole('region',{name:'Nächste Schritte nach Dringlichkeit'});
  await expect(priorities).toBeVisible();
  await expect(priorities.getByText('A – Sofort handeln')).toBeVisible();
  await expect(priorities.getByText('B – Zeitnah bearbeiten')).toBeVisible();
  await expect(priorities.getByText('C – Objektinformationen')).toBeVisible();
  await expect(page.getByRole('region',{name:'Objektinformationen'})).toBeVisible();
  await expect(priorities.getByRole('link').first()).toBeVisible();
  await expect(page.getByRole('heading',{name:'Personalüberblick'})).toBeVisible();
  await expect(page.getByText(/Läuft bald ab/)).toBeVisible();
  await expect(page.locator('.object-qualification-meta').getByText('Kein Nachweis verknüpft')).toBeVisible();
  await expect(page.getByText(/Allgemeine Personalübersicht/)).toBeVisible();
  const evidenceLink=page.getByRole('link',{name:'Nachweis öffnen',exact:true}).first();
  await expect(evidenceLink).toHaveAttribute('href',`/employees/${employeeId}/qualifikationen`);
  await evidenceLink.click();
  await expect(page).toHaveURL(/\/employees\/[^/]+\/qualifikationen$/);
  await expect(page.getByRole('region',{name:'Geöffneter Nachweis'})).toHaveCount(0);
  await page.goto(`/sites/${siteId}/uebersicht`);

  await page.getByRole('button',{name:'Dienstplanung'}).click();
  await expect(page.getByRole('heading',{name:'Dienstplanung und Schichten'})).toBeVisible();
  const shiftItem=page.getByRole('listitem').filter({hasText:`E2E Plan ${suffix}`});
  await expect(shiftItem).toBeVisible();
  await expect(shiftItem.getByText('Verbindliche Einsatzprüfung für diese Schicht')).toBeVisible();
  await expect(shiftItem.getByText('Nicht einsatzfähig')).toBeVisible();
  await expect(shiftItem.getByText(/qualification_expir/)).toBeVisible();
  await expect(shiftItem.getByRole('link',{name:'Nachweis Qualifikation erste_hilfe'})).toHaveAttribute('href',`/employees/${employeeId}/qualifikationen`);
});

test('approvals, acknowledgements, DMS evidence and maintenance lifecycle persist',async({page,playwright})=>{
  test.setTimeout(120_000);
  await login(page);
  const headers=await csrf(page);
  const author=await loginApi(playwright,authorEmail,password!);
  try{
    const suffix=Date.now();
    const instructionTitle=`E2E Freigabe ${suffix}`;
    const instructionResponse=await author.context.post(`/api/v1/sites/${siteId}/instructions`,{headers:author.headers,data:{
      title:instructionTitle,content:'Freigabe- und Kenntnisnahme-Test',status:'pending_approval',version:1,
      requires_acknowledgement:true,location_id:null,valid_from:null,valid_until:null,supersedes_id:null,
    }});
    expect(instructionResponse.status()).toBe(201);
    const instruction=await instructionResponse.json();

    await page.goto(`/sites/${siteId}/anweisungen`);
    await expect(page.getByRole('heading',{name:'Dienstanweisungen'})).toBeVisible();
    const instructionItem=page.getByRole('listitem').filter({hasText:`${instructionTitle} v1`});
    await expect(instructionItem.getByRole('button',{name:'Freigabe erteilen'})).toBeVisible();
    const approvalResponse=page.waitForResponse(response=>response.url().includes(`/instructions/${instruction.id}/approve`)&&response.request().method()==='POST');
    await instructionItem.getByRole('button',{name:'Freigabe erteilen'}).click();
    expect((await approvalResponse).status()).toBe(200);
    await expect(instructionItem).toContainText('approved');
    await page.getByLabel('Mitarbeiter für Kenntnisnahme').selectOption(employeeId);
    const ackResponse=page.waitForResponse(response=>response.url().includes(`/instructions/${instruction.id}/acknowledgements`)&&response.request().method()==='POST');
    await instructionItem.getByRole('button',{name:'Kenntnisnahme erfassen'}).click();
    expect([200,201]).toContain((await ackResponse).status());
    await expect(instructionItem.getByText(/E2E Streife: Bestätigt am/)).toBeVisible();

    const documentTitle=`E2E Nachweis ${suffix}`;
    const documentResponse=await author.context.post('/api/v1/dms/documents',{headers:author.headers,data:{
      title:documentTitle,site_id:siteId,document_type:'e2e_nachweis',
      description:'Freigegebener Nachweis für den Wartungsauftrag',
      valid_from:dateIn(-1),valid_until:dateIn(365),review_on:null,
      content_base64:Buffer.from('E2E DMS approval evidence').toString('base64'),
      content_type:'text/plain',client_mutation_id:randomUUID(),
    }});
    expect(documentResponse.status()).toBe(201);
    const upload=await documentResponse.json();
    const document=upload.document??upload;
    const reviewResponse=await author.context.post(`/api/v1/dms/documents/${document.id}/request-review`,{headers:author.headers,data:{}});
    expect(reviewResponse.status()).toBe(200);

    await page.goto(`/sites/${siteId}/dokumente`);
    await expect(page.getByRole('heading',{name:'Objektdokumente'})).toBeVisible();
    const documentItem=page.getByRole('listitem').filter({hasText:documentTitle});
    await expect(documentItem).toContainText('pending_approval');
    const documentApproval=page.waitForResponse(response=>response.url().includes(`/dms/documents/${document.id}/approve`)&&response.request().method()==='POST');
    await documentItem.getByRole('button',{name:'Freigabe erteilen'}).click();
    expect((await documentApproval).status()).toBe(200);
    await expect(documentItem).toContainText('approved');
    await expect(documentItem).toContainText('Gültig');
    const objectContext:any=await (await page.request.get(`/api/v1/sites/${siteId}/object-context`)).json();
    expect(objectContext.documents.find((entry:any)=>entry.id===document.id)?.computed_status).toBe('gueltig');

    const orderResponse=await page.request.post(`/api/v1/sites/${siteId}/maintenance-orders`,{headers,data:{
      device_id:operationalDeviceId,maintenance_type:'inspection',description:`E2E Wartung ${suffix}`,
      priority_code:'high',due_on:dateIn(-1),status:'planned',responsible_employee_id:employeeId,
    }});
    expect(orderResponse.status()).toBe(201);
    const order=await orderResponse.json();
    const contextWithOrder:any=await (await page.request.get(`/api/v1/sites/${siteId}/object-context`)).json();
    expect(contextWithOrder.priorityActions.some((action:any)=>action.id===`maintenance-${order.id}`&&action.severity==='critical')).toBe(true);

    await page.goto(`/sites/${siteId}/technik`);
    await expect(page.getByRole('heading',{name:'Wartungsaufträge'})).toBeVisible();
    const orderItem=page.getByRole('listitem').filter({hasText:order.order_number});
    await expect(orderItem).toContainText('Überfällig');
    await orderItem.getByRole('button',{name:'In Bearbeitung nehmen'}).click();
    await expect(orderItem).toContainText('In Bearbeitung');
    const linkResponse=page.waitForResponse(response=>response.url().includes(`/maintenance-orders/${order.id}/documents`)&&response.request().method()==='POST');
    await orderItem.getByRole('combobox',{name:`Nachweis für ${order.order_number}`}).selectOption(document.id);
    expect((await linkResponse).status()).toBe(201);
    await expect(orderItem.getByText(new RegExp(`Verknüpfte Nachweise: ${documentTitle} \\(Gültig\\)`))).toBeVisible();
    await orderItem.getByRole('button',{name:'Abschließen'}).click();
    const completionForm=page.locator('form').filter({hasText:'Auftrag abschließen'});
    await completionForm.getByLabel('Durchgeführte Arbeit').fill('Prüfung nach E2E-Plan durchgeführt');
    await completionForm.getByRole('button',{name:'Abschluss erfassen'}).click();
    await expect(orderItem).toContainText('Abgeschlossen');
    await expect(orderItem).toContainText('Durchgeführt: Prüfung nach E2E-Plan durchgeführt');
  }finally{
    await author.context.dispose();
  }
});
