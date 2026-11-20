ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_permanently boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS users_lockout_idx ON users(tenant_id,locked_permanently,locked_until);

CREATE TABLE IF NOT EXISTS password_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE password_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON password_history;
CREATE POLICY tenant_isolation ON password_history
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

INSERT INTO permissions(key,description) VALUES
 ('account_security:manage','Manage tenant account lockouts and password policy'),
 ('account_security:read','View tenant account lockout status')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key IN ('account_security:manage','account_security:read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions WHERE key IN ('account_security:manage','account_security:read') ON CONFLICT DO NOTHING;
