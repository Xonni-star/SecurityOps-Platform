CREATE TABLE IF NOT EXISTS provider_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('smtp','sms')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_secret text,
  secret_ref text,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, provider),
  CHECK (encrypted_secret IS NOT NULL OR secret_ref IS NOT NULL OR provider = 'smtp')
);

ALTER TABLE provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON provider_settings;
CREATE POLICY tenant_isolation ON provider_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO permissions(key, description) VALUES
  ('providers:write','Change tenant provider settings')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions WHERE key='providers:write'
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions WHERE key='providers:write'
ON CONFLICT (role, permission_id) DO NOTHING;
