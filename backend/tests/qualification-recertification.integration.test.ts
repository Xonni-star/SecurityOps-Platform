import pg from 'pg';
import {randomUUID} from 'node:crypto';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL qualification recertification integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;

describePostgres('qualification recertification history constraints',()=>{
  const suffix=randomUUID().replaceAll('-','');
  let client:pg.Client;
  let tenantA:string;
  let tenantB:string;
  let employeeA:string;
  let employeeB:string;

  beforeAll(async()=>{
    if(!databaseUrl)throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    client=new pg.Client({connectionString:databaseUrl});
    await client.connect();
    const seed=await client.query<{tenant_a:string;tenant_b:string;employee_a:string;employee_b:string}>(`
      WITH a AS (INSERT INTO tenants(name) VALUES ('QA ${suffix} A') RETURNING id),
           b AS (INSERT INTO tenants(name) VALUES ('QA ${suffix} B') RETURNING id),
           ea AS (INSERT INTO employees(tenant_id,name,email) SELECT id,'QA A','qa-a-${suffix}@example.invalid' FROM a RETURNING id,tenant_id),
           eb AS (INSERT INTO employees(tenant_id,name,email) SELECT id,'QA B','qa-b-${suffix}@example.invalid' FROM b RETURNING id,tenant_id)
      SELECT a.id tenant_a,b.id tenant_b,ea.id employee_a,eb.id employee_b FROM a,b,ea,eb
    `);
    ({tenant_a:tenantA,tenant_b:tenantB,employee_a:employeeA,employee_b:employeeB}=seed.rows[0]);
  });

  afterAll(async()=>{
    if(!client)return;
    try{
      await client.query('DELETE FROM tenants WHERE id IN ($1,$2)',[tenantA,tenantB]);
    }finally{
      await client.end();
    }
  });

  it('erlaubt historische Widerrufe und genau eine aktuelle Zertifizierung pro Mitarbeiter und Code',async()=>{
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    const code=`qa_${suffix}`;
    await client.query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,status,valid_until_source)
      VALUES($1,$2,$3,'valid','catalog_default')`,[tenantA,employeeA,code]);
    await expect(client.query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,status)
      VALUES($1,$2,$3,'valid')`,[tenantA,employeeA,code])).rejects.toMatchObject({code:'23505'});
    await client.query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,status,revoked_at)
      VALUES($1,$2,$3,'revoked',now())`,[tenantA,employeeA,code]);
    await client.query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,status,revoked_at)
      VALUES($1,$2,$3,'revoked',now())`,[tenantA,employeeA,code]);
    await expect(client.query(`UPDATE employee_qualifications SET status='invalid',revoked_at=NULL
      WHERE tenant_id=$1 AND employee_id=$2 AND code=$3 AND status='valid'`,[tenantA,employeeA,code])).resolves.toBeTruthy();
    await client.query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,status,valid_until_source)
      VALUES($1,$2,$3,'valid','manual')`,[tenantA,employeeA,code]);
    const rows=(await client.query<{status:string;valid_until_source:string|null}>(`SELECT status,valid_until_source
      FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND code=$3 ORDER BY created_at`,
      [tenantA,employeeA,code])).rows;
    expect(rows).toHaveLength(4);
    expect(rows.filter(row=>row.status==='revoked')).toHaveLength(2);
    expect(rows.filter(row=>row.status==='valid')).toHaveLength(1);
    expect(rows.find(row=>row.status==='valid')?.valid_until_source).toBe('manual');
  });

  it('trennt Mandanten trotz gleichem Code und validiert die Herkunft des Ablaufdatums',async()=>{
    const code=`qa_${suffix}_b`;
    const invalidCode=`qa_${suffix}_c`;
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    await client.query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,status)
      VALUES($1,$2,$3,'valid')`,[tenantA,employeeA,code]);
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantB]);
    await expect(client.query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,status)
      VALUES($1,$2,$3,'valid')`,[tenantB,employeeB,code])).resolves.toBeTruthy();
    await expect(client.query(`INSERT INTO employee_qualifications(tenant_id,employee_id,code,status,valid_until_source)
      VALUES($1,$2,$3,'valid','unknown')`,[tenantB,employeeB,invalidCode])).rejects.toMatchObject({code:'23514'});
  });
});
