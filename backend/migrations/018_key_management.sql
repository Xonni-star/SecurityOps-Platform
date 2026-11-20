-- Phase 3, step 11: tenant/site-scoped key management.
-- Keys keep only the minimum holder references required for accountability.

CREATE TABLE IF NOT EXISTS keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  key_code text NOT NULL CHECK (length(key_code) BETWEEN 1 AND 120),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  key_type text NOT NULL DEFAULT 'physical' CHECK (key_type IN ('physical','digital','master')),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','issued','lost','deactivated')),
  holder_user_id uuid,
  holder_employee_id uuid,
  issued_at timestamptz,
  issued_by uuid,
  returned_at timestamptz,
  returned_by uuid,
  lost_at timestamptz,
  deactivated_at timestamptz,
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key_code),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, holder_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, holder_employee_id) REFERENCES employees(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, issued_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, returned_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  CHECK (NOT (holder_user_id IS NOT NULL AND holder_employee_id IS NOT NULL)),
  CHECK ((status = 'issued') = (holder_user_id IS NOT NULL OR holder_employee_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS key_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('created','issued','returned','lost','deactivated')),
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('available','issued','lost','deactivated')),
  holder_user_id uuid,
  holder_employee_id uuid,
  actor_user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  device_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, key_id) REFERENCES keys(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, holder_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, holder_employee_id) REFERENCES employees(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE SET NULL,
  CHECK (NOT (holder_user_id IS NOT NULL AND holder_employee_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS keys_site_status_idx ON keys(tenant_id, site_id, status);
CREATE INDEX IF NOT EXISTS key_movements_key_idx ON key_movements(tenant_id, key_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_key_movement_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'key movement history is immutable';
END;
$$;
DROP TRIGGER IF EXISTS key_movements_immutable ON key_movements;
CREATE TRIGGER key_movements_immutable
  BEFORE UPDATE OR DELETE ON key_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_key_movement_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['keys','key_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

INSERT INTO permissions(key, description) VALUES
  ('keys:read', 'View tenant/site-scoped keys and movement history'),
  ('keys:write', 'Create tenant/site-scoped keys'),
  ('keys:issue', 'Issue a key to an authorized user or employee'),
  ('keys:return', 'Return a key held by the current user or process a return'),
  ('keys:manage', 'Record loss and deactivate keys')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('keys:read','keys:write','keys:issue','keys:return','keys:manage')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'operator', id, 'tenant' FROM permissions
WHERE key IN ('keys:read','keys:issue','keys:return','keys:manage')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'tenant' FROM permissions WHERE key='keys:read'
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('keys:read','keys:write','keys:issue','keys:return','keys:manage')
ON CONFLICT (role, permission_id) DO NOTHING;

ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN (
    'alarms.panic','patrol.scan','watchbook.entry','scheduling.period',
    'scheduling.shift','scheduling.assignment','scheduling.rule_profile',
    'dms.document','keys.create','keys.issue','keys.return','keys.lost',
    'keys.deactivate'
  ));
