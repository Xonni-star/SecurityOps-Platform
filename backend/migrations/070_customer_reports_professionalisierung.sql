-- Additive Migration: Kundenberichte mit nachvollziehbarer Datenbasis und
-- Freigabeworkflow. Bestehende Tabellen und Routen bleiben unberührt.
-- Es entsteht keine zweite Datenbank und keine Reporting-Parallelstruktur:
-- customer_report_releases speichert ausschließlich freigegebene Nachweis-
-- snapshots, damit das Kundenportal exakt die freigegebenen Daten ausliefert.

CREATE TABLE IF NOT EXISTS customer_report_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) >= 3),
  kind text NOT NULL CHECK (kind IN ('control-walks','watchbook','alarms','incidents')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','approved','rejected','revoked')),
  filters jsonb NOT NULL,
  allowed_site_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  documentation_profile text NOT NULL DEFAULT 'DIN-77200',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  previewed_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  approved_at timestamptz,
  approved_by uuid,
  rejected_reason text,
  revoked_at timestamptz,
  revoked_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,approved_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL,
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (status IN ('approved','in_review') OR previewed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS customer_report_releases_tenant_customer_idx
  ON customer_report_releases(tenant_id,customer_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS customer_report_releases_tenant_status_idx
  ON customer_report_releases(tenant_id,status,updated_at DESC);

ALTER TABLE customer_report_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_report_releases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customer_report_releases;
CREATE POLICY tenant_isolation ON customer_report_releases
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Neue Berechtigungen. customer_portal:read bleibt ausdrücklich lesend und
-- gewährt weder customer_reports:export noch eine andere Exportberechtigung.
INSERT INTO permissions(key,description) VALUES
  ('customer_reports:write','Kundenberichtsentwürfe anlegen und einreichen'),
  ('customer_reports:approve','Kundenberichte prüfen und freigeben')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role,permission_id,scope)
  SELECT 'admin',id,'tenant' FROM permissions WHERE key IN (
    'customer_reports:read','customer_reports:write','customer_reports:approve',
    'customer_reports:export','customer_portal:read'
  ) ON CONFLICT (role,permission_id) DO NOTHING;

INSERT INTO role_permissions(role,permission_id,scope)
  SELECT 'operator',id,'tenant' FROM permissions WHERE key IN (
    'customer_reports:read','customer_reports:write','customer_portal:read'
  ) ON CONFLICT (role,permission_id) DO NOTHING;

INSERT INTO role_permissions(role,permission_id,scope)
  SELECT 'viewer',id,'tenant' FROM permissions WHERE key IN (
    'customer_reports:read','customer_portal:read'
  ) ON CONFLICT (role,permission_id) DO NOTHING;

INSERT INTO role_permissions(role,permission_id,scope)
  SELECT 'superadmin',id,'system' FROM permissions WHERE key IN (
    'customer_reports:read','customer_reports:write','customer_reports:approve',
    'customer_reports:export','customer_portal:read'
  ) ON CONFLICT (role,permission_id) DO UPDATE SET scope='system';
