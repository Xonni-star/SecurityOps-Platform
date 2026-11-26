import {expect,test,type Page} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;
const apiBase=process.env.E2E_API_BASE_URL??'http://127.0.0.1:3000';

test.skip(!email||!password,'Set isolated E2E_EMAIL and E2E_PASSWORD to run real customer cockpit browser tests.');

test.beforeAll(async({request})=>{
  const ready=await request.get(`${apiBase}/ready`);
  if(!ready.ok())throw new Error(`Customer cockpit E2E backend is not ready (${ready.status()}).`);
});

function dateIn(days:number){
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}

async function login(page:Page,userEmail:string){
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(userEmail);
  await page.getByLabel('Passwort').fill(password!);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await expect(page).toHaveURL(/\/$/);
}

async function csrf(page:Page){
  const token=(await page.context().cookies()).find(cookie=>cookie.name==='securityops_csrf')?.value;
  if(!token)throw new Error('Authenticated E2E session did not receive a CSRF cookie.');
  return {'x-csrf-token':decodeURIComponent(token)};
}

test('complete CRM workflow: cockpit, filters, file, tasks, export, bulk action and restricted user',async({page})=>{
  test.setTimeout(90_000);
  await login(page,email!);
  const headers=await csrf(page);
  const identity=await page.request.get(`${apiBase}/api/v1/auth/me`);
  const {user}=await identity.json();
  expect(user.permissions).toContain('customers:write');
  expect(user.permissions).toContain('customers:export');
  expect(user.permissions).toContain('customer_tasks:write');

  const suffix=Date.now();
  const customerName=`E2E CRM Kunde ${suffix}`;
  const created=await page.request.post(`${apiBase}/api/v1/customers`,{headers,data:{
    name:customerName,customer_number:`CRM-${suffix}`,customer_status:'active',priority:'critical',risk_classification:'critical',
    email:`crm-${suffix}@example.invalid`,city:'Hamburg',phone:'040 987654',address_line1:'Teststraße 1',
  }});
  expect(created.status()).toBe(201);
  const customer=await created.json();
  const contract=await page.request.post(`${apiBase}/api/v1/customers/${customer.id}/contracts`,{headers,data:{
    contract_number:`CRM-V-${suffix}`,contract_type:'Objektschutz',starts_on:dateIn(-30),ends_on:dateIn(10),status:'active',
    renewal_type:'automatic',notice_period_days:14,next_termination_date:dateIn(20),
  }});
  expect(contract.status()).toBe(201);
  const contact=await page.request.post(`${apiBase}/api/v1/customers/${customer.id}/contacts`,{headers,data:{
    first_name:'Mira',last_name:'Entscheider',email:`mira-${suffix}@example.invalid`,is_primary:true,is_decision_maker:true,is_security_contact:true,
  }});
  expect(contact.status()).toBe(201);
  const task=await page.request.post(`${apiBase}/api/v1/customers/${customer.id}/tasks`,{headers,data:{
    title:`E2E Wiedervorlage ${suffix}`,due_at:new Date(Date.now()-3_600_000).toISOString(),priority:'critical',
  }});
  expect(task.status()).toBe(201);
  const taskRow=await task.json();

  await page.goto('/customers');
  await expect(page.getByRole('heading',{name:'Kundenverwaltung'})).toBeVisible();
  const board=page.getByRole('region',{name:'Handlungsübersicht'});
  await expect(board).toBeVisible();
  for(const bucket of ['A ·','B ·','C ·'])await expect(board.getByRole('heading',{name:new RegExp(bucket)})).toBeVisible();
  await expect(board.getByRole('link').first()).toBeVisible();
  const actionResponse=await page.request.get(`${apiBase}/api/v1/customers/action-list`);
  expect(actionResponse.status()).toBe(200);
  const actionList=await actionResponse.json();
  const actionIds=[...actionList.A,...actionList.B,...actionList.C].map((entry:{id:string})=>entry.id);
  expect(actionIds.length).toBeGreaterThan(0);
  expect(new Set(actionIds).size).toBe(actionIds.length);
  expect(Number.isNaN(Date.parse(actionList.generated_at))).toBe(false);

  const listRequest=page.waitForRequest(request=>{
    const url=new URL(request.url());
    return url.pathname==='/api/v1/customers'&&url.searchParams.get('q')===customerName;
  });
  await page.getByPlaceholder(/Kunde, Nummer/).fill(customerName);
  expect(new URL((await listRequest).url()).searchParams.has('q')).toBe(true);
  await expect(page.getByRole('row').filter({hasText:customerName})).toBeVisible();
  const statusRequest=page.waitForRequest(request=>request.url().includes('/api/v1/customers?')&&request.url().includes('customer_status=active'));
  await page.getByLabel('Kundenstatus').selectOption('active');
  expect((await statusRequest).url()).toContain('customer_status=active');
  await expect(page.getByRole('row').filter({hasText:customerName})).toBeVisible();

  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:/Export/}).click();
  expect((await download).suggestedFilename()).toContain('kunden.csv');

  await page.getByRole('row').filter({hasText:customerName}).getByText(customerName,{exact:true}).click();
  await expect(page.getByRole('heading',{name:customerName})).toBeVisible();
  await expect(page.getByText(`CRM-V-${suffix}`).first()).toBeVisible();
  await expect(page.getByText(/Kündigungsfrist|Vertragsfrist/).first()).toBeVisible();

  await page.getByRole('button',{name:'Ansprechpartner'}).click();
  await expect(page.getByText('Mira Entscheider')).toBeVisible();
  await expect(page.getByText(/Entscheider/).first()).toBeVisible();

  await page.getByRole('button',{name:'Aufgaben'}).click();
  const taskItem=page.locator('.customer-task-card').filter({hasText:`E2E Wiedervorlage ${suffix}`});
  await expect(taskItem).toBeVisible();
  await expect(taskItem).toContainText('Priorität: Kritisch');
  const taskPatch=page.waitForResponse(response=>response.url().includes(`/tasks/${taskRow.id}`)&&response.request().method()==='PATCH');
  await taskItem.getByRole('button',{name:'Erledigt'}).click();
  expect((await taskPatch).status()).toBe(200);

  await page.goto('/customers');
  await page.getByPlaceholder(/Kunde, Nummer/).fill(customerName);
  await expect(page.getByRole('row').filter({hasText:customerName})).toBeVisible();
  page.once('dialog',dialog=>void dialog.accept());
  const bulk=page.waitForResponse(response=>response.url().includes('/api/v1/customers/bulk')&&response.request().method()==='POST');
  await page.getByRole('row').filter({hasText:customerName}).getByRole('checkbox').check();
  await page.getByRole('button',{name:/Auswahl archivieren/}).click();
  expect((await bulk).status()).toBe(200);
  const archived=await page.request.get(`${apiBase}/api/v1/customers/${customer.id}/profile`);
  expect((await archived.json()).customer.customer_status).toBe('archived');

  const viewer=await browserNewPage(page);
  await login(viewer,'e2e-viewer@example.invalid');
  const viewerIdentity=await viewer.request.get(`${apiBase}/api/v1/auth/me`);
  const viewerUser=(await viewerIdentity.json()).user;
  expect(viewerUser.role).toBe('viewer');
  expect(viewerUser.permissions).toContain('customers:read');
  expect(viewerUser.permissions).not.toContain('customers:write');
  await viewer.goto('/customers');
  await expect(viewer.getByRole('heading',{name:'Kundenverwaltung'})).toBeVisible();
  await expect(viewer.getByRole('button',{name:/Kunde anlegen/})).toHaveCount(0);
  await expect(viewer.getByRole('button',{name:/Export/})).toHaveCount(0);
  const viewerProfile=await viewer.request.get(`${apiBase}/api/v1/customers/${customer.id}/profile`);
  expect(viewerProfile.status()).toBe(200);
  const viewerWrite=await viewer.request.post(`${apiBase}/api/v1/customers`,{headers:await csrf(viewer),data:{name:'E2E nicht erlaubt'}});
  expect(viewerWrite.status()).toBe(403);
});

async function browserNewPage(page:Page){
  return page.context().browser()!.newPage();
}
