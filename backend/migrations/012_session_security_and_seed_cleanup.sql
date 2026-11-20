ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
CREATE INDEX IF NOT EXISTS sessions_active_token_idx ON sessions(token_hash) WHERE revoked_at IS NULL;
DROP POLICY IF EXISTS sessions_revoke ON sessions;
CREATE POLICY sessions_revoke ON sessions FOR UPDATE
  USING (token_hash=current_setting('app.session_token_hash',true))
  WITH CHECK (token_hash=current_setting('app.session_token_hash',true));

DO $$
BEGIN
  PERFORM set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true);
  DELETE FROM users
  WHERE email='admin@example.com'
    AND password_hash='$argon2id$v=19$m=65536,t=3,p=4$bvnJpnO/Vq6gVslGLAskuQ$qbPvJtwnDyXQAv/pyVx4Q9fohMkbCIWsYfjZ4OW4yGo';
END $$;
