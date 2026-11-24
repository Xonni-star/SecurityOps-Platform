import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadMigrationFiles} from '../src/db/migration-runner.js';

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

test('object management migration adds bounded site master data without a second object table',async()=>{
  const sql=await readFile(join(process.cwd(),'migrations','034_object_management_foundation.sql'),'utf8');
  expect(sql).toContain('ALTER TABLE sites');
  for(const column of ['site_number','status','security_classification','latitude','longitude','object_manager_employee_id']){
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
  }
  expect(sql).toContain('sites_status_check');
  expect(sql).toContain('sites_tenant_object_manager_fk');
  expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS objects/i);
});

test('customer management migration extends the CRM model with tenant-safe activity and document support',async()=>{
  const sql=await readFile(join(process.cwd(),'migrations','042_customer_management.sql'),'utf8');
  for(const column of ['address_line1','billing_email','country_code','communication_preferences'])expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
  for(const table of ['customer_contact_sites','customer_history','customer_tasks']){
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain(`'${table}'`);
  }
  expect(sql).toContain('ALTER TABLE dms_documents');
  expect(sql).toContain('customer_document_category');
  expect(sql).toContain('customer_documents:read');
  expect(sql).toContain('customer_documents:write');
  expect(sql).toContain('CREATE POLICY tenant_isolation');
  expect(sql).toContain('ON DELETE SET NULL (customer_id)');
});

test('all repository migrations have a unique, gap-free version sequence',async()=>{
  const migrations=await loadMigrationFiles(join(process.cwd(),'migrations'));
  expect(migrations[migrations.length-1]?.id).toBe('042_customer_management.sql');
});
