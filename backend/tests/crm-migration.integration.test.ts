import pg from 'pg';
import {randomUUID} from 'node:crypto';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
if(!databaseUrl)console.warn('PostgreSQL CRM migration integration skipped: POSTGRES_TEST_DATABASE_URL is not set.');
const describePostgres=databaseUrl?describe:describe.skip;

describePostgres('PostgreSQL CRM foundation constraints and tenant isolation',()=>{
  const testName=`securityops_crm_${randomUUID().replaceAll('-','')}`;
  let client:pg.Client;
  let tenantA:string;
  let tenantB:string;
  let customerA:string;
  let customerB:string;
  let siteA:string;
  let siteB:string;

  beforeAll(async()=>{
    if(!databaseUrl)throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    client=new pg.Client({connectionString:databaseUrl});
    await client.connect();
    const seed=await client.query<{tenant_a:string;tenant_b:string;customer_a:string;customer_b:string;site_a:string;site_b:string}>(`
      WITH a AS (INSERT INTO tenants(name) VALUES ('CRM A') RETURNING id),
      b AS (INSERT INTO tenants(name) VALUES ('CRM B') RETURNING id),
      ca AS (INSERT INTO customers(tenant_id,name,email) SELECT id,'Customer A',$1 FROM a RETURNING id,tenant_id),
      cb AS (INSERT INTO customers(tenant_id,name,email) SELECT id,'Customer B',$2 FROM b RETURNING id,tenant_id),
      sa AS (INSERT INTO sites(tenant_id,name) SELECT id,'Site A' FROM a RETURNING id,tenant_id),
      sb AS (INSERT INTO sites(tenant_id,name) SELECT id,'Site B' FROM b RETURNING id,tenant_id)
      SELECT a.id tenant_a,b.id tenant_b,ca.id customer_a,cb.id customer_b,sa.id site_a,sb.id site_b
      FROM a,b,ca,cb,sa,sb
    `,[`${testName}-a@example.invalid`,`${testName}-b@example.invalid`]);
    ({tenant_a:tenantA,tenant_b:tenantB,customer_a:customerA,customer_b:customerB,site_a:siteA,site_b:siteB}=seed.rows[0]);
    await client.query(`CREATE ROLE ${testName} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${testName}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON customer_sites,customer_contacts,contracts,contract_sites,services,contract_services,customers,sites,tenants TO ${testName}`);
    await client.query(`SET ROLE ${testName}`);
  });

  afterAll(async()=>{
    if(!client)return;
    await client.query('RESET ROLE');
    await client.query('DELETE FROM tenants WHERE id IN ($1,$2)',[tenantA,tenantB]);
    await client.query(`DROP ROLE IF EXISTS ${testName}`);
    await client.end();
  });

  it('supports customer contacts without inventing a legacy contact name',async()=>{
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    await client.query(
      'INSERT INTO customer_contacts(tenant_id,customer_id,email,is_primary) VALUES ($1,$2,$3,$4)',
      [tenantA,customerA,`${testName}-a@example.invalid`,true],
    );
    const result=await client.query<{email:string;first_name:string|null;last_name:string|null;is_primary:boolean}>(
      'SELECT email,first_name,last_name,is_primary FROM customer_contacts WHERE tenant_id=$1 AND customer_id=$2',
      [tenantA,customerA],
    );
    expect(result.rows).toEqual([{
      email:`${testName}-a@example.invalid`,
      first_name:null,
      last_name:null,
      is_primary:true,
    }]);
  });

  it('enforces customer-site and contract-service tenant boundaries',async()=>{
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    await expect(client.query(
      'INSERT INTO customer_sites(tenant_id,customer_id,site_id) VALUES ($1,$2,$3)',
      [tenantA,customerA,siteB],
    )).rejects.toMatchObject({code:'23503'});

    await expect(client.query(
      'INSERT INTO customer_sites(tenant_id,customer_id,site_id) VALUES ($1,$2,$3)',
      [tenantA,customerA,siteA],
    )).resolves.toBeTruthy();

    const contract=await client.query<{id:string}>(`
      INSERT INTO contracts(tenant_id,customer_id,contract_number,contract_type,starts_on)
      VALUES ($1,$2,$3,'security',$4) RETURNING id
    `,[tenantA,customerA,`${testName}-contract`,'2026-01-01']);
    const service=await client.query<{id:string}>(`
      INSERT INTO services(tenant_id,name) VALUES ($1,'Security service') RETURNING id
    `,[tenantA]);
    await expect(client.query(
      'INSERT INTO contract_services(tenant_id,contract_id,service_id) VALUES ($1,$2,$3)',
      [tenantA,contract.rows[0].id,service.rows[0].id],
    )).resolves.toBeTruthy();
    await expect(client.query(
      'INSERT INTO contract_services(tenant_id,contract_id,service_id) VALUES ($1,$2,$3)',
      [tenantB,contract.rows[0].id,service.rows[0].id],
    )).rejects.toMatchObject({code:'42501'});
  });

  it('keeps tenant rows invisible when the request tenant changes',async()=>{
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    expect((await client.query('SELECT id FROM customer_sites WHERE customer_id=$1',[customerA])).rows).toHaveLength(1);
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantB]);
    expect((await client.query('SELECT id FROM customer_sites WHERE customer_id=$1',[customerA])).rows).toHaveLength(0);
    expect((await client.query('SELECT id FROM customer_contacts WHERE customer_id=$1',[customerA])).rows).toHaveLength(0);
  });
});
