CREATE TABLE IF NOT EXISTS qualification_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  default_validity_days integer CHECK (default_validity_days IS NULL OR default_validity_days > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS qualification_reminder_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  reminder_days integer[] NOT NULL DEFAULT ARRAY[90,60,30,7],
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(reminder_days) BETWEEN 1 AND 8)
);

ALTER TABLE qualification_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_catalog FORCE ROW LEVEL SECURITY;
ALTER TABLE qualification_reminder_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_reminder_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON qualification_catalog;
DROP POLICY IF EXISTS tenant_isolation ON qualification_reminder_settings;
CREATE POLICY tenant_isolation ON qualification_catalog
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON qualification_reminder_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO permissions(key,description) VALUES
 ('qualifications:read','View qualification catalog and employee qualifications'),
 ('qualifications:write','Manage qualification catalog and employee qualifications')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key IN ('qualifications:read','qualifications:write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'operator',id,'tenant' FROM permissions WHERE key='qualifications:read' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'viewer',id,'tenant' FROM permissions WHERE key='qualifications:read' ON CONFLICT DO NOTHING;
INSERT INTO qualification_reminder_settings(tenant_id)
SELECT id FROM tenants ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO qualification_catalog(tenant_id,code,name,default_validity_days)
SELECT t.id,v.code,v.name,v.days FROM tenants t CROSS JOIN (VALUES
 ('sachkunde_34a','§34a-Sachkunde',NULL::integer),
 ('erste_hilfe','Erste Hilfe',730),
 ('brandschutz','Brandschutz',730),
 ('fuehrungszeugnis','Führungszeugnis',1095),
 ('waffenschein','Waffenschein',1095)
) v(code,name,days) ON CONFLICT (tenant_id,code) DO NOTHING;

INSERT INTO notification_subscriptions(tenant_id,role,event_type,channel)
SELECT t.id,'admin','qualification.expiring','in_app' FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM notification_subscriptions s
  WHERE s.tenant_id=t.id AND s.role='admin' AND s.event_type='qualification.expiring' AND s.channel='in_app'
);
