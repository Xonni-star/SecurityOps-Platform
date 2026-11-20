ALTER TABLE backup_targets DROP CONSTRAINT IF EXISTS backup_targets_target_kind_check;
ALTER TABLE backup_targets ADD CONSTRAINT backup_targets_target_kind_check
  CHECK (target_kind IN ('local','smb','sftp','s3'));

INSERT INTO notification_subscriptions(tenant_id,role,event_type,channel)
SELECT t.id,'admin','backup.failed','in_app' FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM notification_subscriptions s
  WHERE s.tenant_id=t.id AND s.role='admin' AND s.event_type='backup.failed' AND s.channel='in_app'
);
