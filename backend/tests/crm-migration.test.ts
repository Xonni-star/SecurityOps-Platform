import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const migrationPath=join(process.cwd(),'migrations','033_crm_foundation.sql');

test('CRM foundation migration is additive and covers the canonical relationship model',async()=>{
  const sql=await readFile(migrationPath,'utf8');
  expect(sql).toContain('ALTER TABLE customers');
  for(const table of ['customer_sites','customer_contacts','contracts','contract_sites','services','contract_services']){
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain(`'${table}'`);
  }
  expect(sql).toContain('CREATE POLICY tenant_isolation');
  expect(sql).toContain('INSERT INTO customer_contacts');
  expect(sql).toContain('FROM customers c');
  expect(sql).toContain('NOT EXISTS');
  expect(sql).toContain('customers_tenant_account_manager_fk');
  expect(sql).toContain('FOREIGN KEY (tenant_id, customer_id)');
  expect(sql).toContain('UNIQUE (tenant_id, contract_number)');
  expect(sql).toContain("CHECK (ends_on IS NULL OR ends_on >= starts_on)");
});

test('CRM foundation migration does not introduce customer portal identities or client tenant trust',async()=>{
  const sql=await readFile(migrationPath,'utf8');
  expect(sql).not.toMatch(/portal_user|customer_user|external_identity/i);
  expect(sql).not.toMatch(/current_setting\(['"]app\.tenant_id['"]\)[^;]*tenant_id/i);
});
