import {expect,test} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;
const apiBase=process.env.E2E_API_BASE_URL??'http://127.0.0.1:3000';
const siteId='00000000-0000-4000-8000-000000000103';
const employeeId='00000000-0000-4000-8000-000000000104';

test.skip(!email||!password,'Set isolated E2E_EMAIL and E2E_PASSWORD to run real object-management browser tests.');

test.beforeAll(async({request})=>{
  const ready=await request.get(`${apiBase}/ready`);
  if(!ready.ok())throw new Error(`Object-management E2E backend is not ready (${ready.status()}).`);
});

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

test('real API and browser flows manage the digital object file',async({page})=>{
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
  await page.getByPlaceholder('Bezeichnung').fill(`Gebäude ${suffix}`);
  await page.getByPlaceholder('Code').fill(`G-${suffix}`);
  await page.getByRole('button',{name:'Struktur anlegen'}).click();
  await expect(page.getByRole('listitem').filter({hasText:new RegExp(`Gebäude ${suffix}`)})).toBeVisible();
  await page.getByPlaceholder('Bezeichnung').fill(`Zone ${suffix}`);
  await page.getByRole('combobox',{name:'Strukturtyp'}).selectOption('zone');
  await page.getByRole('combobox',{name:'Übergeordnete Struktur'}).selectOption({label:`Gebäude ${suffix}`});
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
  await expect(page.getByText(new RegExp(`E2E Gefährdung ${suffix} · Risiko 12`))).toBeVisible();

  await page.getByRole('button',{name:'Dienstanweisungen'}).click();
  await expect(page).toHaveURL(new RegExp(`/sites/${siteId}/anweisungen$`));
  const instructionTitle=page.getByRole('textbox',{name:'Titel'});
  await instructionTitle.fill(`E2E Anweisung ${suffix}`);
  await expect(instructionTitle).toHaveValue(`E2E Anweisung ${suffix}`);
  await page.getByLabel('Inhalt').fill('Dokumentierter Ablauf für den E2E-Test.');
  await page.getByLabel('Anweisungsbereich').selectOption({label:`Zone ${suffix}`});
  await page.getByLabel('Anweisungsstatus').selectOption('approved');
  await page.getByLabel('Kenntnisnahme erforderlich').check();
  const instructionResponse=page.waitForResponse(response=>response.url().includes(`/sites/${siteId}/instructions`)&&response.request().method()==='POST',{timeout:10000});
  await page.getByRole('button',{name:'Anweisung speichern'}).click();
  expect((await instructionResponse).status()).toBe(201);
  const instructionItem=page.getByRole('listitem').filter({hasText:`E2E Anweisung ${suffix} v1`});
  await expect(instructionItem).toBeVisible();
  await page.getByLabel('Mitarbeiter für Kenntnisnahme').selectOption(employeeId);
  const acknowledgementResponse=page.waitForResponse(response=>response.url().includes('/acknowledgements')&&response.request().method()==='POST');
  await instructionItem.getByRole('button',{name:'Kenntnisnahme erfassen'}).click();
  expect((await acknowledgementResponse).status()).toBe(201);
  await expect(page.getByText(/Kenntnisnahmen: 1/)).toBeVisible();
});
