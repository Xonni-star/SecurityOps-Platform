CREATE TABLE IF NOT EXISTS dms_document_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  document_type text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  responsible_employee_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,site_id,document_type),
  FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,responsible_employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS dms_document_requirements_site_idx
  ON dms_document_requirements(tenant_id,site_id,required);

ALTER TABLE dms_document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE dms_document_requirements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dms_document_requirements;
CREATE POLICY tenant_isolation ON dms_document_requirements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
