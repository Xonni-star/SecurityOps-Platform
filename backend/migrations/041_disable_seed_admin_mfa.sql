-- Local seed account: disable MFA only for the Acme seed admin.
DO $$
BEGIN
  PERFORM set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true);

  INSERT INTO tenant_mfa_policies(tenant_id,required_roles,updated_at)
  VALUES ('00000000-0000-0000-0000-000000000001',ARRAY[]::text[],now())
  ON CONFLICT (tenant_id) DO UPDATE
  SET required_roles=ARRAY[]::text[],updated_at=now();

  DELETE FROM mfa_recovery_codes r
  USING users u
  WHERE r.tenant_id=u.tenant_id
    AND r.user_id=u.id
    AND u.tenant_id='00000000-0000-0000-0000-000000000001'
    AND u.email='admin@example.com';

  UPDATE users
  SET mfa_secret_ciphertext=NULL,
      mfa_secret_nonce=NULL,
      mfa_secret_tag=NULL,
      mfa_enrolled_at=NULL,
      mfa_failed_attempts=0,
      mfa_locked_until=NULL,
      mfa_last_used_step=NULL
  WHERE tenant_id='00000000-0000-0000-0000-000000000001'
    AND email='admin@example.com';

  UPDATE sessions s
  SET mfa_pending=false,
      mfa_verified_at=now(),
      updated_at=now()
  FROM users u
  WHERE s.tenant_id=u.tenant_id
    AND s.user_id=u.id
    AND u.tenant_id='00000000-0000-0000-0000-000000000001'
    AND u.email='admin@example.com';
END $$;
