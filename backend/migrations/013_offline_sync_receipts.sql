CREATE TABLE IF NOT EXISTS sync_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('alarms.panic','patrol.scan')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  conflict_strategy text NOT NULL DEFAULT 'RECORD_AS_EXCEPTION'
    CHECK (conflict_strategy IN ('USE_LOCAL','USE_SERVER','RECORD_AS_EXCEPTION')),
  status text NOT NULL CHECK (status IN ('processing','completed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, mutation_id)
);
ALTER TABLE sync_receipts
  ADD CONSTRAINT sync_receipts_tenant_user_fk
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS sync_receipts_tenant_created_idx ON sync_receipts(tenant_id, created_at);

ALTER TABLE sync_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sync_receipts;
CREATE POLICY tenant_isolation ON sync_receipts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO permissions(key,description) VALUES
  ('mobile_sync:write','Submit idempotent offline mobile mutations')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT role,p.id,'tenant'
FROM permissions p
CROSS JOIN (VALUES ('admin'),('operator')) roles(role)
WHERE p.key='mobile_sync:write'
ON CONFLICT (role,permission_id) DO NOTHING;
