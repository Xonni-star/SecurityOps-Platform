-- Maintenance workflow on top of the existing operational device inventory.
-- Watchbook stays the append-only evidence chain; this table carries workflow state only.
CREATE SEQUENCE IF NOT EXISTS maintenance_order_number_seq;

CREATE TABLE IF NOT EXISTS maintenance_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  device_id uuid NOT NULL,
  order_number text NOT NULL,
  maintenance_type text NOT NULL DEFAULT 'inspection',
  description text NOT NULL,
  priority_code text NOT NULL DEFAULT 'medium',
  due_on date,
  responsible_employee_id uuid,
  status text NOT NULL DEFAULT 'planned',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  performed_work text,
  result text,
  remarks text,
  next_maintenance_on date,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,order_number),
  FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,responsible_employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT maintenance_orders_type_check CHECK (maintenance_type IN ('inspection','preventive','corrective','repair','other')),
  CONSTRAINT maintenance_orders_priority_check CHECK (priority_code IN ('critical','high','medium','low')),
  CONSTRAINT maintenance_orders_status_check CHECK (status IN ('planned','open','in_progress','completed','cancelled')),
  CONSTRAINT maintenance_orders_completion_check CHECK ((status='completed' AND completed_at IS NOT NULL) OR status<>'completed')
);

CREATE UNIQUE INDEX IF NOT EXISTS maintenance_orders_tenant_device_site_idx
  ON maintenance_orders(tenant_id,site_id,id);
CREATE INDEX IF NOT EXISTS maintenance_orders_site_due_idx
  ON maintenance_orders(tenant_id,site_id,status,due_on);
CREATE INDEX IF NOT EXISTS maintenance_orders_device_due_idx
  ON maintenance_orders(tenant_id,device_id,status,due_on);

CREATE TABLE IF NOT EXISTS maintenance_order_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  document_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,order_id,document_id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES maintenance_orders(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,document_id) REFERENCES dms_documents(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE maintenance_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON maintenance_orders;
CREATE POLICY tenant_isolation ON maintenance_orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE maintenance_order_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_order_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON maintenance_order_documents;
CREATE POLICY tenant_isolation ON maintenance_order_documents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
