import {expect,test} from '@playwright/test';

test.describe('NSL-Leitstelle',()=>{
  test('redirects unauthenticated users to login',async({page})=>{
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
  });

  test('logs in, shows dashboard areas, creates and resolves a panic alarm',async({page})=>{
    await page.goto('/login');
    await page.getByLabel('Email').fill('admin@example.com');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button',{name:'Sign in'}).click();
    await expect(page).toHaveURL('/');
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
    await page.goto('/login');
    await page.getByRole('button',{name:'Sign in'}).click();
    await page.goto('/mobile');
    await expect(page.getByRole('heading',{name:'Wächter-App'})).toBeVisible();
    await expect(page.getByRole('button',{name:'PANIK'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Kontrollpunkt bestätigen'})).toBeVisible();
    await expect(page.getByText(/Offline-Outbox/)).toBeVisible();
  });
});
