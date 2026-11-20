CREATE TABLE IF NOT EXISTS alarm_forwarding_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  channel text NOT NULL CHECK (channel IN ('webhook','email','sms')),
  endpoint text,
  recipient text,
  secret_ref text,
  encrypted_secret text,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK (channel='webhook' AND endpoint IS NOT NULL OR channel IN ('email','sms') AND recipient IS NOT NULL),
  CHECK (encrypted_secret IS NOT NULL OR secret_ref IS NOT NULL OR channel IN ('email','sms'))
);

CREATE UNIQUE INDEX IF NOT EXISTS alarm_forwarding_destinations_tenant_id_uidx
  ON alarm_forwarding_destinations(tenant_id, id);

CREATE TABLE IF NOT EXISTS alarm_forwarding_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  alarm_type text,
  priority_code text CHECK (priority_code IN ('critical','high','medium','low')),
  destination_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, destination_id) REFERENCES alarm_forwarding_destinations(tenant_id, id) ON DELETE CASCADE,
  CHECK (alarm_type IS NOT NULL OR priority_code IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS alarm_forwarding_rules_tenant_id_uidx
  ON alarm_forwarding_rules(tenant_id, id);

CREATE TABLE IF NOT EXISTS alarm_forwarding_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alarm_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  destination_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','forwarded','acknowledged','retrying','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_reference text,
  last_error text,
  forwarded_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, alarm_id, destination_id),
  FOREIGN KEY (tenant_id, alarm_id) REFERENCES alarms(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, rule_id) REFERENCES alarm_forwarding_rules(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, destination_id) REFERENCES alarm_forwarding_destinations(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS alarm_forwarding_deliveries_due_idx
  ON alarm_forwarding_deliveries(status,next_attempt_at);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['alarm_forwarding_destinations','alarm_forwarding_rules','alarm_forwarding_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

INSERT INTO permissions(key,description) VALUES
 ('alarm_forwarding:read','View external alarm forwarding configuration and delivery status'),
 ('alarm_forwarding:write','Manage external alarm forwarding configuration and acknowledge deliveries'),
 ('customer_reports:read','Read customer evidence reports'),
 ('customer_reports:export','Export customer evidence reports'),
 ('customer_portal:read','Read tenant/site-scoped customer evidence portal'),
 ('auth:lockout:read','View account lockout status'),
 ('auth:lockout:write','Unlock accounts and manage password policy')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role,permission_id)
SELECT 'admin',id FROM permissions WHERE key IN ('alarm_forwarding:read','alarm_forwarding:write','customer_reports:read','customer_reports:export','customer_portal:read','auth:lockout:read','auth:lockout:write')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'operator',id FROM permissions WHERE key IN ('alarm_forwarding:read','customer_reports:read','customer_portal:read','auth:lockout:read')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role,permission_id)
SELECT 'viewer',id FROM permissions WHERE key IN ('customer_reports:read','customer_portal:read')
ON CONFLICT DO NOTHING;
