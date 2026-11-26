import {expect,test,type Page} from '@playwright/test';

const email=process.env.E2E_EMAIL;
const password=process.env.E2E_PASSWORD;
const apiBase=process.env.E2E_API_BASE_URL??'http://localhost:3000';
const employeeId=process.env.E2E_EMPLOYEE_ID??'00000000-0000-4000-8000-000000000104';

test.skip(!email||!password,'Set isolated E2E_EMAIL and E2E_PASSWORD to run the employee master-data browser test.');

test.beforeAll(async({request})=>{
  const ready=await request.get(`${apiBase}/ready`);
  if(!ready.ok())throw new Error(`Employee E2E backend is not ready (${ready.status()}).`);
});

async function login(page:Page){
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email!);
  await page.getByLabel('Passwort').fill(password!);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(()=>navigator.serviceWorker?.ready.then(()=>undefined));
}

async function csrfHeaders(page:Page){
  const token=(await page.context().cookies()).find(cookie=>cookie.name==='securityops_csrf')?.value;
  if(!token)throw new Error('Authenticated E2E session did not receive a CSRF cookie.');
  return {'x-csrf-token':decodeURIComponent(token)};
}

/** Only fields accepted by PATCH /employees/:id/profile – never the full profile row. */
function toPayload(employee:Record<string,unknown>,reason:string){
  const fields=['name','email','title','employee_number','first_name','last_name','phone','mobile','address',
    'date_of_birth','hire_date','termination_date','employment_status','employment_type','department',
    'position','work_location','weekly_hours','user_id'] as const;
  const payload:Record<string,unknown>={};
  for(const field of fields)payload[field]=employee[field]??null;
  payload.reason=reason;
  return payload;
}

test('employee master data is edited, saved, reloaded and protected across tenants',async({page})=>{
  test.setTimeout(180_000);
  await login(page);
  const headers=await csrfHeaders(page);
  const profileResponse=await page.request.get(`/api/v1/employees/${employeeId}/profile`);
  expect(profileResponse.status()).toBe(200);
  const original=(await profileResponse.json()).employee as Record<string,unknown>;

  const suffix=Date.now().toString().slice(-6);
  const changed={
    name:`E2E Prüfer ${suffix}`,first_name:`E2E${suffix}`,last_name:`Prüfer${suffix}`,
    email:`e2e-master-${suffix}@example.invalid`,phone:`+49 30 ${suffix}`,
    address:`E2E-Teststraße ${suffix}`,department:'E2E Qualitätssicherung',employment_status:'probation',
  };

  try{
    await page.goto(`/employees/${employeeId}/stammdaten`);
    await expect(page.getByRole('heading',{name:String(original.name)})).toBeVisible();
    await expect(page.getByText('Bearbeitungsmodus')).toBeVisible();

    await page.getByLabel('Name',{exact:true}).fill(changed.name);
    await page.getByLabel('Vorname').fill(changed.first_name);
    await page.getByLabel('Nachname').fill(changed.last_name);
    await page.getByLabel('E-Mail').fill(changed.email);
    await page.getByLabel('Telefon').fill(changed.phone);
    await page.getByLabel('Adresse').fill(changed.address);
    await page.getByLabel('Abteilung').fill(changed.department);
    await page.getByLabel('Beschäftigungsstatus').selectOption(changed.employment_status);
    await page.getByLabel('Änderungsgrund').fill('E2E Stammdatenänderung');
    await page.getByRole('button',{name:'Stammdaten speichern'}).click();
    await expect(page.getByText('Stammdaten wurden gespeichert.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading',{name:changed.name})).toBeVisible();
    await expect(page.getByLabel('Name',{exact:true})).toHaveValue(changed.name);
    await expect(page.getByLabel('Vorname')).toHaveValue(changed.first_name);
    await expect(page.getByLabel('Nachname')).toHaveValue(changed.last_name);
    await expect(page.getByLabel('E-Mail')).toHaveValue(changed.email);
    await expect(page.getByLabel('Telefon')).toHaveValue(changed.phone);
    await expect(page.getByLabel('Adresse')).toHaveValue(changed.address);
    await expect(page.getByLabel('Abteilung')).toHaveValue(changed.department);
    await expect(page.getByLabel('Beschäftigungsstatus')).toHaveValue(changed.employment_status);

    const reread=await page.request.get(`/api/v1/employees/${employeeId}/profile`);
    expect(reread.status()).toBe(200);
    expect((await reread.json()).employee).toMatchObject(changed);

    for(const viewport of [{width:1440,height:900},{width:820,height:1100},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      await expect(page.getByLabel('Vorname')).toBeVisible();
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
      expect(overflow,{message:`Horizontaler Overflow bei ${viewport.width}px`}).toBe(false);
    }

    const foreign=await page.request.patch('/api/v1/employees/00000000-0000-4000-8000-000000000999/profile',{
      headers,data:toPayload({...original,...changed},'E2E mandantenfremd'),
    });
    expect(foreign.status()).toBe(404);
  }finally{
    // Restore the isolated fixture so other browser specs keep their original employee.
    const restore=await page.request.patch(`/api/v1/employees/${employeeId}/profile`,{
      headers,data:toPayload(original,'E2E Stammdaten zurückgesetzt'),
    });
    expect(restore.status()).toBe(200);
  }
});
