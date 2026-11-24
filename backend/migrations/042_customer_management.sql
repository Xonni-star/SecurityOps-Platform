-- Customer records, follow-ups, activity history, and secure DMS association.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS billing_email text,
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS country_code text NOT NULL DEFAULT 'DE',
  ADD COLUMN IF NOT EXISTS billing_address text,
  ADD COLUMN IF NOT EXISTS communication_preferences text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customers_country_code_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_country_code_check
      CHECK (country_code ~ '^[A-Z]{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customers_tenant_account_manager_fk') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_tenant_account_manager_fk
      FOREIGN KEY (tenant_id, account_manager_employee_id)
      REFERENCES employees(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS customer_contacts_customer_id_uk
  ON customer_contacts(tenant_id,customer_id,id);
CREATE TABLE IF NOT EXISTS customer_contact_sites (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,contact_id,site_id),
  FOREIGN KEY (tenant_id,customer_id,contact_id)
    REFERENCES customer_contacts(tenant_id,customer_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,customer_id,site_id)
    REFERENCES customer_sites(tenant_id,customer_id,site_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS customer_contact_sites_customer_idx
  ON customer_contact_sites(tenant_id,customer_id,site_id);

CREATE TABLE IF NOT EXISTS customer_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  actor_user_id uuid,
  event_type text NOT NULL,
  subject_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES users(tenant_id,id) ON DELETE SET NULL (actor_user_id)
);
CREATE INDEX IF NOT EXISTS customer_history_customer_idx
  ON customer_history(tenant_id,customer_id,created_at DESC);

CREATE TABLE IF NOT EXISTS customer_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  description text,
  due_at timestamptz,
  assigned_employee_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  created_by uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,assigned_employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL (assigned_employee_id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS customer_tasks_due_idx
  ON customer_tasks(tenant_id,customer_id,status,due_at);

ALTER TABLE dms_documents
  ADD COLUMN IF NOT EXISTS customer_id uuid,
  ADD COLUMN IF NOT EXISTS customer_document_category text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_tenant_customer_fk') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_documents_tenant_customer_fk
      FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE SET NULL (customer_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_customer_document_category_check') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_customer_document_category_check
      CHECK (customer_document_category IS NULL OR customer_document_category IN ('contract','service','insurance','security_plan','correspondence','other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_customer_document_pair_check') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_customer_document_pair_check
      CHECK ((customer_id IS NULL) = (customer_document_category IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS dms_documents_customer_idx
  ON dms_documents(tenant_id,customer_id,created_at DESC)
  WHERE customer_id IS NOT NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['customer_contact_sites','customer_history','customer_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

INSERT INTO permissions(key,description) VALUES
  ('customers:export','Export tenant customer records'),
  ('customer_documents:read','View confidential customer documents'),
  ('customer_documents:write','Upload and manage confidential customer documents')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key='customers:export'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'operator',id,'tenant' FROM permissions WHERE key='customers:export'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions WHERE key='customers:export'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key IN ('customer_documents:read','customer_documents:write')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'operator',id,'tenant' FROM permissions WHERE key IN ('customer_documents:read','customer_documents:write')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'viewer',id,'tenant' FROM permissions WHERE key='customer_documents:read'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions WHERE key IN ('customer_documents:read','customer_documents:write')
ON CONFLICT (role,permission_id) DO NOTHING;
