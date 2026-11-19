ALTER TABLE alarms ADD COLUMN IF NOT EXISTS client_event_id uuid;
ALTER TABLE patrol_scans ADD COLUMN IF NOT EXISTS client_event_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS alarms_mobile_event_uidx
  ON alarms(tenant_id, client_event_id) WHERE client_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS patrol_scans_mobile_event_uidx
  ON patrol_scans(tenant_id, client_event_id) WHERE client_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  subscription jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS push_subscriptions_tenant_idx ON push_subscriptions(tenant_id);
INSERT INTO permissions(key,description) VALUES
  ('push_subscriptions:write','Register mobile push subscriptions')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'admin',id FROM permissions WHERE key='push_subscriptions:write'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'operator',id FROM permissions WHERE key='push_subscriptions:write'
ON CONFLICT DO NOTHING;
