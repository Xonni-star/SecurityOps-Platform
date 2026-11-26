import pg from 'pg';
import request from 'supertest';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {runMigrations} from '../src/db/migration-runner.js';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL employee profile integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;
if(databaseUrl&&!process.env.DATABASE_URL)process.env.DATABASE_URL=databaseUrl;
const {app}=databaseUrl?await import('../src/app.js'):{app:undefined};
const sessionToken=`employee-profile-${randomUUID()}`;
const csrfToken=`employee-csrf-${randomUUID()}`;
const headers={Cookie:[`securityops_session=${sessionToken}`,`securityops_csrf=${csrfToken}`],'x-csrf-token':csrfToken};

/** Exactly the whitelisted PATCH payload – the regression bug sent the whole profile row. */
function toPayload(employee:Record<string,unknown>,overrides:Record<string,unknown>={},reason='Stammdaten aktualisiert'){
  const fields=['name','email','title','employee_number','first_name','last_name','phone','mobile','address',
    'date_of_birth','hire_date','termination_date','employment_status','employment_type','department',
    'position','work_location','weekly_hours','user_id'] as const;
  const payload:Record<string,unknown>={};
  for(const field of fields)payload[field]=Object.prototype.hasOwnProperty.call(overrides,field)?overrides[field]:(employee[field]??null);
  payload.reason=typeof overrides.reason==='string'?overrides.reason:reason;
  return payload;
}

