import pg from 'pg';
import {randomUUID} from 'node:crypto';

const databaseUrl=process.env.POSTGRES_TEST_DATABASE_URL;
const describePostgres=databaseUrl?describe:describe.skip;

describePostgres('PostgreSQL watchbook guarantees',()=>{
  const suffix=randomUUID().replaceAll('-','');
  let client:pg.Client;
  let tenantA:string;
  let tenantB:string;
  let entryA:string;
  let revisionA:string;
  let categoryA:string;
  let priorityA:string;
  let userA:string;
  let sessionA:string;
  beforeAll(async()=>{
    client=new pg.Client({connectionString:databaseUrl});
    await client.connect();
    const seed=await client.query<{tenant_a:string;tenant_b:string;category_a:string;priority_a:string;user_a:string;session_a:string;entry_a:string;revision_a:string}>(`
      WITH a AS (INSERT INTO tenants(name) VALUES ($1) RETURNING id),
      b AS (INSERT INTO tenants(name) VALUES ($2) RETURNING id),
      ca AS (INSERT INTO watchbook_categories(tenant_id,code,name) SELECT id,'security','Security' FROM a RETURNING id),
      pa AS (INSERT INTO watchbook_priorities(tenant_id,code,name,rank,color) SELECT id,'high','Hoch',2,'#ff0000' FROM a RETURNING id),
      ua AS (INSERT INTO users(tenant_id,email,password_hash,role) SELECT id,$3,'not-used','operator' FROM a RETURNING id,tenant_id),
      sa AS (INSERT INTO sessions(tenant_id,user_id,token_hash,csrf_token,expires_at) SELECT tenant_id,id,$4,'csrf',now()+interval '1 hour' FROM ua RETURNING id,tenant_id),
      ea AS (INSERT INTO watchbook_entries(tenant_id,created_by,created_session_id) SELECT tenant_id,user_id,id FROM sa RETURNING id,tenant_id),
      ra AS (INSERT INTO watchbook_revisions(tenant_id,entry_id,revision_no,category_id,priority_id,content,authored_by,authored_session_id) SELECT ea.tenant_id,ea.id,1,ca.id,pa.id,'Initial',ua.id,sa.id FROM ea JOIN ca ON true JOIN pa ON true JOIN ua ON true JOIN sa ON true RETURNING id,tenant_id)
      SELECT a.id tenant_a,b.id tenant_b,ca.id category_a,pa.id priority_a,ua.id user_a,sa.id session_a,ea.id entry_a,ra.id revision_a FROM a,b,ca,pa,ua,sa,ea,ra
    `,[`watchbook-a-${suffix}`,`watchbook-b-${suffix}`,`${suffix}@example.invalid`,`${suffix}-token`]);
    ({tenant_a:tenantA,tenant_b:tenantB,category_a:categoryA,priority_a:priorityA,user_a:userA,session_a:sessionA,entry_a:entryA,revision_a:revisionA}=seed.rows[0]);
  });
  afterAll(async()=>{if(client){await client.query('DELETE FROM tenants WHERE id IN ($1,$2)',[tenantA,tenantB]);await client.end();}});
  it('isolates tenant rows and rejects revision update/delete',async()=>{
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    expect((await client.query('SELECT id FROM watchbook_entries')).rows).toHaveLength(1);
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantB]);
    expect((await client.query('SELECT id FROM watchbook_entries')).rows).toHaveLength(0);
    await client.query(`SELECT set_config('app.tenant_id',$1,false)`,[tenantA]);
    await expect(client.query('UPDATE watchbook_revisions SET content=$1 WHERE id=$2',['changed',revisionA])).rejects.toMatchObject({code:'55006'});
    await expect(client.query('DELETE FROM watchbook_revisions WHERE id=$1',[revisionA])).rejects.toMatchObject({code:'55006'});
  });
  it('binds correction to a session author and preserves prior revision',async()=>{
    const correction=(await client.query(`INSERT INTO watchbook_revisions(tenant_id,entry_id,revision_no,category_id,priority_id,content,correction_of_revision_id,authored_by,authored_session_id)
      VALUES($1,$2,2,$3,$4,'Corrected',$5,$6,$7) RETURNING id,authored_by,authored_session_id`,[tenantA,entryA,categoryA,priorityA,revisionA,userA,sessionA])).rows[0];
    expect(correction.authored_by).toBe(userA);
    expect(correction.authored_session_id).toBe(sessionA);
    expect((await client.query('SELECT content FROM watchbook_revisions WHERE id=$1',[revisionA])).rows[0].content).toBe('Initial');
  });
});
