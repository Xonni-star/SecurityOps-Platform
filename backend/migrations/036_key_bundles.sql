-- Phase 3, step 11b: accountable key bundles.

CREATE TABLE IF NOT EXISTS key_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','issued','partial','deactivated')),
  holder_user_id uuid,
  holder_employee_id uuid,
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, holder_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, holder_employee_id) REFERENCES employees(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  CHECK (NOT (holder_user_id IS NOT NULL AND holder_employee_id IS NOT NULL)),
  CHECK ((status IN ('issued','partial')) = (holder_user_id IS NOT NULL OR holder_employee_id IS NOT NULL)),
  CHECK (status NOT IN ('available','deactivated') OR (holder_user_id IS NULL AND holder_employee_id IS NULL))
);

CREATE TABLE IF NOT EXISTS key_bundle_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bundle_id uuid NOT NULL,
  key_id uuid NOT NULL,
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, bundle_id, key_id),
  UNIQUE (tenant_id, key_id),
  FOREIGN KEY (tenant_id, bundle_id) REFERENCES key_bundles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, key_id) REFERENCES keys(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, added_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS key_bundle_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bundle_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('created','item_added','issued','returned','partial_return','deactivated')),
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('available','issued','partial','deactivated')),
  holder_user_id uuid,
  holder_employee_id uuid,
  returned_key_ids uuid[] NOT NULL DEFAULT '{}',
  actor_user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, bundle_id) REFERENCES key_bundles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, holder_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, holder_employee_id) REFERENCES employees(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  CHECK (NOT (holder_user_id IS NOT NULL AND holder_employee_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS key_bundles_site_status_idx ON key_bundles(tenant_id, site_id, status);
CREATE INDEX IF NOT EXISTS key_bundle_items_key_idx ON key_bundle_items(tenant_id, key_id);
CREATE INDEX IF NOT EXISTS key_bundle_movements_bundle_idx ON key_bundle_movements(tenant_id, bundle_id, created_at DESC);

DROP TRIGGER IF EXISTS key_bundle_movements_immutable ON key_bundle_movements;
CREATE TRIGGER key_bundle_movements_immutable
  BEFORE UPDATE OR DELETE ON key_bundle_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_key_movement_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['key_bundles','key_bundle_items','key_bundle_movements'] LOOP
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
  ('keys:bundle_read', 'View tenant/site-scoped key bundles'),
  ('keys:bundle_write', 'Create and populate key bundles'),
  ('keys:bundle_issue', 'Issue a complete key bundle'),
  ('keys:bundle_return', 'Return all or part of a key bundle')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('keys:bundle_read','keys:bundle_write','keys:bundle_issue','keys:bundle_return')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'operator', id, 'tenant' FROM permissions
WHERE key IN ('keys:bundle_read','keys:bundle_issue','keys:bundle_return')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'tenant' FROM permissions WHERE key='keys:bundle_read'
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('keys:bundle_read','keys:bundle_write','keys:bundle_issue','keys:bundle_return')
ON CONFLICT (role, permission_id) DO NOTHING;

ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN (
    'alarms.panic','patrol.scan','watchbook.entry','scheduling.period',
    'scheduling.shift','scheduling.assignment','scheduling.rule_profile',
    'dms.document','keys.create','keys.issue','keys.return','keys.lost',
    'keys.deactivate','handover.create','handover.participant',
    'handover.confirm','handover.revoke','handover.correct',
    'keys.bundle.create','keys.bundle.item','keys.bundle.issue',
    'keys.bundle.return'
  ));
