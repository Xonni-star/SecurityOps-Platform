-- Backup scheduling, target configuration and immutable run/artifact evidence.
CREATE TABLE IF NOT EXISTS backup_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  schedule_kind text NOT NULL DEFAULT 'daily' CHECK (schedule_kind IN ('daily','weekly')),
  schedule_time time NOT NULL DEFAULT '02:00:00',
  schedule_weekday integer CHECK (schedule_weekday BETWEEN 0 AND 6),
  schedule_timezone text NOT NULL DEFAULT 'UTC',
  retention_count integer CHECK (retention_count IS NULL OR retention_count > 0),
  retention_days integer CHECK (retention_days IS NULL OR retention_days > 0),
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_status text NOT NULL DEFAULT 'never' CHECK (last_status IN ('never','running','succeeded','failed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS backup_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  target_kind text NOT NULL CHECK (target_kind IN ('local','smb','ftp','ftps','sftp','s3')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_secret text,
  secret_ref text,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (encrypted_secret IS NOT NULL OR secret_ref IS NOT NULL OR target_kind = 'local')
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  error_message text,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  successful_targets integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS backup_target_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  target_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0,
  error_message text,
  uploaded_at timestamptz,
  UNIQUE (tenant_id, run_id, target_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES backup_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_id) REFERENCES backup_targets(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backup_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('database','dms_blob','manifest')),
  source_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, run_id, artifact_kind, source_key),
  FOREIGN KEY (tenant_id, run_id) REFERENCES backup_runs(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS backup_runs_tenant_status_idx ON backup_runs(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS backup_target_runs_target_idx ON backup_target_runs(tenant_id, target_id, status);
CREATE INDEX IF NOT EXISTS backup_artifacts_run_idx ON backup_artifacts(tenant_id, run_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['backup_settings','backup_targets','backup_runs','backup_target_runs','backup_artifacts'] LOOP
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
  ('backup:read','View backup configuration, run status and artifacts'),
  ('backup:manage','Run backups and manage backup targets'),
  ('settings:read','View tenant settings'),
  ('settings:write','Change tenant settings')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('backup:read','backup:manage','settings:read','settings:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'tenant' FROM permissions
WHERE key IN ('backup:read','settings:read')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('backup:read','backup:manage','settings:read','settings:write')
ON CONFLICT (role, permission_id) DO NOTHING;
