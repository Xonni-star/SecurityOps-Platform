-- Phase 4, step 13a: encrypted TOTP MFA, recovery codes and tenant policy.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_ciphertext text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_nonce text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_tag text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_locked_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_used_step bigint;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_pending boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
CREATE INDEX IF NOT EXISTS sessions_pending_mfa_idx ON sessions(token_hash) WHERE mfa_pending=true AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant_mfa_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  required_roles text[] NOT NULL DEFAULT ARRAY['admin','superadmin'],
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes(tenant_id,user_id) WHERE used_at IS NULL;

ALTER TABLE tenant_mfa_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_mfa_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_mfa_policies;
CREATE POLICY tenant_isolation ON tenant_mfa_policies
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mfa_recovery_codes;
CREATE POLICY tenant_isolation ON mfa_recovery_codes
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

INSERT INTO permissions(key,description) VALUES
  ('mfa:enroll','Enroll the current account for MFA'),
  ('mfa:policy:write','Configure tenant MFA policy'),
  ('mfa:reset','Reset MFA and revoke a user''s sessions')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key IN ('mfa:enroll','mfa:policy:write','mfa:reset')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions WHERE key IN ('mfa:enroll','mfa:policy:write','mfa:reset')
ON CONFLICT (role,permission_id) DO NOTHING;

INSERT INTO tenant_mfa_policies(tenant_id)
SELECT id FROM tenants ON CONFLICT (tenant_id) DO NOTHING;
