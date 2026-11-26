import {expect,test,type Page} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;
const apiBase=process.env.E2E_API_BASE_URL??'http://localhost:3000';

test.skip(!email||!password,'Set isolated E2E_EMAIL and E2E_PASSWORD to run the NFC lifecycle browser test.');

test.beforeAll(async({request})=>{
  const ready=await request.get(`${apiBase}/ready`);
  if(!ready.ok())throw new Error(`NFC E2E backend is not ready (${ready.status()}).`);
});

async function login(page:Page){
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email!);
  await page.getByLabel('Passwort').fill(password!);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await expect(page).toHaveURL(/\/$/);
}

const viewports=[{width:1440,height:900},{width:820,height:1100},{width:390,height:844}];

for(const viewport of viewports){
  test(`NFC overview and device file work without overflow at ${viewport.width}px`,async({page})=>{
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await login(page);

    const inventory=await page.request.get('/api/v1/nfc-devices/inventory?pageSize=1');
    expect(inventory.status()).toBe(200);
    const row=(await inventory.json()).rows?.[0] as {id:string;identifier:string}|undefined;
    expect(row?.id).toBeTruthy();

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

    await page.goto(`/nfc-devices/${row!.id}`);
    await expect(page.getByRole('heading',{name:row!.identifier})).toBeVisible();
    await expect(page.getByRole('tab',{name:'Scan-Historie'})).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading',{name:row!.identifier})).toBeVisible();

    await page.getByRole('tab',{name:'Scan-Historie'}).click();
    await expect(page.getByRole('columnheader',{name:'Authentifizierung'})).toBeVisible();
    overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
    expect(overflow,{message:`Horizontaler Overflow in der Geräteakte bei ${viewport.width}px`}).toBe(false);
  });
}
