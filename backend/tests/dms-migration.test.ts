import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const migrationPath=join(process.cwd(),'migrations','069_dms_professionalisierung.sql');

test('DMS professionalisierung migration erweitert die Idempotenzaktion additiv',async()=>{
  const sql=await readFile(migrationPath,'utf8');
  expect(sql).toContain('ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check');
  expect(sql).toContain('ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check');
  expect(sql).toContain("'dms.document.version'");
  expect(sql).toContain("'dms.document'");
  expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE dms_documents/i);
});

test('DMS professionalisierung migration sichert Löschstatus und Performance indiziert',async()=>{
  const sql=await readFile(migrationPath,'utf8');
  expect(sql).toContain('dms_documents_deleted_at_check');
  expect(sql).toContain("CHECK ((document_status='deleted')=(deleted_at IS NOT NULL)) NOT VALID");
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS dms_documents_status_approval_idx');
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS dms_documents_deleted_idx');
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS dms_versions_lifecycle_idx');
  expect(sql).toContain('CREATE TRIGGER dms_documents_touch_updated_at');
  expect(sql).toContain('BEFORE UPDATE ON dms_documents');
});
