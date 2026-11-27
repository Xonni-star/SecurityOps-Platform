import {randomUUID} from 'node:crypto';
import {expect,test,type APIRequestContext,type Page} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;
const apiBase=process.env.E2E_API_BASE_URL??'http://localhost:3000';
const siteId='00000000-0000-4000-8000-000000000103';
const employeeId='00000000-0000-4000-8000-000000000104';
const suffix=randomUUID().slice(0,8);
const identifier=`e2e-nfc-life-${suffix}`;
const replacementIdentifier=`e2e-nfc-life-repl-${suffix}`;
const createdDeviceIds:string[]=[];

test.skip(!email||!password,'Set isolated E2E_EMAIL and E2E_PASSWORD to run the NFC lifecycle browser test.');

test.beforeAll(async({request})=>{
  const ready=await request.get(`${apiBase}/ready`);
  if(!ready.ok())throw new Error(`NFC E2E backend is not ready (${ready.status()}).`);
});

test.afterAll(async({request})=>{
  const session=await loginApi(request,email!,password!);
  for(const id of createdDeviceIds){
    const response=await session.context.delete(`${apiBase}/api/v1/nfc-devices/${id}`,{headers:session.headers});
    if(!response.ok()&&response.status()!==404&&response.status()!==409){
      throw new Error(`Cleanup of NFC test device ${id} failed with ${response.status()}.`);
    }
  }
});

async function csrfHeaders(context:APIRequestContext){
  const token=(await context.storageState()).cookies.find(cookie=>cookie.name==='securityops_csrf')?.value;
  if(!token)throw new Error('API E2E session did not receive a CSRF cookie.');
  return {'x-csrf-token':decodeURIComponent(token)};
}

async function loginApi(context:APIRequestContext,userEmail:string,userPassword:string){
  const response=await context.post(`${apiBase}/api/v1/auth/login`,{data:{
    email:userEmail,password:userPassword,device_id:randomUUID(),
    metadata:{platform:'playwright-api',app_version:'e2e'},
  }});
  expect(response.status()).toBe(200);
  return {context,headers:await csrfHeaders(context)};
}

async function login(page:Page){
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email!);
  await page.getByLabel('Passwort').fill(password!);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await expect(page).toHaveURL(/\/$/);
}

function watchErrors(page:Page){
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(`pageerror: ${error.message}`));
  page.on('console',message=>{if(message.type()==='error')errors.push(`console: ${message.text()}`);});
  page.on('response',response=>{
    if(response.status()>=500)errors.push(`http ${response.status()}: ${response.url()}`);
  });
  return errors;
}

function expectNoErrors(errors:string[],allowed:RegExp[]=[]){
  const relevant=errors.filter(error=>!allowed.some(pattern=>pattern.test(error)));
  expect(relevant,{message:`Unerwartete Browser-/Netzwerkfehler: ${relevant.join(' | ')}`}).toEqual([]);
}

const viewports=[{width:1440,height:900},{width:820,height:1100},{width:390,height:844}];

