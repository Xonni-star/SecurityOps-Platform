import {expect,test} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;

function requireFixtureCredentials(){
  if(!email||!password)throw new Error('OPEN: E2E_EMAIL and E2E_PASSWORD are required');
  return {email,password};
}

async function login(page:import('@playwright/test').Page){
  const credentials=requireFixtureCredentials();
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(credentials.email);
  await page.getByLabel('Passwort').fill(credentials.password);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await expect(page).toHaveURL('/');
}

test.describe('Reporting-Zentrum',()=>{
  test('shows the central filter, live modules and audited exports',async({page})=>{
    await login(page);

    await page.goto('/reports');
    await expect(page.getByRole('heading',{name:'Reporting-Zentrum'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Zentraler Filter'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Module A–M'})).toBeVisible();
    await expect(page.getByText('Schicht- und Dienstplanung')).toBeVisible();
    await expect(page.getByText('Audit und Exporte')).toBeVisible();
    await expect(page.getByRole('button',{name:'XLSX exportieren'})).toBeVisible();

    await page.getByLabel('Von').fill('2026-11-01');
    await page.getByLabel('Bis').fill('2026-11-30');
    await page.getByRole('button',{name:'Filter anwenden'}).click();
    await expect(page.getByText(/Zeitraum: 2026-11-01 bis 2026-11-30/)).toBeVisible();

    for(const format of ['csv','pdf','xlsx']){
      const response=await page.request.get(`/api/v1/reports/center/export?module=documents&format=${format}&from=2026-11-01&to=2026-11-30`);
      expect(response.status()).toBe(200);
      expect(response.headers()['x-report-row-count']).toBeDefined();
    }
  });

  test('bleibt auf Tablet brechenfrei nutzbar',async({page})=>{
    await page.setViewportSize({width:768,height:1024});
    await login(page);
    await page.goto('/reports');
    await expect(page.getByRole('heading',{name:'Reporting-Zentrum'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Module A–M'})).toBeVisible();
    await expect(page.getByRole('button',{name:'XLSX exportieren'})).toBeVisible();
    await page.screenshot({path:'docs/QA/screenshots/reporting-center-tablet.png',fullPage:false});
  });
});
