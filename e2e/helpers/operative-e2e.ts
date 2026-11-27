import {randomUUID} from 'node:crypto';
import {expect,type APIRequestContext,type APIResponse,type Page} from '@playwright/test';

export type Row=Record<string,any>;
export type Session={
  context:APIRequestContext;
  headers:Record<string,string>;
  user:Row;
  tenantId:string;
};
type PlaywrightLike={request:{newContext(options?:{baseURL?:string}):Promise<APIRequestContext>}};

export const email=process.env.E2E_EMAIL??'e2e-scale-20261126@example.invalid';
export const password=process.env.E2E_PASSWORD??'local-e2e-password-20261126';
export const authorEmail=process.env.E2E_AUTHOR_EMAIL??'e2e-author@example.invalid';
export const viewerEmail=process.env.E2E_VIEWER_EMAIL??'e2e-viewer@example.invalid';
export const adminEmail=process.env.E2E_ADMIN_EMAIL??'e2e-qm-admin@example.invalid';
export const adminPassword=process.env.E2E_ADMIN_PASSWORD??password;
export const foreignEmail=process.env.E2E_FOREIGN_EMAIL??'admin@example.com';
export const foreignPassword=process.env.E2E_FOREIGN_PASSWORD??'password';
export const apiBase=process.env.E2E_API_BASE_URL??'http://localhost:3000';
export const uiBase=process.env.E2E_BASE_URL??'http://localhost:5173';

export const fixture={
  tenantId:'00000000-0000-4000-8000-000000000101',
  userId:'00000000-0000-4000-8000-000000000102',
  siteId:'00000000-0000-4000-8000-000000000103',
  employeeId:'00000000-0000-4000-8000-000000000104',
  priorityId:'00000000-0000-4000-8000-000000000107',
  criticalPriorityId:'00000000-0000-4000-8000-000000000109',
  adminUserId:'00000000-0000-4000-8000-000000000119',
  operationalDeviceId:'00000000-0000-4000-8000-000000000117',
};

export async function loginApi(
  playwright:PlaywrightLike,
  userEmail:string,
  userPassword:string,
  platform:string,
):Promise<Session>{
  const context=await playwright.request.newContext({baseURL:uiBase});
  const response=await context.post('/api/v1/auth/login',{data:{
    email:userEmail,
    password:userPassword,
    device_id:randomUUID(),
    metadata:{platform,app_version:'e2e'},
  }});
  const body=await response.text();
  expect(response.status(),`Login ${userEmail}: HTTP ${response.status()} ${body}`).toBe(200);
  const login=JSON.parse(body) as Row;
  expect(login.mfa_required,`Login ${userEmail} darf keine MFA-Aufforderung erzeugen.`).toBe(false);
  expect(login.mfa_pending,`Login ${userEmail} darf keine MFA-Aufforderung erzeugen.`).toBe(false);
  const csrf=(await context.cookies()).find(cookie=>cookie.name==='securityops_csrf')?.value;
  if(!csrf)throw new Error(`Kein CSRF-Cookie für ${userEmail} erhalten.`);
  const headers={'x-csrf-token':decodeURIComponent(csrf)};
  const me=await context.get('/api/v1/auth/me',{headers});
  const meBody=await me.text();
  expect(me.status(),`/auth/me ${userEmail}: HTTP ${me.status()} ${meBody}`).toBe(200);
  const user=((JSON.parse(meBody) as Row).user??{}) as Row;
  const tenantId=String(user.tenantId??user.tenant_id??'');
  expect(tenantId,`Kein Mandant für ${userEmail} ermittelt.`).toBeTruthy();
  return {context,headers,user,tenantId};
}

export async function expectStatus(response:APIResponse,status:number,label:string):Promise<void>{
  const body=await response.text();
  expect(response.status(),`${label}: HTTP ${response.status()} ${body}`).toBe(status);
}

export async function expectStatusIn(response:APIResponse,statuses:number[],label:string):Promise<void>{
  const body=await response.text();
  expect(statuses,`${label}: HTTP ${response.status()} ${body}`).toContain(response.status());
}

export async function readJson(response:APIResponse,label:string):Promise<Row>{
  const body=await response.text();
  expect(response.status(),`${label}: HTTP ${response.status()} ${body}`).toBeLessThan(400);
  return JSON.parse(body) as Row;
}

export async function errorJson(response:APIResponse,status:number,label:string):Promise<Row>{
  const body=await response.text();
  expect(response.status(),`${label}: HTTP ${response.status()} ${body}`).toBe(status);
  return JSON.parse(body) as Row;
}

export async function loginUi(page:Page,userEmail:string,userPassword:string):Promise<void>{
  await page.goto('/login');
  await expect(page.getByRole('heading',{name:'Willkommen zurück'})).toBeVisible();
  await page.getByLabel('E-Mail-Adresse').fill(userEmail);
  await page.getByLabel('Passwort').fill(userPassword);
  await page.getByRole('button',{name:'Anmelden'}).click();
  await expect(page).toHaveURL('/');
}

export function hasPath(paths:Record<string,any>,path:string,method:'get'|'post'|'patch'|'delete'):boolean{
  return Boolean(paths[path]?.[method]);
}

export async function openApiPaths(request:{get(url:string):Promise<APIResponse>}):Promise<Record<string,any>>{
  const response=await request.get(`${apiBase}/api/openapi.json`);
  const body=await response.text();
  expect(response.status(),`/api/openapi.json: HTTP ${response.status()} ${body.slice(0,300)}`).toBe(200);
  return ((JSON.parse(body) as Row).paths??{}) as Record<string,any>;
}

export async function createIsolatedSite(
  session:Session,
  label:string,
  runId:string,
):Promise<string>{
  const response=await session.context.post('/api/v1/sites',{headers:session.headers,data:{
    name:`E2E ${label} ${runId}`,
    site_number:`e2e_${label.toLowerCase().replace(/[^a-z0-9]/g,'')}_${runId}`.replace(/[^a-z0-9_-]/g,'_').slice(0,80),
    site_type:'E2E Isolationsobjekt',
    status:'active',
    required_staff_count:0,
  }});
  const row=await readJson(response,`Isoliertes E2E-Objekt (${label})`);
  expect(response.status()).toBe(201);
  return String(row.id);
}

export async function decommissionSite(session:Session,siteId:string,label:string):Promise<void>{
  for(const status of ['decommissioned','archived']){
    const response=await session.context.patch(`/api/v1/sites/${siteId}`,{
      headers:session.headers,data:{status},
    });
    if(response.status()!==200)console.warn(`Cleanup ${label} ${siteId} → ${status}: HTTP ${response.status()}`);
  }
}

export function berlinDate(offsetDays=0):string{
  const today=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',
  }).format(new Date());
  const [year,month,day]=today.split('-').map(Number);
  return new Date(Date.UTC(year,month-1,day+offsetDays)).toISOString().slice(0,10);
}

export function isoIn(days:number,hour=0):string{
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  date.setUTCHours(hour,0,0,0);
  return date.toISOString();
}

export function permissionList(session:Session):string[]{
  return (session.user.permissions??[]) as string[];
}
