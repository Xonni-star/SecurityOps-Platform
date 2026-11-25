ALTER TABLE object_hazards
  ADD CONSTRAINT object_hazards_tenant_site_measure_key UNIQUE (tenant_id,site_id,id);

CREATE TABLE object_hazard_measures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  hazard_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text,
  responsible_employee_id uuid,
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','completed','cancelled')),
  completed_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,site_id,hazard_id) REFERENCES object_hazards(tenant_id,site_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,responsible_employee_id) REFERENCES employees(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((status='completed' AND completed_at IS NOT NULL) OR status<>'completed')
);
CREATE INDEX object_hazard_measures_site_due_idx
  ON object_hazard_measures(tenant_id,site_id,hazard_id,status,due_on);

INSERT INTO object_hazard_measures(
  tenant_id,site_id,hazard_id,title,description,responsible_employee_id,due_on,status,created_by,created_at,updated_at
)
SELECT tenant_id,site_id,id,'Required action',required_actions,responsible_employee_id,due_on,'open',created_by,created_at,updated_at
FROM object_hazards
WHERE NULLIF(btrim(required_actions),'') IS NOT NULL;

ALTER TABLE object_hazards DROP COLUMN required_actions;

ALTER TABLE object_hazard_measures ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_hazard_measures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON object_hazard_measures
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

INSERT INTO permissions(key,description) VALUES
  ('site_instructions:approve','Approve or return site instructions for revision')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key='site_instructions:approve'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'operator',id,'site' FROM permissions WHERE key='site_instructions:approve'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions WHERE key='site_instructions:approve'
ON CONFLICT (role,permission_id) DO NOTHING;
