-- Records the user who actually completed a maintenance order.
-- Additive only: existing completed orders keep completed_by NULL; their
-- actor remains traceable through the existing maintenance_order.completed
-- audit event. No data is rewritten or removed.
ALTER TABLE maintenance_orders
  ADD COLUMN IF NOT EXISTS completed_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_orders_tenant_completer_fk') THEN
    ALTER TABLE maintenance_orders
      ADD CONSTRAINT maintenance_orders_tenant_completer_fk
      FOREIGN KEY (tenant_id, completed_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS maintenance_orders_tenant_completer_idx
  ON maintenance_orders(tenant_id, completed_by)
  WHERE completed_by IS NOT NULL;
