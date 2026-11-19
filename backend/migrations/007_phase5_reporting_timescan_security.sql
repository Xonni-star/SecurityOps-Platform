CREATE TABLE IF NOT EXISTS work_time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'timescan',
  external_id text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  minutes integer NOT NULL CHECK (minutes >= 0),
  status text NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','adjusted','deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,provider,external_id)
);
CREATE INDEX IF NOT EXISTS work_time_entries_filter_idx
  ON work_time_entries(tenant_id,started_at,employee_id);

CREATE TABLE IF NOT EXISTS timescan_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  account_ref text NOT NULL,
  secret_ref text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS timescan_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  imported_count integer NOT NULL DEFAULT 0,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS timescan_sync_runs_tenant_idx
  ON timescan_sync_runs(tenant_id,started_at DESC);

CREATE TABLE IF NOT EXISTS retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  data_type text NOT NULL CHECK (data_type IN ('audit','notifications','telemetry','positions','work_time')),
  retention_days integer NOT NULL CHECK (retention_days >= 30),
  purpose text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,data_type)
);

INSERT INTO permissions(key,description) VALUES
 ('reports:read','View management reports and statistics'),
 ('timescan:read','View TimeScan configuration and sync runs'),
 ('timescan:write','Manage TimeScan configuration and synchronization'),
 ('audit:read','View and export audit events'),
 ('privacy:write','Run data subject export and deletion'),
 ('backup:read','View backup status')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'admin',id FROM permissions WHERE key IN
 ('reports:read','timescan:read','timescan:write','audit:read','privacy:write','backup:read')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'operator',id FROM permissions WHERE key IN ('reports:read','timescan:read')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'viewer',id FROM permissions WHERE key IN ('reports:read')
ON CONFLICT DO NOTHING;

INSERT INTO retention_policies(tenant_id,data_type,retention_days,purpose)
SELECT id,'audit',365,'Accountability and security investigations' FROM tenants
ON CONFLICT DO NOTHING;
INSERT INTO retention_policies(tenant_id,data_type,retention_days,purpose)
SELECT id,'notifications',90,'Operational notification history' FROM tenants
ON CONFLICT DO NOTHING;
INSERT INTO retention_policies(tenant_id,data_type,retention_days,purpose)
SELECT id,'telemetry',90,'Sensor safety analysis' FROM tenants
ON CONFLICT DO NOTHING;
INSERT INTO retention_policies(tenant_id,data_type,retention_days,purpose)
SELECT id,'positions',30,'Live operational location only' FROM tenants
ON CONFLICT DO NOTHING;
INSERT INTO retention_policies(tenant_id,data_type,retention_days,purpose)
SELECT id,'work_time',730,'Contractual working-time evidence' FROM tenants
ON CONFLICT DO NOTHING;
