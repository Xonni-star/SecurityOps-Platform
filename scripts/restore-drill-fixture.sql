BEGIN;

INSERT INTO tenants (id, name)
VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Restore Drill Tenant A'),
  ('00000000-0000-0000-0000-0000000000b1', 'Restore Drill Tenant B');

SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000a1', false);

INSERT INTO users (id, tenant_id, email, password_hash, role)
VALUES ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'restore-a@example.invalid', 'fixture-not-used', 'admin');
INSERT INTO sites (id, tenant_id, name) VALUES ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', 'Restore Drill Site A');
INSERT INTO sessions (id, tenant_id, user_id, token_hash, csrf_token, expires_at)
VALUES ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'restore-drill-a-token', 'restore-drill-a-csrf', now() + interval '1 day');
INSERT INTO dms_documents (id, tenant_id, site_id, title, created_by, created_session_id)
VALUES ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3', 'Restore Drill A', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4');
INSERT INTO dms_versions (id, tenant_id, document_id, version_no, object_key, size_bytes, content_type, sha256, lifecycle_state, uploaded_by, uploaded_session_id, retention_until)
VALUES
  ('00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a5', 1, 'tenant-a/restore-drill-a.txt', 35, 'text/plain', 'dcef73c7525be08f21e2d18b8131c40f4bb6f031c8bceeb4a4d6cede9be71409', 'available', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', now() - interval '1 hour');
INSERT INTO dms_retention_policies (id, tenant_id, name, retention_days, created_by)
VALUES ('00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-0000000000a1', 'restore-drill', 30, '00000000-0000-0000-0000-0000000000a2');
INSERT INTO dms_blob_backup_status (tenant_id, provider, contract_version, last_backup_at, last_restore_test_at, status, details)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'minio-restore-drill', 'dms-blob-backup-v1', now(), now(), 'healthy', '{"fixture":true}');

SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000b1', false);

INSERT INTO users (id, tenant_id, email, password_hash, role)
VALUES ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1', 'restore-b@example.invalid', 'fixture-not-used', 'admin');
INSERT INTO sites (id, tenant_id, name) VALUES ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b1', 'Restore Drill Site B');
INSERT INTO sessions (id, tenant_id, user_id, token_hash, csrf_token, expires_at)
VALUES ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', 'restore-drill-b-token', 'restore-drill-b-csrf', now() + interval '1 day');
INSERT INTO dms_documents (id, tenant_id, site_id, title, created_by, created_session_id)
VALUES ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b3', 'Restore Drill B', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b4');
INSERT INTO dms_versions (id, tenant_id, document_id, version_no, object_key, size_bytes, content_type, sha256, lifecycle_state, uploaded_by, uploaded_session_id, retention_until)
VALUES
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b5', 1, 'tenant-b/restore-drill-b.txt', 35, 'text/plain', 'ab879461d62297c6260d9f3037803f40c35382161fc9808eb4f222a6b3365aaf', 'available', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b4', now() + interval '1 day');
INSERT INTO dms_retention_policies (id, tenant_id, name, retention_days, created_by)
VALUES ('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000b1', 'restore-drill', 30, '00000000-0000-0000-0000-0000000000b2');
INSERT INTO dms_blob_backup_status (tenant_id, provider, contract_version, last_backup_at, last_restore_test_at, status, details)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'minio-restore-drill', 'dms-blob-backup-v1', now(), now(), 'healthy', '{"fixture":true}');

COMMIT;
