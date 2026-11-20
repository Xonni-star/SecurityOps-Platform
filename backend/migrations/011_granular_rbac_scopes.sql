-- Phase 1, step 4: granular permission grants.
-- Existing role permissions remain valid as tenant-scoped grants.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','operator','viewer','superadmin'));

ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (role IN ('admin','operator','viewer','superadmin'));
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'tenant';
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_scope_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_scope_check CHECK (scope IN ('tenant','site','own','system'));

CREATE TABLE IF NOT EXISTS user_sites (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id,site_id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS user_sites_user_idx ON user_sites(tenant_id,user_id);
CREATE INDEX IF NOT EXISTS user_sites_site_idx ON user_sites(tenant_id,site_id);

CREATE TABLE IF NOT EXISTS resource_owners (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource text NOT NULL,
  resource_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,resource,resource_id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS resource_owners_user_idx ON resource_owners(tenant_id,user_id);

ALTER TABLE user_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_sites;
CREATE POLICY tenant_isolation ON user_sites
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE resource_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_owners FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resource_owners;
CREATE POLICY tenant_isolation ON resource_owners
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO permissions (key,description) VALUES
  ('alarm_priorities:read','View alarm priorities'),
  ('alarm_priorities:write','Create and edit alarm priorities'),
  ('escalation_rules:read','View escalation rules'),
  ('escalation_rules:write','Create and edit escalation rules'),
  ('patrols:read','View patrols'),
  ('patrols:write','Create and edit patrols'),
  ('telemetry:read','View telemetry'),
  ('telemetry:write','Create and edit telemetry'),
  ('positions:read','View positions'),
  ('positions:write','Create and edit positions'),
  ('incidents:read','View incidents'),
  ('incidents:write','Create and edit incidents'),
  ('nsl:read','View NSL operations'),
  ('nsl:write','Manage NSL operations'),
  ('reports:read','View reports'),
  ('messages:read','View messages'),
  ('messages:write','Send and manage messages'),
  ('notifications:read','View notifications'),
  ('notifications:write','Manage notifications'),
  ('timescan:read','View time tracking'),
  ('timescan:write','Manage time tracking'),
  ('audit:read','View audit events'),
  ('privacy:write','Manage privacy requests'),
  ('backup:read','View backup status'),
  ('nfc_devices:read','View NFC devices'),
  ('nfc_devices:write','Manage NFC devices'),
  ('push_subscriptions:write','Manage push subscriptions')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions (role,permission_id,scope)
SELECT 'operator',id,'tenant' FROM permissions
WHERE key NOT LIKE '%:delete'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions (role,permission_id,scope)
SELECT 'viewer',id,'tenant' FROM permissions
WHERE key LIKE '%:read'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions (role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions
ON CONFLICT (role,permission_id) DO NOTHING;
