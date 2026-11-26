import pg from 'pg';
import {randomUUID} from 'node:crypto';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL tenant RLS integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;

describePostgres('PostgreSQL tenant RLS integration',()=>{
  const testName=`securityops_rls_${randomUUID().replaceAll('-','')}`;
  let client:pg.Client;
  let tenantA:string;
  let tenantB:string;
  let _siteA:string;
  let siteB:string;
  let employeeA:string;
  let employeeB:string;

  beforeAll(async()=>{
    if(!databaseUrl)throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    client=new pg.Client({connectionString:databaseUrl});
    await client.connect();
    const seed=await client.query<{tenant_a:string;tenant_b:string;site_a:string;site_b:string;employee_a:string;employee_b:string}>(`
      WITH a AS (INSERT INTO tenants(name) VALUES ('RLS A') RETURNING id),
      b AS (INSERT INTO tenants(name) VALUES ('RLS B') RETURNING id),
      sa AS (INSERT INTO sites(tenant_id,name) SELECT id,'Site A' FROM a RETURNING id,tenant_id),
      sb AS (INSERT INTO sites(tenant_id,name) SELECT id,'Site B' FROM b RETURNING id,tenant_id),
      ea AS (INSERT INTO employees(tenant_id,name,email) SELECT id,'Employee A',$1 FROM a RETURNING id,tenant_id),
      eb AS (INSERT INTO employees(tenant_id,name,email) SELECT id,'Employee B',$2 FROM b RETURNING id,tenant_id)
      SELECT a.id tenant_a,b.id tenant_b,sa.id site_a,sb.id site_b,ea.id employee_a,eb.id employee_b
      FROM a,b,sa,sb,ea,eb
    `,[`${testName}-a@example.invalid`,`${testName}-b@example.invalid`]);
    ({tenant_a:tenantA,tenant_b:tenantB,site_a:_siteA,site_b:siteB,employee_a:employeeA,employee_b:employeeB}=seed.rows[0]);
    await client.query(`CREATE ROLE ${testName} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${testName}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON employees,sites,devices TO ${testName}`);
    await client.query(`SET ROLE ${testName}`);
  });

  afterAll(async()=>{
    if(!client)return;
    try{
      await client.query('RESET ROLE');
      await client.query('DELETE FROM tenants WHERE id IN ($1,$2)',[tenantA,tenantB]);
      await client.query(`DROP OWNED BY ${testName}`);
      await client.query(`DROP ROLE IF EXISTS ${testName}`);
    }finally{
      await client.end();
    }
  });

  it('isolates select and all DML operations by request tenant context',async()=>{
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    expect((await client.query('SELECT id FROM employees ORDER BY id')).rows).toHaveLength(1);
    expect((await client.query('UPDATE employees SET name=$1 WHERE id=$2',[`hidden`,employeeB])).rowCount).toBe(0);
    expect((await client.query('DELETE FROM employees WHERE id=$1',[employeeB])).rowCount).toBe(0);
    await expect(client.query('INSERT INTO employees(tenant_id,name,email) VALUES ($1,$2,$3)',[tenantB,'cross-tenant',`${testName}-cross@example.invalid`])).rejects.toMatchObject({code:'42501'});
  });

  it('rejects cross-tenant composite foreign keys even when the row is otherwise valid',async()=>{
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    await expect(client.query('INSERT INTO devices(tenant_id,site_id,name) VALUES ($1,$2,$3)',[tenantA,siteB,'cross-tenant device'])).rejects.toMatchObject({code:'23503'});
    expect((await client.query('SELECT e.id,s.id FROM employees e JOIN sites s ON s.tenant_id=e.tenant_id WHERE e.id=$1 AND s.id=$2',[employeeA,siteB])).rows).toHaveLength(0);
  });
});