describePostgres('PostgreSQL employee master data persistence',()=>{
  const testName=`securityops_employee_${randomUUID().replaceAll('-','')}`;
  let pool:pg.Pool;
  let tenantA:string;
  let tenantB:string;
  let employeeA:string;
  let employeeB:string;

  beforeAll(async()=>{
    if(!databaseUrl)throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    pool=new pg.Pool({connectionString:databaseUrl});
    const migrationsDir=existsSync(resolve(process.cwd(),'migrations'))
      ?resolve(process.cwd(),'migrations')
      :resolve(process.cwd(),'backend/migrations');
    await runMigrations(pool,migrationsDir);
    const admin=await pool.connect();
    try{
      const seed=await admin.query<{
        tenant_a:string;tenant_b:string;session_a:string;device_a:string;employee_a:string;employee_b:string;
      }>(`
        WITH a AS (INSERT INTO tenants(name) VALUES ('Employee A') RETURNING id),
        b AS (INSERT INTO tenants(name) VALUES ('Employee B') RETURNING id),
        sa0 AS (INSERT INTO sites(tenant_id,name) SELECT id,'Site A' FROM a RETURNING id),
        ua AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$1,'admin','hash' FROM a RETURNING id),
        da AS (INSERT INTO devices(tenant_id,site_id,name,device_kind)
          SELECT id,(SELECT id FROM sa0),'Device A','authenticated' FROM a RETURNING id),
        sa AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
          SELECT id,(SELECT id FROM ua),(SELECT id FROM da),$2,$3,now()+INTERVAL '1 day' FROM a RETURNING id),
        ea AS (INSERT INTO employees(tenant_id,name,email,first_name,last_name,phone,address,employment_status,employment_type)
          SELECT id,'Ava Worker',$4,'Ava','Worker','+49 30 111','Teststraße 1','active','employee' FROM a RETURNING id),
        eb AS (INSERT INTO employees(tenant_id,name,email,first_name,last_name,employment_status,employment_type)
          SELECT id,'Ben Worker',$5,'Ben','Worker','active','employee' FROM b RETURNING id)
        SELECT a.id tenant_a,b.id tenant_b,(SELECT id FROM sa) session_a,
          (SELECT id FROM da) device_a,(SELECT id FROM ea) employee_a,(SELECT id FROM eb) employee_b
        FROM a,b
      `,[
        `${testName}-a@example.invalid`,createHash('sha256').update(sessionToken).digest('hex'),csrfToken,
        `${testName}-employee-a@example.invalid`,`${testName}-employee-b@example.invalid`,
      ]);
      ({tenant_a:tenantA,tenant_b:tenantB,employee_a:employeeA,employee_b:employeeB}=seed.rows[0]);
      if(!seed.rows[0].device_a)throw new Error('Authenticated device was not seeded');
    }finally{
      admin.release();
    }
  },60_000);

  afterAll(async()=>{
    if(!pool)return;
    const admin=await pool.connect();
    try{
      if(tenantA&&tenantB)await admin.query('DELETE FROM tenants WHERE id IN ($1,$2)',[tenantA,tenantB]);
    }finally{
      admin.release();
      await pool.end();
    }
  },60_000);

  it('writes every changed master-data field and reads it back through the real API',async()=>{
    const before=await request(app).get(`/api/v1/employees/${employeeA}/profile`).set(headers);
    expect(before.status).toBe(200);
    const original=before.body.employee as Record<string,unknown>;

    const response=await request(app).patch(`/api/v1/employees/${employeeA}/profile`).set(headers).send(toPayload(original,{
      first_name:'Lena',last_name:'Fischer',phone:'+49 30 999',email:`${testName}-changed@example.invalid`,
      address:'Neustrasse 9',department:'Qualitätssicherung',employment_status:'probation',reason:'Echte Datenbankänderung',
    }));
    expect(response.status).toBe(200);

    const after=await request(app).get(`/api/v1/employees/${employeeA}/profile`).set(headers);
    expect(after.status).toBe(200);
    expect(after.body.employee).toMatchObject({
      first_name:'Lena',last_name:'Fischer',phone:'+49 30 999',address:'Neustrasse 9',
      department:'Qualitätssicherung',employment_status:'probation',employee_number:original.employee_number,
    });

    const client=await pool.connect();
    try{
      await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
      const row=(await client.query<{first_name:string;phone:string;employment_status:string}>(
        'SELECT first_name,phone,employment_status FROM employees WHERE tenant_id=$1 AND id=$2',[tenantA,employeeA],
      )).rows[0];
      expect(row).toMatchObject({first_name:'Lena',phone:'+49 30 999',employment_status:'probation'});
      const history=(await client.query<{event_type:string}>(
        "SELECT event_type FROM employee_history WHERE tenant_id=$1 AND employee_id=$2 AND event_type='profile.updated'",[tenantA,employeeA],
      )).rows;
      expect(history).toHaveLength(1);
      const audit=(await client.query<{event_type:string}>(
        "SELECT event_type FROM audit_events WHERE tenant_id=$1 AND entity_type='employee' AND entity_id=$2 AND event_type='employee.profile.updated'",[tenantA,employeeA],
      )).rows;
      expect(audit).toHaveLength(1);
    }finally{
      client.release();
    }
  },60_000);

  it('clears optional fields persistently and rejects invalid and cross-tenant updates',async()=>{
    const before=await request(app).get(`/api/v1/employees/${employeeA}/profile`).set(headers);
    expect(before.status).toBe(200);
    const original=before.body.employee as Record<string,unknown>;
    const response=await request(app).patch(`/api/v1/employees/${employeeA}/profile`).set(headers)
      .send(toPayload({...original,phone:null,mobile:null,address:null},{},'Optionale Felder bereinigt'));
    expect(response.status).toBe(200);

    const after=await request(app).get(`/api/v1/employees/${employeeA}/profile`).set(headers);
    expect(after.body.employee.phone).toBeNull();
    expect(after.body.employee.address).toBeNull();

    const invalid=await request(app).patch(`/api/v1/employees/${employeeA}/profile`).set(headers)
      .send({...toPayload(original,{},'ungültig'),email:'keine-email'});
    expect(invalid.status).toBe(400);
    expect(invalid.body.fields.email).toBeTruthy();

    const foreign=await request(app).patch(`/api/v1/employees/${employeeB}/profile`).set(headers)
      .send(toPayload({...original,name:'manipuliert'},{},'mandantenfremd'));
    expect(foreign.status).toBe(404);

    const client=await pool.connect();
    try{
      await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantB]);
      expect((await client.query<{name:string}>('SELECT name FROM employees WHERE id=$1',[employeeB])).rows[0].name).toBe('Ben Worker');
    }finally{
      client.release();
    }
  },60_000);
});
