import {expect,test} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;

function requireFixtureCredentials() {
  if (!email || !password) throw new Error('OPEN: E2E_EMAIL and E2E_PASSWORD are required');
  return {email,password};
}

test.describe('NSL-Leitstelle',()=>{
  test('redirects unauthenticated users to login',async({page})=>{
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
  });

  test('logs in, shows dashboard areas, creates and resolves a panic alarm',async({page})=>{
    const credentials=requireFixtureCredentials();
    await page.goto('/login');
    await page.getByLabel('Email').fill(credentials.email);
    await page.getByLabel('Password').fill(credentials.password);
    await page.getByRole('button',{name:'Sign in'}).click();
    await expect(page).toHaveURL('/');
    await expect(page).toHaveURL('/');
    const cookies=await page.context().cookies();
    expect(cookies.find(cookie=>cookie.name==='securityops_session')?.httpOnly).toBe(true);
    expect(cookies.find(cookie=>cookie.name==='securityops_csrf')?.httpOnly).toBe(false);
    await expect(page.getByRole('heading',{name:'NSL-Leitstelle'})).toBeVisible();
    for(const name of ['Offene Alarme','Aktive Einsätze','Positionen','Kontrollgänge']){
      await expect(page.getByRole('heading',{name:new RegExp(`^${name}`)})).toBeVisible();
    }

    const csrf=await page.evaluate(()=>document.cookie.split('; ').find(value=>value.startsWith('securityops_csrf='))?.split('=').slice(1).join('=')||'');
    const panic=await page.request.post('/api/v1/alarms/panic',{data:{description:'E2E Panik-Alarm',position:'E2E'},headers:{'x-csrf-token':csrf}});
    expect(panic.status()).toBe(201);
    const alarm=await panic.json() as {id:string};

    await page.goto('/alarms');
    await expect(page.getByText('E2E Panik-Alarm')).toBeVisible();
    await page.getByRole('button',{name:'Quittieren'}).click();
    await expect(page.getByText('acknowledged')).toBeVisible();
    await page.getByRole('button',{name:'Erledigen'}).click();
    await expect(page.getByText('resolved')).toBeVisible();

    expect((await page.request.get(`/api/v1/alarms/${alarm.id}/history`)).status()).toBe(200);
    expect((await page.request.get('/api/v1/reports/alarms?format=csv')).status()).toBe(200);
    expect((await page.request.get('/api/v1/reports/alarms?format=pdf')).status()).toBe(200);
  });

  test('mobile workflow exposes scan, panic and offline outbox controls',async({page})=>{
    const credentials=requireFixtureCredentials();
    await page.goto('/login');
    await page.getByLabel('Email').fill(credentials.email);
    await page.getByLabel('Password').fill(credentials.password);
    await page.getByRole('button',{name:'Sign in'}).click();
    await expect(page).toHaveURL('/');
    await page.goto('/mobile');
    await expect(page.getByRole('heading',{name:'Wächter-App'})).toBeVisible();
    await expect(page.getByRole('button',{name:'PANIK'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Kontrollpunkt bestätigen'})).toBeVisible();
    await expect(page.getByText(/Offline-Outbox/)).toBeVisible();
  });
});
