-- CRM foundation: additive customer relationships, contacts, contracts and services.
-- Portal identities and customer-facing authorization are intentionally deferred.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_number text,
  ADD COLUMN IF NOT EXISTS legal_form text,
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS customer_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS risk_classification text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS started_on date,
  ADD COLUMN IF NOT EXISTS ended_on date,
  ADD COLUMN IF NOT EXISTS account_manager_employee_id uuid,
  ADD COLUMN IF NOT EXISTS internal_notes text;

CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_customer_number_uidx
  ON customers(tenant_id, customer_number)
  WHERE customer_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_tenant_name_idx
  ON customers(tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS customers_tenant_status_idx
  ON customers(tenant_id, customer_status);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_status_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_status_check
      CHECK (customer_status IN ('prospect','negotiating','active','paused','at_risk','terminated','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_priority_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_priority_check
      CHECK (priority IN ('low','normal','high','critical'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_risk_classification_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_risk_classification_check
      CHECK (risk_classification IN ('unknown','low','medium','high','critical'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_dates_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_dates_check
      CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_tenant_account_manager_fk') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_tenant_account_manager_fk
      FOREIGN KEY (tenant_id, account_manager_employee_id)
      REFERENCES employees(tenant_id, id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS customer_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  site_id uuid NOT NULL,
  relationship_type text NOT NULL DEFAULT 'operational'
    CHECK (relationship_type IN ('primary','branch','operational','billing','other')),
  relationship_status text NOT NULL DEFAULT 'active'
    CHECK (relationship_status IN ('active','inactive','archived')),
  is_primary boolean NOT NULL DEFAULT false,
  starts_on date,
  ends_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, customer_id, site_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_sites_primary_uidx
  ON customer_sites(tenant_id, customer_id)
  WHERE is_primary AND relationship_status = 'active';
CREATE INDEX IF NOT EXISTS customer_sites_customer_idx
  ON customer_sites(tenant_id, customer_id, relationship_status);
CREATE INDEX IF NOT EXISTS customer_sites_site_idx
  ON customer_sites(tenant_id, site_id, relationship_status);

CREATE TABLE IF NOT EXISTS customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  first_name text,
  last_name text,
  job_title text,
  department text,
  email text,
  phone text,
  mobile_phone text,
  preferred_contact_method text
    CHECK (preferred_contact_method IS NULL OR preferred_contact_method IN ('email','phone','mobile','mail')),
  notes text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','archived')),
  is_primary boolean NOT NULL DEFAULT false,
  is_decision_maker boolean NOT NULL DEFAULT false,
  is_security_contact boolean NOT NULL DEFAULT false,
  is_billing_contact boolean NOT NULL DEFAULT false,
  is_emergency_contact boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE,
  CHECK (num_nonnulls(first_name, last_name, email, phone, mobile_phone) > 0),
  CHECK (email IS NULL OR length(btrim(email)) BETWEEN 3 AND 320)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_contacts_primary_uidx
  ON customer_contacts(tenant_id, customer_id)
  WHERE is_primary AND status = 'active';
CREATE INDEX IF NOT EXISTS customer_contacts_customer_idx
  ON customer_contacts(tenant_id, customer_id, status);
CREATE INDEX IF NOT EXISTS customer_contacts_email_idx
  ON customer_contacts(tenant_id, lower(email))
  WHERE email IS NOT NULL;

-- Preserve the existing single customer email without inventing a person's name.
INSERT INTO customer_contacts (tenant_id, customer_id, email, notes, is_primary)
SELECT c.tenant_id, c.id, btrim(c.email),
       'Imported from customers.email by CRM foundation migration.',
       true
FROM customers c
WHERE c.email IS NOT NULL
  AND btrim(c.email) <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM customer_contacts cc
    WHERE cc.tenant_id = c.tenant_id
      AND cc.customer_id = c.id
      AND cc.email = btrim(c.email)
  );

CREATE TABLE IF NOT EXISTS contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  contract_number text NOT NULL,
  contract_type text NOT NULL,
  scope text,
  starts_on date NOT NULL,
  ends_on date,
  renewal_type text NOT NULL DEFAULT 'manual'
    CHECK (renewal_type IN ('manual','automatic','none')),
  notice_period_days integer CHECK (notice_period_days IS NULL OR notice_period_days >= 0),
  next_termination_date date,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','pending_approval','active','paused','termination_received','expiring','ended','archived')),
  total_value numeric(14,2) CHECK (total_value IS NULL OR total_value >= 0),
  monthly_value numeric(14,2) CHECK (monthly_value IS NULL OR monthly_value >= 0),
  billing_model text
    CHECK (billing_model IS NULL OR billing_model IN ('fixed','hourly','usage_based','mixed')),
  sla text,
  account_manager_employee_id uuid,
  internal_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_number),
  UNIQUE (tenant_id, customer_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_manager_employee_id) REFERENCES employees(tenant_id, id) ON DELETE SET NULL,
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (next_termination_date IS NULL OR next_termination_date >= starts_on)
);

CREATE INDEX IF NOT EXISTS contracts_customer_idx
  ON contracts(tenant_id, customer_id, status);
CREATE INDEX IF NOT EXISTS contracts_expiry_idx
  ON contracts(tenant_id, ends_on)
  WHERE ends_on IS NOT NULL AND status NOT IN ('ended','archived');

CREATE TABLE IF NOT EXISTS contract_sites (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contract_id, site_id),
  FOREIGN KEY (tenant_id, customer_id, contract_id)
    REFERENCES contracts(tenant_id, customer_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id, site_id)
    REFERENCES customer_sites(tenant_id, customer_id, site_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS contract_sites_customer_idx
  ON contract_sites(tenant_id, customer_id, site_id);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_code text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  description text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','archived')),
  unit text,
  default_unit_price numeric(14,2) CHECK (default_unit_price IS NULL OR default_unit_price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, service_code)
);
CREATE INDEX IF NOT EXISTS services_tenant_status_idx
  ON services(tenant_id, status);

CREATE TABLE IF NOT EXISTS contract_services (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  service_id uuid NOT NULL,
  quantity numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit text,
  unit_price numeric(14,2) CHECK (unit_price IS NULL OR unit_price >= 0),
  starts_on date,
  ends_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contract_id, service_id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE RESTRICT,
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS contract_services_service_idx
  ON contract_services(tenant_id, service_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_sites','customer_contacts','contracts','contract_sites','services','contract_services'
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
  ('customers:read','View tenant customers and CRM relationships'),
  ('customers:write','Create and edit tenant customers and CRM relationships'),
  ('customer_contacts:read','View customer contacts'),
  ('customer_contacts:write','Create and edit customer contacts'),
  ('contracts:read','View customer contracts and services'),
  ('contracts:write','Create and edit customer contracts and services')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('customers:read','customers:write','customer_contacts:read','customer_contacts:write','contracts:read','contracts:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'operator', id, 'tenant' FROM permissions
WHERE key IN ('customers:read','customers:write','customer_contacts:read','customer_contacts:write','contracts:read','contracts:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'tenant' FROM permissions
WHERE key IN ('customers:read','customer_contacts:read','contracts:read')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('customers:read','customers:write','customer_contacts:read','customer_contacts:write','contracts:read','contracts:write')
ON CONFLICT (role, permission_id) DO NOTHING;
