-- Phase 3, step 9: configurable tenant-scoped duty scheduling.
-- Existing migrations are intentionally left unchanged. Rule parameters are
-- tenant-owned configuration; this migration makes no legal or tariff claim.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS schedule_rule_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name, version),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS schedule_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  rule_profile_id uuid NOT NULL,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  client_mutation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_mutation_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, rule_profile_id) REFERENCES schedule_rule_profiles(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS schedule_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id uuid NOT NULL,
  site_id uuid NOT NULL,
  role_code text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  required_qualification_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  client_mutation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_mutation_id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES schedule_periods(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS schedule_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','cancelled')),
  created_by uuid NOT NULL,
  created_session_id uuid NOT NULL,
  client_mutation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, shift_id, employee_id),
  UNIQUE (tenant_id, client_mutation_id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES schedule_shifts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_session_id) REFERENCES sessions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS employee_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  code text NOT NULL,
  valid_from date,
  valid_until date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, code),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employee_absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  UNIQUE (tenant_id, id),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedule_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id uuid NOT NULL,
  shift_id uuid,
  assignment_id uuid,
  conflict_type text NOT NULL,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','error')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES schedule_periods(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shift_id) REFERENCES schedule_shifts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES schedule_assignments(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS schedule_periods_site_time_idx ON schedule_periods(tenant_id, site_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS schedule_shifts_period_time_idx ON schedule_shifts(tenant_id, period_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS schedule_assignments_employee_idx ON schedule_assignments(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS schedule_conflicts_period_idx ON schedule_conflicts(tenant_id, period_id, resolved_at);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'schedule_rule_profiles','schedule_periods','schedule_shifts','schedule_assignments',
    'employee_qualifications','employee_absences','schedule_conflicts'
  ] LOOP
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
  ('scheduling:read', 'View duty schedules and conflict findings'),
  ('scheduling:write', 'Create and update duty schedules'),
  ('scheduling:rules:write', 'Manage versioned scheduling rule profiles')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('scheduling:read','scheduling:write','scheduling:rules:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'operator', id, 'tenant' FROM permissions
WHERE key IN ('scheduling:read','scheduling:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'tenant' FROM permissions WHERE key='scheduling:read'
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('scheduling:read','scheduling:write','scheduling:rules:write')
ON CONFLICT (role, permission_id) DO NOTHING;

ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN ('alarms.panic','patrol.scan','watchbook.entry','scheduling.period','scheduling.shift','scheduling.assignment','scheduling.rule_profile'));
