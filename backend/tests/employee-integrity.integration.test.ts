import pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {runMigrations} from '../src/db/migration-runner.js';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL employee integrity integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;
const sessionToken=`employee-integrity-${randomUUID()}`;
const csrfToken=`employee-integrity-csrf-${randomUUID()}`;

describePostgres('PostgreSQL employee referential integrity and absence rules',()=>{
  const testName=`securityops_integrity_${randomUUID().replaceAll('-','')}`;
  let pool:pg.Pool;
  let tenantA:string;
  let tenantB:string;
  let userA:string;
  let sessionA:string;
  let employeeA:string;
  let employeeB:string;
  let employeeCancelledAbsence:string;
  let employeeApprovedAbsence:string;
  let customer:string;
  let shift:string;

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
        tenant_a:string;tenant_b:string;user_a:string;session_a:string;employee_a:string;employee_b:string;
        employee_c:string;employee_d:string;customer:string;shift:string;
      }>(`
        WITH a AS (INSERT INTO tenants(name) VALUES ('Integrity A') RETURNING id),
        b AS (INSERT INTO tenants(name) VALUES ('Integrity B') RETURNING id),
        s AS (INSERT INTO sites(tenant_id,name) SELECT id,'Integrity Site' FROM a RETURNING id),
        ua AS (INSERT INTO users(tenant_id,email,role,password_hash) SELECT id,$1,'admin','hash' FROM a RETURNING id),
        d AS (INSERT INTO devices(tenant_id,site_id,name,device_kind)
          SELECT id,(SELECT id FROM s),'Integrity Device','authenticated' FROM a RETURNING id),
        sa AS (INSERT INTO sessions(tenant_id,user_id,device_id,token_hash,csrf_token,expires_at)
          SELECT id,(SELECT id FROM ua),(SELECT id FROM d),$2,$3,now()+INTERVAL '1 day' FROM a RETURNING id),
        ea AS (INSERT INTO employees(tenant_id,name,email,employment_status,employment_type)
          SELECT id,'Manager',$4,'active','employee' FROM a RETURNING id),
        eb AS (INSERT INTO employees(tenant_id,name,email,employment_status,employment_type)
          SELECT id,'Foreign',$5,'active','employee' FROM b RETURNING id),
        ec AS (INSERT INTO employees(tenant_id,name,email,employment_status,employment_type)
          SELECT id,'Cancelled Absence',$6,'active','employee' FROM a RETURNING id),
        ed AS (INSERT INTO employees(tenant_id,name,email,employment_status,employment_type)
          SELECT id,'Approved Absence',$7,'active','employee' FROM a RETURNING id),
        cu AS (INSERT INTO customers(tenant_id,name,account_manager_employee_id)
          SELECT id,'Integrity Customer',(SELECT id FROM ea) FROM a RETURNING id),
        rp AS (INSERT INTO schedule_rule_profiles(tenant_id,name,version,created_by,created_session_id)
          SELECT id,'Integrity Rules',1,(SELECT id FROM ua),(SELECT id FROM sa) FROM a RETURNING id),
        pe AS (INSERT INTO schedule_periods(tenant_id,site_id,rule_profile_id,name,starts_at,ends_at,status,created_by,created_session_id)
          SELECT id,(SELECT id FROM s),(SELECT id FROM rp),'Integrity Period',now()-INTERVAL '2 days',now()+INTERVAL '2 days','published',(SELECT id FROM ua),(SELECT id FROM sa) FROM a RETURNING id),
        sh AS (INSERT INTO schedule_shifts(tenant_id,period_id,site_id,role_code,starts_at,ends_at,created_by,created_session_id)
          SELECT id,(SELECT id FROM pe),(SELECT id FROM s),'guard',now()-INTERVAL '1 hour',now()+INTERVAL '1 hour',(SELECT id FROM ua),(SELECT id FROM sa) FROM a RETURNING id),
        ac AS (INSERT INTO employee_absences(tenant_id,employee_id,starts_at,ends_at,absence_type,status,created_by)
          SELECT id,(SELECT id FROM ec),now()-INTERVAL '2 hours',now()+INTERVAL '2 hours','special_leave','cancelled',(SELECT id FROM ua) FROM a RETURNING id),
        ad AS (INSERT INTO employee_absences(tenant_id,employee_id,starts_at,ends_at,absence_type,status,created_by)
          SELECT id,(SELECT id FROM ed),now()-INTERVAL '2 hours',now()+INTERVAL '2 hours','special_leave','approved',(SELECT id FROM ua) FROM a RETURNING id)
        SELECT a.id tenant_a,b.id tenant_b,(SELECT id FROM ua) user_a,(SELECT id FROM sa) session_a,
          (SELECT id FROM ea) employee_a,(SELECT id FROM eb) employee_b,
          (SELECT id FROM ec) employee_c,(SELECT id FROM ed) employee_d,
          (SELECT id FROM cu) customer,(SELECT id FROM sh) shift
        FROM a,b
      `,[
        `${testName}-a@example.invalid`,createHash('sha256').update(sessionToken).digest('hex'),csrfToken,
        `${testName}-manager@example.invalid`,`${testName}-foreign@example.invalid`,
        `${testName}-cancelled@example.invalid`,`${testName}-approved@example.invalid`,
      ]);
      ({tenant_a:tenantA,tenant_b:tenantB,user_a:userA,session_a:sessionA,employee_a:employeeA,
        employee_b:employeeB,employee_c:employeeCancelledAbsence,employee_d:employeeApprovedAbsence,
        customer,shift}=seed.rows[0]);
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

  async function tenantClient(){
    const client=await pool.connect();
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    return client;
  }

  it('detaches an optional employee reference on delete without nulling the tenant id',async()=>{
    const client=await tenantClient();
    try{
      await client.query('DELETE FROM employees WHERE tenant_id=$1 AND id=$2',[tenantA,employeeA]);
      const row=(await client.query<{tenant_id:string;account_manager_employee_id:string|null}>(
        'SELECT tenant_id,account_manager_employee_id FROM customers WHERE id=$1',[customer],
      )).rows[0];
      expect(row.tenant_id).toBe(tenantA);
      expect(row.account_manager_employee_id).toBeNull();
    }finally{
      client.release();
    }
  },60_000);

  it('rejects a cross-tenant responsible_employee_id in DMS documents',async()=>{
    const client=await tenantClient();
    try{
      await expect(client.query(
        `INSERT INTO dms_documents(tenant_id,title,created_by,created_session_id,responsible_employee_id)
         VALUES ($1,'Foreign responsible',$2,$3,$4)`,[tenantA,userA,sessionA,employeeB],
      )).rejects.toMatchObject({code:'23503'});
      const valid=await client.query(
        `INSERT INTO dms_documents(tenant_id,title,created_by,created_session_id,responsible_employee_id)
         VALUES ($1,'Own responsible',$2,$3,$4) RETURNING id`,[tenantA,userA,sessionA,employeeCancelledAbsence],
      );
      expect(valid.rowCount).toBe(1);
    }finally{
      client.release();
    }
  },60_000);

  it('lets cancelled absences block neither shift assignment nor approved absences',async()=>{
    const client=await tenantClient();
    try{
      const cancelled=await client.query(
        `INSERT INTO schedule_assignments(tenant_id,shift_id,employee_id,status,created_by,created_session_id)
         VALUES ($1,$2,$3,'assigned',$4,$5) RETURNING id`,[tenantA,shift,employeeCancelledAbsence,userA,sessionA],
      );
      expect(cancelled.rowCount).toBe(1);
      await expect(client.query(
        `INSERT INTO schedule_assignments(tenant_id,shift_id,employee_id,status,created_by,created_session_id)
         VALUES ($1,$2,$3,'assigned',$4,$5)`,[tenantA,shift,employeeApprovedAbsence,userA,sessionA],
      )).rejects.toMatchObject({code:'23514'});
    }finally{
      client.release();
    }
  },60_000);
});
