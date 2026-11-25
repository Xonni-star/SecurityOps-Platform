import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const sourcePath=join(process.cwd(),'src','routes','maintenance.ts');
const migrationPath=join(process.cwd(),'migrations','050_maintenance_orders.sql');

test('maintenance workflow tables keep tenant RLS policies',async()=>{
  const migration=await readFile(migrationPath,'utf8');
  for(const table of ['maintenance_orders','maintenance_order_documents']){
    expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    expect(migration).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
  }
  expect(migration).toContain("current_setting('app.tenant_id', true)");
});

test('maintenance completion is atomic and guarded against repeat and concurrent writes',async()=>{
  const source=await readFile(sourcePath,'utf8');
  expect(source).toContain('withTransaction(');
  expect(source).toContain('FOR UPDATE');
  expect(source).toContain("status IN ('planned','open','in_progress')");
  expect(source).toContain('completed_by=$4');
  expect(source).toContain('recordAudit(',);
  expect(source).toMatch(/recordAudit\([^;]*client/s);
  // Notification delivery happens after the transaction body; no side effect
  // can roll back already committed business data.
  expect(source.indexOf('withTransaction(')).toBeLessThan(source.indexOf('await notifyResponsible(completion.updated'));
});
