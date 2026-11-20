-- Phase 2, step 7: authenticated device registration and revocation.
-- The existing devices table remains the tenant-scoped device inventory.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_kind text NOT NULL DEFAULT 'operational';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_device_kind_check;
ALTER TABLE devices ADD CONSTRAINT devices_device_kind_check
  CHECK (device_kind IN ('operational','authenticated'));

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id uuid;
CREATE INDEX IF NOT EXISTS devices_authenticated_tenant_idx
  ON devices(tenant_id, device_kind, revoked_at);
CREATE INDEX IF NOT EXISTS sessions_device_active_idx
  ON sessions(tenant_id, device_id) WHERE revoked_at IS NULL;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_tenant_device_fk;
ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_device_fk
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS devices_session_lookup ON devices;
CREATE POLICY devices_session_lookup ON devices FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.tenant_id=devices.tenant_id
      AND s.device_id=devices.id
      AND s.token_hash=current_setting('app.session_token_hash', true)
  ));

DROP POLICY IF EXISTS sessions_device_revoke ON sessions;
CREATE POLICY sessions_device_revoke ON sessions FOR UPDATE
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM sessions actor
      JOIN users actor_user ON actor_user.id=actor.user_id
      JOIN role_permissions actor_grant ON actor_grant.role=actor_user.role
      JOIN permissions actor_permission ON actor_permission.id=actor_grant.permission_id
      WHERE actor.token_hash=current_setting('app.session_token_hash', true)
        AND actor_permission.key='authenticated_devices:write'
    )
  )
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO permissions(key,description) VALUES
  ('authenticated_devices:read','View authenticated tenant devices'),
  ('authenticated_devices:write','Register and revoke authenticated tenant devices')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions
WHERE key IN ('authenticated_devices:read','authenticated_devices:write')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'operator',id,'tenant' FROM permissions
WHERE key='authenticated_devices:read'
ON CONFLICT (role,permission_id) DO NOTHING;
