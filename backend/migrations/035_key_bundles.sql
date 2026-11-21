-- Phase 3, step 11: explicit key bundles and atomic partial returns.

CREATE TABLE IF NOT EXISTS key_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS key_bundle_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bundle_id uuid NOT NULL,
  key_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bundle_id, key_id),
  UNIQUE (tenant_id, key_id),
  FOREIGN KEY (tenant_id, bundle_id) REFERENCES key_bundles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, key_id) REFERENCES keys(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS key_bundles_site_status_idx ON key_bundles(tenant_id, site_id, status);
CREATE INDEX IF NOT EXISTS key_bundle_members_bundle_idx ON key_bundle_members(tenant_id, bundle_id, position);

CREATE OR REPLACE FUNCTION prevent_key_bundle_member_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'key bundle membership is immutable';
END;
$$;
DROP TRIGGER IF EXISTS key_bundle_members_immutable ON key_bundle_members;
CREATE TRIGGER key_bundle_members_immutable
  BEFORE UPDATE OR DELETE ON key_bundle_members
  FOR EACH ROW EXECUTE FUNCTION prevent_key_bundle_member_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['key_bundles','key_bundle_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN (
    'alarms.panic','patrol.scan','watchbook.entry','scheduling.period',
    'scheduling.shift','scheduling.assignment','scheduling.rule_profile',
    'dms.document','keys.create','keys.issue','keys.return','keys.lost',
    'keys.deactivate','keys.bundle_create','keys.bundle_return'
  ));