for(const viewport of viewports){
  test(`NFC overview and device file work without overflow at ${viewport.width}px`,async({page})=>{
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const errors=watchErrors(page);
    await login(page);
    const headers=await csrfHeaders(page.request);
    const created=await page.request.post(`${apiBase}/api/v1/nfc-devices`,{headers,data:{
      identifier:`e2e-viewport-${suffix}-${viewport.width}`,device_type:'tag',manufacturer:'E2E Acme',
    }});
    expect(created.status()).toBe(201);
    const viewportDevice=await created.json() as {id:string;identifier:string};
    createdDeviceIds.push(viewportDevice.id);

    const inventory=await page.request.get(`${apiBase}/api/v1/nfc-devices/inventory?pageSize=1`);
    expect(inventory.status()).toBe(200);

    await page.goto('/nfc-devices');
    await expect(page.getByRole('heading',{name:'NFC-Geräteverwaltung'})).toBeVisible();
    await expect(page.getByRole('button',{name:'NFC-Gerät registrieren'})).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    let overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
    expect(overflow,{message:`Horizontaler Overflow in der Übersicht bei ${viewport.width}px`}).toBe(false);

    await page.getByRole('button',{name:/Archiviert/}).click();
    await expect(page.getByLabel('Archivierung')).toHaveValue('true');
    await page.getByRole('button',{name:'Filter zurücksetzen'}).click();
    await expect(page.getByLabel('Archivierung')).toHaveValue('');

    await page.goto(`/nfc-devices/${viewportDevice.id}`);
    await expect(page.getByRole('heading',{name:viewportDevice.identifier})).toBeVisible();
    await expect(page.getByRole('tab',{name:'Scan-Historie'})).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading',{name:viewportDevice.identifier})).toBeVisible();

    await page.getByRole('tab',{name:'Scan-Historie'}).click();
    await expect(page.getByRole('columnheader',{name:'NFC-Kennung'})).toBeVisible();
    await expect(page.getByRole('columnheader',{name:'Authentifizierung'})).toBeVisible();
    await expect(page.getByRole('columnheader',{name:'Ergebnis / Grund'})).toBeVisible();
    await expect(page.getByLabel('Ergebnis filtern')).toBeVisible();
    await expect(page.getByRole('button',{name:'Weiter →'})).toBeVisible();
    overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
    expect(overflow,{message:`Horizontaler Overflow in der Geräteakte bei ${viewport.width}px`}).toBe(false);
    expectNoErrors(errors);
  });
}

