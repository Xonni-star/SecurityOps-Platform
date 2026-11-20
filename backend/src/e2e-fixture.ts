import argon2 from "argon2";
import { pool } from "./db/pool.js";
import { env } from "./config/env.js";

const fixture = process.env.E2E_FIXTURE === "isolated";
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const tenantName = process.env.E2E_TENANT_NAME ?? "e2e-phase-4";

if (
  env.NODE_ENV === "production" ||
  !fixture ||
  !email ||
  !password ||
  !tenantName.startsWith("e2e-")
) {
  throw new Error(
    "Refusing E2E fixture setup: require non-production E2E_FIXTURE=isolated, E2E_EMAIL, E2E_PASSWORD, and an e2e-* tenant",
  );
}

const ids = {
  tenant: "00000000-0000-4000-8000-000000000101",
  user: "00000000-0000-4000-8000-000000000102",
  site: "00000000-0000-4000-8000-000000000103",
  employee: "00000000-0000-4000-8000-000000000104",
  point: "00000000-0000-4000-8000-000000000105",
  route: "00000000-0000-4000-8000-000000000106",
  priority: "00000000-0000-4000-8000-000000000107",
  device: "00000000-0000-4000-8000-000000000108",
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await client.query(
    `INSERT INTO tenants(id,name) VALUES($1,$2)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,updated_at=now()`,
    [ids.tenant, tenantName],
  );
  await client.query(
    `INSERT INTO users(id,tenant_id,email,password_hash,role,mfa_secret_ciphertext,mfa_secret_nonce,mfa_secret_tag,mfa_enrolled_at)
     VALUES($1,$2,$3,$4,'operator',NULL,NULL,NULL,NULL)
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,
       role='operator',mfa_secret_ciphertext=NULL,mfa_secret_nonce=NULL,mfa_secret_tag=NULL,mfa_enrolled_at=NULL,updated_at=now()`,
    [ids.user, ids.tenant, email, hash],
  );
  await client.query(
    `INSERT INTO sites(id,tenant_id,name,address) VALUES($1,$2,'E2E Leitstellenobjekt','E2E-Teststraße 1')
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,name=EXCLUDED.name,address=EXCLUDED.address,updated_at=now()`,
    [ids.site, ids.tenant],
  );
  await client.query(
    `INSERT INTO employees(id,tenant_id,name,email,title) VALUES($1,$2,'E2E Streife','e2e-employee@example.invalid','Wachschutz')
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,name=EXCLUDED.name,email=EXCLUDED.email,title=EXCLUDED.title,updated_at=now()`,
    [ids.employee, ids.tenant],
  );
  await client.query(
    `INSERT INTO devices(id,tenant_id,name,status,device_kind,metadata) VALUES($1,$2,'E2E Mobilgerät','online','authenticated','{"source":"playwright-e2e"}')
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,status='online',revoked_at=NULL,updated_at=now()`,
    [ids.device, ids.tenant],
  );
  await client.query(
    `INSERT INTO alarm_priorities(id,tenant_id,name,code,rank,color) VALUES($1,$2,'E2E Hoch','high',2,'#ea580c')
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,name=EXCLUDED.name,code=EXCLUDED.code,rank=EXCLUDED.rank,updated_at=now()`,
    [ids.priority, ids.tenant],
  );
  await client.query(
    `INSERT INTO control_points(id,tenant_id,site_id,name,nfc_uid,sequence) VALUES($1,$2,$3,'E2E Eingang','e2e-nfc-01',1)
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,site_id=EXCLUDED.site_id,nfc_uid=EXCLUDED.nfc_uid,updated_at=now()`,
    [ids.point, ids.tenant, ids.site],
  );
  await client.query(
    `INSERT INTO patrol_routes(id,tenant_id,site_id,name) VALUES($1,$2,$3,'E2E Nachtstreife')
     ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,site_id=EXCLUDED.site_id,name=EXCLUDED.name,updated_at=now()`,
    [ids.route, ids.tenant, ids.site],
  );
  await client.query(
    `INSERT INTO patrol_route_points(tenant_id,route_id,control_point_id,sequence,expected_offset_seconds)
     VALUES($1,$2,$3,1,0) ON CONFLICT(route_id,control_point_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,sequence=1,expected_offset_seconds=0`,
    [ids.tenant, ids.route, ids.point],
  );
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      email,
      tenantId: ids.tenant,
      siteId: ids.site,
      employeeId: ids.employee,
      routeId: ids.route,
      priorityId: ids.priority,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
