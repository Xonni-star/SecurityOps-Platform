CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text CHECK (role IN ('admin','operator','viewer')),
  event_type text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms','in_app')),
  recipient text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR role IS NOT NULL),
  CHECK (channel='in_app' OR recipient IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS notification_subscriptions_lookup_idx
  ON notification_subscriptions(tenant_id,event_type,channel,enabled);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(tenant_id,user_id,read_at,created_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_key,channel,recipient)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx
  ON notification_deliveries(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS direct_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  recipient_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recipient_user_id IS NOT NULL OR recipient_employee_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS direct_messages_recipient_idx
  ON direct_messages(tenant_id,recipient_user_id,read_at,created_at DESC);

CREATE TABLE IF NOT EXISTS shift_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  open_alarms jsonb NOT NULL DEFAULT '[]'::jsonb,
  active_incidents jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS shift_handovers_tenant_idx ON shift_handovers(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_idx ON audit_events(tenant_id,created_at DESC);

INSERT INTO permissions(key,description) VALUES
 ('nsl:read','View the NSL operations dashboard'),
 ('nsl:write','Manage NSL handovers and notification rules'),
 ('reports:read','Export alarm and incident reports'),
 ('messages:read','Read direct messages'),
 ('messages:write','Send and acknowledge direct messages'),
 ('notifications:read','Read notification center'),
 ('notifications:write','Manage notification subscriptions')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'admin',id FROM permissions WHERE key IN
 ('nsl:read','nsl:write','reports:read','messages:read','messages:write','notifications:read','notifications:write')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'operator',id FROM permissions WHERE key IN
 ('nsl:read','nsl:write','reports:read','messages:read','messages:write','notifications:read','notifications:write')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'viewer',id FROM permissions WHERE key IN
 ('nsl:read','reports:read','messages:read','notifications:read')
ON CONFLICT DO NOTHING;

INSERT INTO notification_subscriptions(tenant_id,user_id,event_type,channel,recipient)
SELECT u.tenant_id,u.id,'alarm.created','email',u.email FROM users u
ON CONFLICT DO NOTHING;
INSERT INTO notification_subscriptions(tenant_id,user_id,event_type,channel)
SELECT u.tenant_id,u.id,'alarm.created','in_app' FROM users u
ON CONFLICT DO NOTHING;
INSERT INTO notification_subscriptions(tenant_id,user_id,event_type,channel,recipient)
SELECT u.tenant_id,u.id,'incident.created','email',u.email FROM users u
ON CONFLICT DO NOTHING;
