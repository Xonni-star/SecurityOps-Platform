-- CRM cockpit: task priorities, separate task permissions and list/aggregate indexes.
-- Backward compatible: existing rows keep the default priority and no data is rewritten.

ALTER TABLE customer_tasks
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customer_tasks_priority_check') THEN
    ALTER TABLE customer_tasks ADD CONSTRAINT customer_tasks_priority_check
      CHECK (priority IN ('low','normal','high','critical'));
  END IF;
END $$;

-- List filters, combined status/risk filters and account-manager assignment.
CREATE INDEX IF NOT EXISTS customers_tenant_status_risk_idx
  ON customers(tenant_id, customer_status, risk_classification);
CREATE INDEX IF NOT EXISTS customers_tenant_manager_idx
  ON customers(tenant_id, account_manager_employee_id)
  WHERE account_manager_employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_tenant_created_idx
  ON customers(tenant_id, created_at DESC);

-- Contract status/deadline filters and reminder derivation.
CREATE INDEX IF NOT EXISTS contracts_tenant_customer_status_ends_idx
  ON contracts(tenant_id, customer_id, status, ends_on);
CREATE INDEX IF NOT EXISTS contracts_tenant_status_ends_idx
  ON contracts(tenant_id, status, ends_on)
  WHERE status NOT IN ('ended','archived');

-- Open/overdue follow-ups and customer history ("last activity").
CREATE INDEX IF NOT EXISTS customer_tasks_tenant_open_due_idx
  ON customer_tasks(tenant_id, status, due_at)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS customer_history_tenant_created_idx
  ON customer_history(tenant_id, created_at DESC);

-- Customer tasks are a separate file section: reading them must not require
-- access to contacts/contracts/documents, and writing stays distinct from
-- editing the customer master record.
INSERT INTO permissions(key, description) VALUES
  ('customer_tasks:read','View customer tasks and follow-ups'),
  ('customer_tasks:write','Create and edit customer tasks and follow-ups')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'admin', id, 'tenant' FROM permissions
WHERE key IN ('customer_tasks:read','customer_tasks:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'operator', id, 'tenant' FROM permissions
WHERE key IN ('customer_tasks:read','customer_tasks:write')
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'viewer', id, 'tenant' FROM permissions
WHERE key='customer_tasks:read'
ON CONFLICT (role, permission_id) DO NOTHING;
INSERT INTO role_permissions(role, permission_id, scope)
SELECT 'superadmin', id, 'system' FROM permissions
WHERE key IN ('customer_tasks:read','customer_tasks:write')
ON CONFLICT (role, permission_id) DO NOTHING;
