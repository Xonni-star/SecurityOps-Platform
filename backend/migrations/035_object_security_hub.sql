-- Object security hub: additive hierarchy, hazards and controlled instructions.

CREATE TABLE IF NOT EXISTS object_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  parent_id uuid,
  code text,
  name text NOT NULL,
  location_type text NOT NULL CHECK (location_type IN ('building','area','zone')),
  description text,
  security_level text NOT NULL DEFAULT 'unknown' CHECK (security_level IN ('unknown','low','medium','high','critical')),
  hazard_notes text,
  access_rules text,
  responsible_employee_id uuid,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES object_locations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, responsible_employee_id) REFERENCES employees(tenant_id, id) ON DELETE SET NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS object_locations_code_uidx
  ON object_locations(tenant_id, site_id, code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS object_locations_site_idx
  ON object_locations(tenant_id, site_id, parent_id, location_type, active);

CREATE TABLE IF NOT EXISTS object_hazards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  location_id uuid,
  title text NOT NULL,
  category text NOT NULL CHECK (category IN ('burglary','theft','vandalism','fire','robbery','unauthorized_access','sabotage','conflict','technical','environmental','other')),
  description text NOT NULL,
  likelihood integer NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  impact integer NOT NULL CHECK (impact BETWEEN 1 AND 5),
  risk_score integer GENERATED ALWAYS AS (likelihood * impact) STORED,
  protective_measures text,
  required_actions text,
  responsible_employee_id uuid,
  due_on date,
  review_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','mitigated','accepted','closed')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES object_locations(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, responsible_employee_id) REFERENCES employees(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK (due_on IS NULL OR review_on IS NULL OR review_on >= due_on)
);
CREATE INDEX IF NOT EXISTS object_hazards_site_idx
  ON object_hazards(tenant_id, site_id, status, risk_score DESC);

CREATE TABLE IF NOT EXISTS site_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  location_id uuid,
  title text NOT NULL,
  content text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','archived')),
  requires_acknowledgement boolean NOT NULL DEFAULT false,
  valid_from date,
  valid_until date,
  created_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  supersedes_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, title, version),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES object_locations(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES site_instructions(tenant_id, id) ON DELETE SET NULL,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CHECK ((status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status <> 'approved')
);
CREATE INDEX IF NOT EXISTS site_instructions_current_idx
  ON site_instructions(tenant_id, site_id, status, valid_until);

CREATE TABLE IF NOT EXISTS instruction_acknowledgements (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instruction_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_version integer NOT NULL CHECK (acknowledged_version > 0),
  PRIMARY KEY (tenant_id, instruction_id, employee_id, acknowledged_version),
  FOREIGN KEY (tenant_id, instruction_id) REFERENCES site_instructions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS instruction_acknowledgements_employee_idx
  ON instruction_acknowledgements(tenant_id, employee_id, acknowledged_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['object_locations','object_hazards','site_instructions','instruction_acknowledgements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;
