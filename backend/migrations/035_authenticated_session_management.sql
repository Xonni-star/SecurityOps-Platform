-- Administrative, tenant-scoped visibility and revocation for authenticated sessions.
INSERT INTO permissions(key,description) VALUES
  ('authenticated_sessions:read','View authenticated tenant sessions'),
  ('authenticated_sessions:write','Revoke authenticated tenant sessions')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions
WHERE key IN ('authenticated_sessions:read','authenticated_sessions:write')
ON CONFLICT (role,permission_id) DO NOTHING;

DROP POLICY IF EXISTS sessions_admin_lookup ON sessions;
CREATE POLICY sessions_admin_lookup ON sessions FOR SELECT
USING (
  token_hash=current_setting('app.session_token_hash', true)
  OR (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM sessions actor
      JOIN users actor_user ON actor_user.id=actor.user_id
      JOIN role_permissions actor_grant ON actor_grant.role=actor_user.role
      JOIN permissions actor_permission ON actor_permission.id=actor_grant.permission_id
      WHERE actor.token_hash=current_setting('app.session_token_hash', true)
        AND actor_permission.key='authenticated_sessions:read'
    )
  )
);

DROP POLICY IF EXISTS sessions_admin_revoke ON sessions;
CREATE POLICY sessions_admin_revoke ON sessions FOR UPDATE
USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  AND EXISTS (
    SELECT 1
    FROM sessions actor
    JOIN users actor_user ON actor_user.id=actor.user_id
    JOIN role_permissions actor_grant ON actor_grant.role=actor_user.role
    JOIN permissions actor_permission ON actor_permission.id=actor_grant.permission_id
    WHERE actor.token_hash=current_setting('app.session_token_hash', true)
      AND actor_permission.key='authenticated_sessions:write'
  )
)
WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX IF NOT EXISTS sessions_tenant_activity_idx
  ON sessions(tenant_id, revoked_at, expires_at, created_at DESC);
