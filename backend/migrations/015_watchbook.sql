-- Phase 3, step 8: append-only digital watchbook.
-- Existing migrations are intentionally left unchanged.
CREATE TABLE IF NOT EXISTS watchbook_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS watchbook_priorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code IN ('critical','high','medium','low')),
  name text NOT NULL,
  rank integer NOT NULL CHECK (rank > 0),
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS watchbook_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  client_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_entry_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS watchbook_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  category_id uuid NOT NULL,
  priority_id uuid NOT NULL,
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  correction_of_revision_id uuid,
  authored_by uuid NOT NULL,
  authored_session_id uuid NOT NULL,
  authored_device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entry_id, revision_no),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES watchbook_entries(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, category_id) REFERENCES watchbook_categories(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, priority_id) REFERENCES watchbook_priorities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, correction_of_revision_id) REFERENCES watchbook_revisions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, authored_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, authored_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, authored_device_id) REFERENCES devices(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS watchbook_entries_tenant_created_idx ON watchbook_entries(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS watchbook_revisions_entry_idx ON watchbook_revisions(tenant_id, entry_id, revision_no DESC);

CREATE OR REPLACE FUNCTION prevent_watchbook_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Watchbook history is append-only' USING ERRCODE = '55006';
END;
$$;
DROP TRIGGER IF EXISTS watchbook_revisions_immutable ON watchbook_revisions;
CREATE TRIGGER watchbook_revisions_immutable
BEFORE UPDATE OR DELETE ON watchbook_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_watchbook_history_mutation();

ALTER TABLE watchbook_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchbook_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE watchbook_priorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchbook_priorities FORCE ROW LEVEL SECURITY;
ALTER TABLE watchbook_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchbook_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE watchbook_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchbook_revisions FORCE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['watchbook_categories','watchbook_priorities','watchbook_entries','watchbook_revisions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

INSERT INTO permissions(key, description) VALUES
  ('watchbook:read', 'View digital watchbook entries and history'),
  ('watchbook:write', 'Create digital watchbook entries'),
  ('watchbook:correct', 'Correct digital watchbook entries'),
  ('watchbook_categories:write', 'Manage digital watchbook categories'),
  ('watchbook_priorities:write', 'Manage digital watchbook priorities')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('watchbook:read','watchbook:write','watchbook:correct','watchbook_categories:write','watchbook_priorities:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'operator', id, 'tenant' FROM permissions
WHERE key IN ('watchbook:read','watchbook:write','watchbook:correct')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'tenant' FROM permissions WHERE key='watchbook:read'
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('watchbook:read','watchbook:write','watchbook:correct','watchbook_categories:write','watchbook_priorities:write')
ON CONFLICT (role, permission_id) DO NOTHING;

INSERT INTO watchbook_categories(tenant_id,code,name)
SELECT t.id, defaults.code, defaults.name
FROM tenants t
CROSS JOIN (VALUES
  ('patrol','Kontrollgang'),
  ('incident','Vorkommnis'),
  ('handover','Übergabe'),
  ('maintenance','Technik / Instandhaltung')
) AS defaults(code,name)
ON CONFLICT (tenant_id,code) DO NOTHING;

INSERT INTO watchbook_priorities(tenant_id,code,name,rank,color)
SELECT t.id, defaults.code, defaults.name, defaults.rank, defaults.color
FROM tenants t
CROSS JOIN (VALUES
  ('critical','Kritisch',1,'#dc2626'),
  ('high','Hoch',2,'#ea580c'),
  ('medium','Mittel',3,'#ca8a04'),
  ('low','Niedrig',4,'#16a34a')
) AS defaults(code,name,rank,color)
ON CONFLICT (tenant_id,code) DO NOTHING;

ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN ('alarms.panic','patrol.scan','watchbook.entry'));
