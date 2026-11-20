-- Phase 3, step 10: tenant-scoped document management.
-- Blob bytes are provider-owned; PostgreSQL stores only immutable metadata and
-- lifecycle/retention state. Existing migrations are intentionally unchanged.

CREATE TABLE IF NOT EXISTS dms_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  description text,
  document_status text NOT NULL DEFAULT 'active' CHECK (document_status IN ('active','deleted')),
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS dms_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  object_key text NOT NULL CHECK (object_key !~ '(^/|(^|/)\.\.(?:/|$))'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 160),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  lifecycle_state text NOT NULL DEFAULT 'quarantined' CHECK (lifecycle_state IN ('quarantined','scanning','available','rejected','deleted')),
  rejection_reason text,
  uploaded_by uuid NOT NULL,
  uploaded_session_id uuid NOT NULL,
  uploaded_device_id uuid,
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  scanned_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, version_no),
  UNIQUE (tenant_id, object_key),
  FOREIGN KEY (tenant_id, document_id) REFERENCES dms_documents(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, uploaded_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, uploaded_device_id) REFERENCES devices(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS dms_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  retention_days integer NOT NULL CHECK (retention_days > 0),
  applies_to text NOT NULL DEFAULT 'dms' CHECK (applies_to = 'dms'),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS dms_blob_backup_status (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  contract_version text NOT NULL DEFAULT 'dms-blob-backup-v1',
  last_backup_at timestamptz,
  last_restore_test_at timestamptz,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','healthy','degraded','failed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dms_documents_site_idx ON dms_documents(tenant_id, site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dms_versions_document_idx ON dms_versions(tenant_id, document_id, version_no DESC);
CREATE INDEX IF NOT EXISTS dms_versions_retention_idx ON dms_versions(tenant_id, retention_until) WHERE lifecycle_state = 'available';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['dms_documents','dms_versions','dms_retention_policies','dms_blob_backup_status'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

INSERT INTO permissions(key, description) VALUES
  ('dms:read', 'View tenant documents and available versions'),
  ('dms:write', 'Upload documents and create immutable versions'),
  ('dms:delete', 'Apply document retention deletion'),
  ('dms:backup:read', 'View the separate blob backup contract status')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('dms:read','dms:write','dms:delete','dms:backup:read')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'operator', id, 'tenant' FROM permissions
WHERE key IN ('dms:read','dms:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'tenant' FROM permissions WHERE key='dms:read'
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('dms:read','dms:write','dms:delete','dms:backup:read')
ON CONFLICT (role, permission_id) DO NOTHING;

ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN ('alarms.panic','patrol.scan','watchbook.entry','scheduling.period','scheduling.shift','scheduling.assignment','scheduling.rule_profile','dms.document'));
