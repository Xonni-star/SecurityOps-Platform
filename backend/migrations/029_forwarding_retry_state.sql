ALTER TABLE alarm_forwarding_deliveries DROP CONSTRAINT IF EXISTS alarm_forwarding_deliveries_status_check;
ALTER TABLE alarm_forwarding_deliveries ADD CONSTRAINT alarm_forwarding_deliveries_status_check CHECK (status IN ('queued','forwarded','acknowledged','retrying','failed','exhausted'));
CREATE INDEX IF NOT EXISTS alarm_forwarding_deliveries_tenant_due_idx ON alarm_forwarding_deliveries(tenant_id,status,next_attempt_at);
