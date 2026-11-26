import {randomUUID} from 'node:crypto';
import {expect,test,type Browser,type Page} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;
const viewerEmail=process.env.E2E_VIEWER_EMAIL??'e2e-viewer@example.invalid';
const apiBase=process.env.E2E_API_BASE_URL??'http://localhost:3000';
const siteId=process.env.E2E_SITE_ID??'00000000-0000-4000-8000-000000000103';
const employeeId=process.env.E2E_EMPLOYEE_ID??'00000000-0000-4000-8000-000000000104';

test.skip(!email||!password,'Set isolated E2E_EMAIL and E2E_PASSWORD to run real key-management browser tests.');

test.beforeAll(async({request})=>{
  const ready=await request.get(`${apiBase}/ready`);
  if(!ready.ok())throw new Error(`Key-management E2E backend is not ready (${ready.status()}).`);
});

function dateTimeIn(days:number){
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  date.setUTCHours(9,0,0,0);
  return date.toISOString().slice(0,16);
}

function isoIn(days:number){
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  date.setUTCHours(9,0,0,0);
  return date.toISOString();
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

test('real API and browser flows manage the key cockpit, files and bundles',async({page,browser}:{page:Page;browser:Browser})=>{
  test.setTimeout(180_000);
  await login(page,email!);
  const headers=await csrf(page);
  const identity=await page.request.get('/api/v1/auth/me');
  expect(identity.status()).toBe(200);
  const {user}=await identity.json();
  for(const permission of ['keys:read','keys:create','keys:update','keys:issue','keys:return','keys:manage','keys:export','keys:view_history','keys:qr:read','keys:inventory:write']){
    expect(user.permissions).toContain(permission);
  }

  const suffix=Date.now();
  const keyCode=`E2E-K-${suffix}`;
  const lossKeyCode=`E2E-L-${suffix}`;
  const bundleKeyCode=`E2E-B-${suffix}`;
  const createKey=async(code:string,label:string)=>{
    const response=await page.request.post('/api/v1/keys',{headers,data:{
      key_code:code,label,key_type:'physical',site_id:siteId,location:'E2E Flur',
      building:'E2E Gebäude',client_mutation_id:randomUUID(),
    }});
    expect(response.status()).toBe(201);
    return response.json() as Promise<{id:string;key_code:string;label:string}>;
  };
  const key=await createKey(keyCode,'E2E Haupteingang');
  const lossKey=await createKey(lossKeyCode,'E2E Verlustschlüssel');
  const bundleKey=await createKey(bundleKeyCode,'E2E Bundschlüssel');

  await page.goto('/keys');
  await expect(page.getByRole('heading',{name:'Schlüsselverwaltung'})).toBeVisible();
  const metrics=page.locator('.key-metrics');
  for(const label of ['Gesamt','Verfügbar','Ausgegeben','Überfällig','Verloren','Kritische Vorgänge'])await expect(metrics.getByText(label)).toBeVisible();
  await page.getByText('Weitere Kennzahlen').click();
  await expect(page.getByText('Ohne Objekt')).toBeVisible();
  const board=page.getByRole('region',{name:'Handlungsübersicht'});
  await expect(board).toBeVisible();
  for(const bucket of ['Sofort handeln','Zeitnah klären','Beobachten'])await expect(board.getByRole('heading',{name:new RegExp(bucket)})).toBeVisible();
  const actionLinks=board.getByRole('link');
  expect(await actionLinks.count()).toBeGreaterThan(0);
  for(const link of await actionLinks.all())expect(new URL(await link.getAttribute('href')??'',page.url()).pathname).toMatch(/^\/keys\//);

  await expect(page.locator('.key-table tbody tr').first()).toBeVisible();
  const searchResponse=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/v1/keys'&&url.searchParams.get('q')===keyCode;
  });
  await page.getByLabel('Schlüssel suchen').fill(keyCode);
  expect((await searchResponse).url()).toContain(`q=${keyCode}`);
  const row=page.getByRole('row').filter({hasText:keyCode});
  await expect(row).toBeVisible();
  await expect(row.getByText('E2E Haupteingang')).toBeVisible();

  const statusRequest=page.waitForRequest(request=>request.url().includes('/api/v1/keys?')&&request.url().includes('status=available'));
  await page.getByLabel('Schlüsselstatus').selectOption('available');
  expect((await statusRequest).url()).toContain('status=available');
  await expect(row).toBeVisible();
  await page.getByLabel('Schlüsselstatus').selectOption('all');

  await row.getByRole('checkbox').check();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:/CSV exportieren \(1\)/}).click();
  const exported=await download;
  expect(exported.suggestedFilename()).toContain('schluessel.csv');

  await page.getByLabel('Schlüssel suchen').fill('');
  await page.goto(`/keys/${key.id}`);
  await expect(page).toHaveURL(new RegExp(`/keys/${key.id}`));
  await expect(page.getByRole('heading',{name:'E2E Haupteingang'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Ausgabe vorbereiten'})).toBeVisible();

  const issue=page.waitForResponse(response=>response.url().includes(`/api/v1/keys/${key.id}/issue`)&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Ausgabe vorbereiten'}).click();
  let dialog=page.getByRole('dialog',{name:/Schlüssel ausgeben/});
  await expect(dialog).toHaveAttribute('aria-modal','true');
  await dialog.getByLabel('Schlüsselhalter').selectOption(employeeId);
  await dialog.getByLabel('Fällig am').fill(dateTimeIn(7));
  await dialog.getByLabel('Grund').fill('E2E Nachschicht');
  await dialog.getByLabel('Bestätigungsname').fill('E2E Streife');
  await dialog.getByRole('button',{name:'Schlüssel ausgeben'}).click();
  expect((await issue).status()).toBe(201);

  const returned=page.waitForResponse(response=>response.url().includes(`/api/v1/keys/${key.id}/return`)&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Rückgabe erfassen'}).click();
  dialog=page.getByRole('dialog',{name:/Rückgabe erfassen/});
  await dialog.getByLabel('Zustand').selectOption('good');
  await dialog.getByLabel('Grund').fill('E2E Schichtende');
  await dialog.getByRole('button',{name:'Rückgabe bestätigen'}).click();
  expect((await returned).status()).toBe(200);

  const history=page.waitForResponse(response=>response.url().includes(`/api/v1/keys/${key.id}/history?`)&&response.request().method()==='GET');
  await page.getByRole('button',{name:'Historie'}).click();
  expect((await history).status()).toBe(200);
  await expect(page.getByText(/Ausgegeben/).first()).toBeVisible();
  await expect(page.getByText(/Zurückgegeben/).first()).toBeVisible();

  await page.getByRole('button',{name:'Standort & Objekt'}).click();
  await expect(page.getByRole('link',{name:'Objektseite öffnen'})).toHaveAttribute('href',`/sites/${siteId}/schluessel?key=${key.id}`);

  const qr=page.waitForResponse(response=>response.url().includes(`/api/v1/keys/${key.id}/qr`)&&response.request().method()==='GET');
  await page.getByRole('button',{name:'QR-Code & Etikett'}).click();
  const qrResponse=await qr;
  expect(qrResponse.status()).toBe(200);
  const {token}=await qrResponse.json();
  await expect(page.getByAltText(/E2E Haupteingang/)).toBeVisible();
  await expect(page.getByText(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))).toHaveCount(0);

  await page.goto(`/keys/${key.id}/qr?ref=${encodeURIComponent(token)}`);
  await expect(page.locator('.key-qr-check-valid')).toContainText('QR-Code gültig');
  const [payloadPart,signaturePart]=token.split('.');
  const tampered=`${payloadPart}.${signaturePart[0]==='A'?'B':'A'}${signaturePart.slice(1)}`;
  await page.goto(`/keys/${key.id}/qr?ref=${encodeURIComponent(tampered)}`);
  await expect(page.locator('.key-qr-check-invalid')).toContainText('QR-Code ist ungültig');

  await page.goto('/keys');
  const fullExport=page.waitForRequest(request=>new URL(request.url()).searchParams.get('full')==='true');
  await page.getByLabel('Vollständig exportieren').check();
  await page.getByRole('button',{name:'CSV exportieren'}).click();
  expect((await fullExport).url()).toContain('/api/v1/keys/export');
  await page.getByLabel('Vollständig exportieren').uncheck();

  const lossSetup=await page.request.post(`/api/v1/keys/${lossKey.id}/issue`,{headers,data:{
    holder_employee_id:employeeId,due_at:isoIn(7),reason:'E2E Verlustvorbereitung',
    confirmation_name:'E2E Streife',client_mutation_id:randomUUID(),
  }});
  expect(lossSetup.status()).toBe(201);
  await page.goto(`/keys/${lossKey.id}/verlust`);
  const loss=page.waitForResponse(response=>response.url().includes(`/api/v1/keys/${lossKey.id}/report-loss`)&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Verlust melden'}).last().click();
  dialog=page.getByRole('dialog',{name:/Verlust melden/});
  await dialog.getByLabel('Melder').fill('E2E Streife');
  await dialog.getByLabel('Beschreibung').fill('E2E Schlüssel verloren');
  await dialog.getByRole('button',{name:'Verlust melden'}).click();
  expect((await loss).status()).toBe(201);
  await expect(page.getByText('E2E Schlüssel verloren')).toBeVisible();

  await page.goto('/keys');
  await page.getByRole('button',{name:'Bestandskontrolle'}).click();
  dialog=page.getByRole('dialog',{name:'Bestandskontrolle erfassen'});
  await dialog.getByLabel('Objekt').selectOption(siteId);
  await dialog.getByLabel('Prüfer').fill('E2E Streife');
  const inventory=page.waitForResponse(response=>response.url().includes('/api/v1/keys/inventory-checks')&&response.request().method()==='POST');
  await dialog.getByRole('button',{name:'Bestandskontrolle speichern'}).click();
  expect((await inventory).status()).toBe(201);

  await expect(page.getByRole('heading',{name:'Schlüsselbünde'})).toBeVisible();
  if(user.permissions.includes('keys:bundle_write')){
    const bundle=page.waitForResponse(response=>response.url().includes('/api/v1/key-bundles')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'Schlüsselbund anlegen'}).click();
    dialog=page.getByRole('dialog',{name:'Schlüsselbund anlegen'});
    await dialog.getByLabel('Name').fill(`E2E Bund ${suffix}`);
    await dialog.getByLabel('Objekt').selectOption(siteId);
    await dialog.getByRole('button',{name:'Schlüsselbund anlegen'}).click();
    expect((await bundle).status()).toBe(201);
    const {id:bundleId}=await bundle.json() as {id:string};
    const card=page.locator(`#bundle-${bundleId}`);
    await expect(card).toBeVisible();
    await card.getByRole('button',{name:'Schlüssel anzeigen'}).click();
    for(const member of [key,bundleKey]){
      await expect(card.getByLabel('Schlüssel für den Schlüsselbund').locator(`option[value="${member.id}"]`)).toBeAttached();
      await card.getByLabel('Schlüssel für den Schlüsselbund').selectOption(member.id);
      const add=page.waitForResponse(response=>response.url().includes(`/key-bundles/${bundleId}/items`)&&response.request().method()==='POST');
      await card.getByRole('button',{name:'Hinzufügen'}).click();
      expect((await add).status()).toBe(201);
    }

    const bundleIssue=page.waitForResponse(response=>response.url().includes(`/key-bundles/${bundleId}/issue`)&&response.request().method()==='POST');
    await card.getByRole('button',{name:'Schlüsselbund ausgeben'}).click();
    dialog=page.getByRole('dialog',{name:/^Schlüsselbund ausgeben/});
    await dialog.getByLabel('Schlüsselhalter').selectOption(employeeId);
    await dialog.getByLabel('Fällig am').fill(dateTimeIn(7));
    await dialog.getByLabel('Grund').fill('E2E Bundesausgabe');
    await dialog.getByRole('button',{name:'Schlüsselbund ausgeben'}).click();
    expect((await bundleIssue).status()).toBe(201);

    const partialReturn=page.waitForResponse(response=>response.url().includes(`/key-bundles/${bundleId}/return`)&&response.request().method()==='POST');
    await card.getByRole('button',{name:'Teilweise Rückgabe'}).click();
    dialog=page.getByRole('dialog',{name:'Teilweise Rückgabe'});
    await dialog.getByRole('checkbox').first().check();
    await dialog.getByLabel('Grund').fill('E2E Teilrückgabe');
    await dialog.getByRole('button',{name:'Ausgewählte Schlüssel zurückgeben'}).click();
    expect((await partialReturn).status()).toBe(200);

    page.once('dialog',confirmation=>void confirmation.accept());
    const fullReturn=page.waitForResponse(response=>response.url().includes(`/key-bundles/${bundleId}/return`)&&response.request().method()==='POST');
    await card.getByRole('button',{name:'Vollständige Rückgabe'}).click();
    dialog=page.getByRole('dialog',{name:'Schlüsselbund vollständig zurückgeben'});
    await dialog.getByLabel('Grund').fill('E2E vollständige Rückgabe');
    await dialog.getByRole('button',{name:'Alle Schlüssel zurückgeben'}).click();
    expect((await fullReturn).status()).toBe(200);

    page.once('dialog',confirmation=>void confirmation.accept());
    const deactivate=page.waitForResponse(response=>response.url().includes(`/key-bundles/${bundleId}/deactivate`)&&response.request().method()==='POST');
    await card.getByRole('button',{name:'Deaktivieren'}).click();
    dialog=page.getByRole('dialog',{name:/^Schlüsselbund deaktivieren/});
    await dialog.getByLabel('Grund').fill('E2E Deaktivierung');
    await dialog.getByRole('button',{name:'Deaktivierung bestätigen'}).click();
    expect((await deactivate).status()).toBe(200);

    const bundleHistory=page.waitForResponse(response=>response.url().includes(`/key-bundles/${bundleId}/history`)&&response.request().method()==='GET');
    await card.getByRole('button',{name:'Historie'}).click();
    expect((await bundleHistory).status()).toBe(200);
    await expect(card.getByText(/Schlüssel hinzugefügt|Ausgegeben|Teilweise zurückgegeben|Zurückgegeben|Deaktiviert/).first()).toBeVisible();
  }else{
    await expect(page.getByRole('button',{name:'Schlüsselbund anlegen'})).toHaveCount(0);
  }

  const viewer=await browser.newPage();
  try{
    await login(viewer,viewerEmail);
    const viewerIdentity=await viewer.request.get('/api/v1/auth/me');
    expect((await viewerIdentity.json()).user.permissions).toContain('keys:read');
    await viewer.goto('/keys');
    await expect(viewer.getByRole('heading',{name:'Schlüsselverwaltung'})).toBeVisible();
    await expect(viewer.getByRole('button',{name:'Schlüssel anlegen'})).toHaveCount(0);
    await expect(viewer.getByRole('button',{name:'Bestandskontrolle'})).toHaveCount(0);
    await viewer.goto(`/keys/${key.id}/stammdaten`);
    await expect(viewer.getByRole('heading',{name:'E2E Haupteingang'})).toBeVisible();
    await expect(viewer.getByRole('button',{name:'Stammdaten speichern'})).toHaveCount(0);
  }finally{
    await viewer.close();
  }
});

test('key cockpit stays usable at desktop, laptop, tablet and phone widths',async({page})=>{
  test.setTimeout(120_000);
  await login(page,email!);
  // The PWA service worker claims clients on activation; let it settle before
  // the first navigation so it cannot abort it with net::ERR_ABORTED.
  await page.evaluate(()=>navigator.serviceWorker?.ready.then(()=>undefined));
  for(const [width,height] of [[1920,1080],[1440,900],[1024,768],[390,844]] as const){
    await page.setViewportSize({width,height});
    await page.goto('/keys');
    await expect(page.getByRole('heading',{name:'Schlüsselverwaltung'})).toBeVisible();
    await expect(page.getByRole('region',{name:'Handlungsübersicht'})).toBeVisible();
    await expect(page.getByRole('button',{name:'CSV exportieren'})).toBeVisible();
    const layout=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
    expect(layout.document,`horizontal overflow at ${width}x${height}`).toBeLessThanOrEqual(layout.viewport+1);
    await page.getByRole('button',{name:'Bestandskontrolle'}).click();
    await expect(page.getByRole('dialog',{name:'Bestandskontrolle erfassen'})).toBeVisible();
    await page.getByRole('button',{name:'Dialog schließen'}).click();
    await expect(page.locator('.key-table tbody tr').first()).toBeVisible();
    await page.locator('.key-table tbody a').first().click();
    await expect(page.locator('.key-detail-tabs')).toBeVisible();
    const detail=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
    expect(detail.document,`detail overflow at ${width}x${height}`).toBeLessThanOrEqual(detail.viewport+1);
  }
});