test('complete NFC lifecycle with audited steps, master-data separation and role checks',async({page})=>{
  test.setTimeout(180_000);
  const errors=watchErrors(page);

  // 1. Registrierung über die Oberfläche
  await login(page);
  const session={context:page.request,headers:await csrfHeaders(page.request)};
  const api=(path:string,data?:Record<string,unknown>,method='POST')=>session.context.fetch(`${apiBase}/api/v1${path}`,{
    method,headers:session.headers,...(data?{data}:{}),
  });
  await page.goto('/nfc-devices');
  await page.getByRole('button',{name:'NFC-Gerät registrieren'}).click();
  const create=page.getByRole('dialog');
  await create.getByLabel(/NFC-Kennung/).fill(identifier);
  await create.getByLabel(/Hersteller/).fill('E2E Acme');
  await create.getByRole('button',{name:'Speichern'}).click();
  await expect(page.getByText('NFC-Gerät wurde registriert.')).toBeVisible();
  const response=await api(`/nfc-devices/inventory?q=${encodeURIComponent(identifier)}`,undefined,'GET');
  expect(response.status()).toBe(200);
  const created=(await response.json()).rows?.[0] as {id:string;identifier:string;status:string}|undefined;
  expect(created?.identifier).toBe(identifier);
  expect(created?.status).toBe('active');
  const deviceId=created!.id;
  createdDeviceIds.push(deviceId);

  // 2. Mitarbeiterzuordnung
  expect((await api(`/nfc-devices/${deviceId}/assign`,{employee_id:employeeId,reason:'E2E Mitarbeiterzuordnung'})).status()).toBe(200);
  // 3. Objektzuordnung
  expect((await api(`/nfc-devices/${deviceId}/assign`,{site_id:siteId,reason:'E2E Objektzuordnung'})).status()).toBe(200);
  // 4. Kontrollpunktzuordnung und Eindeutigkeit
  const pointsResponse=await api('/control-points',undefined,'GET');
  expect(pointsResponse.status()).toBe(200);
  const points=await pointsResponse.json() as {site_id:string;sequence:number}[];
  const sequence=Math.max(0,...points.filter(point=>point.site_id===siteId).map(point=>point.sequence))+1;
  const controlPoint=await api('/control-points',{site_id:siteId,name:`E2E Punkt ${suffix}`,nfc_uid:`E2E-CP-${suffix}`,sequence});
  expect(controlPoint.status()).toBe(201);
  const controlPointId=(await controlPoint.json()).id as string;
  expect((await api(`/nfc-devices/${deviceId}/assign`,{control_point_id:controlPointId,reason:'E2E Kontrollpunktzuordnung'})).status()).toBe(200);
  // Statusregeln dürfen nicht über einen anderen Endpunkt umgangen werden.
  const directReplace=await api(`/nfc-devices/${deviceId}/replace`,{
    identifier:`e2e-nfc-direct-${suffix}`,device_type:'tag',manufacturer:'E2E Acme',reason:'E2E Umgehung',copy_assignment:false,
  });
  expect(directReplace.status()).toBe(409);
  expect(await directReplace.text()).toContain('aktives NFC-Gerät');
  expect((await api(`/nfc-devices/${deviceId}`,{status:'blocked',reason:'E2E Umgehung'},'PATCH')).status()).toBe(400);
  const second=await api('/nfc-devices',{identifier:`e2e-nfc-second-${suffix}`,device_type:'tag',manufacturer:'E2E Acme'});
  expect(second.status()).toBe(201);
  const secondId=(await second.json()).id as string;
  createdDeviceIds.push(secondId);
  expect((await api(`/nfc-devices/${secondId}/assign`,{control_point_id:controlPointId,reason:'E2E Konflikt'})).status()).toBe(409);

  await page.goto(`/nfc-devices/${deviceId}`);
  await expect(page.getByRole('heading',{name:identifier})).toBeVisible();

  // 5. Stammdaten getrennt von der Zuordnung speichern und neu laden
  await page.getByRole('tab',{name:'Technische Stammdaten'}).click();
  await expect(page.getByText(/ausschließlich die technischen Eigenschaften/)).toBeVisible();
  await expect(page.getByLabel('Zuordnung',{exact:true})).toHaveCount(0);
  await page.getByLabel('Modell').fill('E2E Modell');
  await page.getByLabel('Seriennummer').fill('E2E-SN-1');
  await page.getByLabel('Beschreibung').fill('E2E Beschreibung');
  await page.getByLabel('Interne Notizen').fill('E2E Notiz');
  await page.getByRole('button',{name:'Speichern'}).click();
  await expect(page.getByText('Stammdaten wurden gespeichert.')).toBeVisible();
  await page.reload();
  await page.getByRole('tab',{name:'Technische Stammdaten'}).click();
  await expect(page.getByLabel('Modell')).toHaveValue('E2E Modell');
  await expect(page.getByLabel('Seriennummer')).toHaveValue('E2E-SN-1');
  await expect(page.getByLabel('Beschreibung')).toHaveValue('E2E Beschreibung');
  await expect(page.getByLabel('Interne Notizen')).toHaveValue('E2E Notiz');

  // 6. Zuordnung über die Geräteakte speichern und neu laden
  await page.getByRole('tab',{name:'Zuordnung'}).click();
  await page.getByLabel('Zuordnung',{exact:true}).selectOption('employee');
  await page.getByLabel('Mitarbeiter',{exact:true}).selectOption(employeeId);
  await page.getByLabel('Änderungsgrund').fill('E2E Zuordnung in der Geräteakte');
  await page.getByRole('button',{name:'Zuordnung speichern'}).click();
  await expect(page.getByText('Zuordnung wurde gespeichert.')).toBeVisible();
  await page.reload();
  await page.getByRole('tab',{name:'Zuordnung'}).click();
  await expect(page.getByLabel('Mitarbeiter',{exact:true})).toHaveValue(employeeId);

  // 7. Sperren mit Begründung
  await page.getByRole('button',{name:'Sperren'}).click();
  await page.getByRole('dialog').getByLabel(/Begründung/).fill('E2E Sperrung');
  await page.getByRole('dialog').getByRole('button',{name:'Sperren'}).click();
  await expect(page.getByText('NFC-Gerät wurde gesperrt.')).toBeVisible();
  expect((await session.context.get(`${apiBase}/api/v1/nfc-devices/${deviceId}/file`)).ok()).toBeTruthy();

  // 6. Reaktivierung nur über den kontrollierten Workflow
  await page.getByRole('button',{name:'Reaktivieren'}).click();
  await page.getByRole('dialog').getByLabel(/Begründung/).fill('E2E Freigabe nach Prüfung');
  await page.getByRole('dialog').getByRole('button',{name:'Reaktivieren'}).click();
  await expect(page.getByText('NFC-Gerät wurde reaktiviert.')).toBeVisible();

  // 7. Verlust melden
  await page.getByRole('button',{name:'Verlust melden'}).click();
  await page.getByRole('dialog').getByLabel(/Begründung/).fill('E2E Verlust');
  await page.getByRole('dialog').getByRole('button',{name:'Verlust melden'}).click();
  await expect(page.getByText('Verlust wurde dokumentiert.')).toBeVisible();
  // Verlorene Geräte dürfen weder direkt reaktiviert noch direkt gesperrt werden.
  expect((await api(`/nfc-devices/${deviceId}/reactivate`,{reason:'E2E unzulässig'})).status()).toBe(409);
  expect((await api(`/nfc-devices/${deviceId}/block`,{reason:'E2E unzulässig'})).status()).toBe(409);

  // 8. Wiederauffinden führt zunächst in Quarantäne
  await page.getByRole('button',{name:'Wieder in Betrieb nehmen'}).click();
  const recover=page.getByRole('dialog');
  await recover.getByLabel(/Bestätigte NFC-Kennung/).fill(identifier);
  await recover.getByLabel(/Identität und Zuordnung/).check();
  await recover.getByLabel(/Begründung/).fill('E2E Wiederauffinden geprüft');
  await recover.getByRole('button',{name:'Wieder in Betrieb nehmen'}).click();
  await expect(page.getByText('Gerät wurde zunächst in Quarantäne gesperrt.')).toBeVisible();

  // 9. Freigabe aus der Quarantäne mit Begründung
  await page.getByRole('button',{name:'Reaktivieren'}).click();
  await page.getByRole('dialog').getByLabel(/Begründung/).fill('E2E Quarantäne freigegeben');
  await page.getByRole('dialog').getByRole('button',{name:'Reaktivieren'}).click();
  await expect(page.getByText('NFC-Gerät wurde reaktiviert.')).toBeVisible();

  // 10. Austausch mit neuem Gerät und Zuordnungsübernahme
  await page.getByRole('button',{name:'Sperren'}).click();
  await page.getByRole('dialog').getByLabel(/Begründung/).fill('E2E Ersatz vorbereiten');
  await page.getByRole('dialog').getByRole('button',{name:'Sperren'}).click();
  await expect(page.getByText('NFC-Gerät wurde gesperrt.')).toBeVisible();
  await page.getByRole('button',{name:'Ersatzgerät festlegen'}).click();
  const replace=page.getByRole('dialog');
  await expect(replace.getByText(/Zusammenfassung vor dem Austausch/)).toBeVisible();
  await expect(replace.getByText(/Altes Gerät \(Kennung · Status · bisherige Zuordnung\)/)).toBeVisible();
  await replace.getByLabel(/NFC-Kennung des Ersatzgeräts/).fill(replacementIdentifier);
  await replace.getByLabel(/Hersteller/).fill('E2E Ersatz Acme');
  await replace.getByLabel(/Austauschgrund/).fill('E2E Defekt');
  await replace.getByLabel('Zuordnung übernehmen').check();
  await expect(replace.getByText(/Übernahmeentscheidung/)).toBeVisible();
  await replace.getByLabel(/bestätige den Austausch/).check();
  await replace.getByRole('button',{name:'Austausch durchführen'}).click();
  await expect(page.getByText('Austausch wurde dokumentiert.')).toBeVisible();
  const replacementFile=await session.context.get(`${apiBase}/api/v1/nfc-devices/${deviceId}/file`);
  expect(replacementFile.status()).toBe(200);
  const replacementData=await replacementFile.json() as {device:{status:string};replacements:{new_device_id:string}[]};
  expect(replacementData.device.status).toBe('replaced');
  const replacementId=replacementData.replacements?.[0]?.new_device_id;
  expect(replacementId).toBeTruthy();
  createdDeviceIds.push(replacementId!);

  // 11. Ersetztes Gerät bleibt dauerhaft außer Betrieb
  await expect(page.getByRole('button',{name:'Ersatzgerät festlegen'})).toHaveCount(0);
  expect((await api(`/nfc-devices/${deviceId}/reactivate`,{reason:'E2E unzulässig'})).status()).toBe(409);
  expect((await api(`/nfc-devices/${deviceId}/assign`,{employee_id:employeeId,reason:'E2E unzulässig'})).status()).toBe(409);
  expect((await api(`/nfc-devices/${deviceId}`,{employee_id:employeeId,reason:'E2E Umgehung'},'PATCH')).status()).toBe(409);
  expect((await api(`/nfc-devices/${deviceId}/replace`,{
    identifier:`e2e-nfc-life-again-${suffix}`,device_type:'tag',manufacturer:'E2E Acme',reason:'E2E unzulässig',copy_assignment:false,
  })).status()).toBe(409);

  // 12. Archivierung des Ersatzgeräts erhält die Historie
  await page.goto(`/nfc-devices/${replacementId}`);
  await page.getByRole('button',{name:'Archivieren'}).click();
  await page.getByRole('dialog').getByLabel(/Begründung/).fill('E2E Archivierung');
  await page.getByRole('dialog').getByRole('button',{name:'Archivieren'}).click();
  await expect(page.getByText('NFC-Gerät wurde archiviert.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Ersatzgerät festlegen'})).toHaveCount(0);
  expect((await api(`/nfc-devices/${replacementId}/assign`,{employee_id:employeeId,reason:'E2E unzulässig'})).status()).toBe(409);
  expect((await api(`/nfc-devices/${replacementId}/replace`,{
    identifier:`e2e-nfc-life-archived-${suffix}`,device_type:'tag',manufacturer:'E2E Acme',reason:'E2E unzulässig',copy_assignment:false,
  })).status()).toBe(409);
  const oldFile=await session.context.get(`${apiBase}/api/v1/nfc-devices/${deviceId}/file`);
  expect(oldFile.status()).toBe(200);
  const oldData=await oldFile.json() as {device:{status:string};assignment_history:unknown[];replacements:unknown[];
    history:{event_type:string}[]};
  expect(oldData.device.status).toBe('replaced');
  expect(oldData.assignment_history.length).toBeGreaterThan(0);
  expect(oldData.replacements.length).toBeGreaterThan(0);
  expect(oldData.history.map(entry=>entry.event_type)).toContain('nfc_device.replaced');
  const archivedFile=await session.context.get(`${apiBase}/api/v1/nfc-devices/${replacementId}/file`);
  const archivedData=await archivedFile.json() as {history:{event_type:string}[]};
  expect(archivedData.history.map(entry=>entry.event_type)).toContain('nfc_device.archived');

  // 13. Rollenprüfung: Viewer ohne Mutation, Operator mit Zugriff
  const viewer=await loginApi(page.request,'e2e-viewer@example.invalid',password!);
  expect((await viewer.context.get(`${apiBase}/api/v1/nfc-devices/inventory`)).status()).toBe(200);
  expect((await viewer.context.post(`${apiBase}/api/v1/nfc-devices/${deviceId}/block`,
    {headers:viewer.headers,data:{reason:'E2E unzulässig'}})).status()).toBe(403);
  const author=await loginApi(page.request,'e2e-author@example.invalid',password!);
  expect((await author.context.get(`${apiBase}/api/v1/nfc-devices/inventory`)).status()).toBe(200);
  expect((await session.context.get(`${apiBase}/api/v1/nfc-devices/${deviceId}/file`)).status()).toBe(200);
  expectNoErrors(errors);
});
