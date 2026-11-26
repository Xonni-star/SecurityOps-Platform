-- Enterprise key management cockpit: master data, accountable receipts, loss reports,
-- inventory checks and idempotent return-due reminders. Additive only: existing keys,
-- movements and bundles keep their rows and their append-only history.

ALTER TABLE keys
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS manufacturer text,
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS building text,
  ADD COLUMN IF NOT EXISTS area text,
  ADD COLUMN IF NOT EXISTS access_point text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS remarks text,
  ADD COLUMN IF NOT EXISTS responsible_employee_id uuid,
  ADD COLUMN IF NOT EXISTS due_at timestamptz;

ALTER TABLE keys DROP CONSTRAINT IF EXISTS keys_key_type_check;
ALTER TABLE keys ADD CONSTRAINT keys_key_type_v2_check
  CHECK (key_type IN ('physical','master','transponder','access_card','electronic','digital','other'));
ALTER TABLE keys DROP CONSTRAINT IF EXISTS keys_status_check;
ALTER TABLE keys ADD CONSTRAINT keys_status_v2_check
  CHECK (status IN ('available','issued','overdue','lost','blocked','deactivated'));

-- Legacy holder/status equivalence prevented documenting an issued key whose holder
-- is unknown; the cockpit now surfaces that as an A-priority action instead.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='keys'::regclass AND contype='c'
      AND conname IN ('keys_check','keys_check1','keys_holder_status_check')
  LOOP
    EXECUTE format('ALTER TABLE keys DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END $$;
ALTER TABLE keys ADD CONSTRAINT keys_single_holder_check
  CHECK (NOT (holder_user_id IS NOT NULL AND holder_employee_id IS NOT NULL));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='keys_tenant_responsible_fk') THEN
    ALTER TABLE keys ADD CONSTRAINT keys_tenant_responsible_fk
      FOREIGN KEY (tenant_id,responsible_employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE key_movements DROP CONSTRAINT IF EXISTS key_movements_movement_type_check;
ALTER TABLE key_movements ADD CONSTRAINT key_movements_movement_type_v2_check
  CHECK (movement_type IN ('created','issued','returned','lost','deactivated','blocked','reactivated'));
ALTER TABLE key_movements DROP CONSTRAINT IF EXISTS key_movements_to_status_check;
ALTER TABLE key_movements ADD CONSTRAINT key_movements_to_status_v2_check
  CHECK (to_status IN ('available','issued','lost','blocked','deactivated'));

ALTER TABLE key_bundle_movements DROP CONSTRAINT IF EXISTS key_bundle_movements_movement_type_check;
ALTER TABLE key_bundle_movements ADD CONSTRAINT key_bundle_movements_movement_type_v2_check
  CHECK (movement_type IN ('created','item_added','item_removed','issued','returned','partial_return','deactivated'));

CREATE TABLE IF NOT EXISTS key_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('issue','return')),
  holder_user_id uuid,
  holder_employee_id uuid,
  due_at timestamptz,
  condition text CHECK (condition IN ('good','damaged','incomplete','nonfunctional','suspicious_change')),
  reason text,
  handover_notes text,
  confirmation_name text,
  receipt_document_id uuid,
  actor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,key_id) REFERENCES keys(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,holder_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,holder_employee_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,receipt_document_id) REFERENCES dms_documents(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK (NOT (holder_user_id IS NOT NULL AND holder_employee_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS key_loss_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_id uuid NOT NULL,
  last_holder_user_id uuid,
  last_holder_employee_id uuid,
  site_id uuid,
  lost_at timestamptz NOT NULL,
  reported_at timestamptz NOT NULL,
  reporter_name text NOT NULL CHECK (length(reporter_name) BETWEEN 1 AND 160),
  description text,
  risk_assessment text,
  immediate_measures text,
  follow_up text,
  notes text,
  status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','review','security_measure_required','replacement_required','closed')),
  incident_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,key_id) REFERENCES keys(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,last_holder_user_id) REFERENCES users(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,last_holder_employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,incident_id) REFERENCES incidents(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK (NOT (last_holder_user_id IS NOT NULL AND last_holder_employee_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS key_qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_id uuid NOT NULL,
  token_hash text NOT NULL CHECK (length(token_hash)=64),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,token_hash),
  FOREIGN KEY (tenant_id,key_id) REFERENCES keys(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS key_inventory_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  bundle_id uuid,
  checked_at timestamptz NOT NULL,
  checker_name text NOT NULL CHECK (length(checker_name) BETWEEN 1 AND 160),
  notes text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,bundle_id) REFERENCES key_bundles(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS key_inventory_check_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  check_id uuid NOT NULL,
  key_id uuid NOT NULL,
  expected_present boolean NOT NULL,
  found boolean NOT NULL,
  actual_condition text,
  PRIMARY KEY (tenant_id,check_id,key_id),
  FOREIGN KEY (tenant_id,check_id) REFERENCES key_inventory_checks(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,key_id) REFERENCES keys(tenant_id,id) ON DELETE RESTRICT,
  CHECK (actual_condition IS NULL OR actual_condition IN ('good','damaged','incomplete','nonfunctional','suspicious_change'))
);

CREATE TABLE IF NOT EXISTS key_reminder_state (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  days integer NOT NULL CHECK (days IN (-1,0,1,3,7)),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,key_id,due_at,days),
  FOREIGN KEY (tenant_id,key_id) REFERENCES keys(tenant_id,id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS keys_tenant_due_idx ON keys(tenant_id,due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS keys_tenant_status_due_idx ON keys(tenant_id,status,due_at);
CREATE INDEX IF NOT EXISTS keys_tenant_label_idx ON keys(tenant_id,label);
CREATE INDEX IF NOT EXISTS keys_tenant_holder_user_idx ON keys(tenant_id,holder_user_id);
CREATE INDEX IF NOT EXISTS keys_tenant_holder_employee_idx ON keys(tenant_id,holder_employee_id);
CREATE INDEX IF NOT EXISTS keys_tenant_responsible_idx ON keys(tenant_id,responsible_employee_id);
CREATE INDEX IF NOT EXISTS key_receipts_tenant_key_idx ON key_receipts(tenant_id,key_id,created_at DESC);
CREATE INDEX IF NOT EXISTS key_loss_reports_tenant_key_idx ON key_loss_reports(tenant_id,key_id,created_at DESC);
CREATE INDEX IF NOT EXISTS key_loss_reports_tenant_status_idx ON key_loss_reports(tenant_id,status);
CREATE INDEX IF NOT EXISTS key_qr_tokens_tenant_expiry_idx ON key_qr_tokens(tenant_id,expires_at);
CREATE INDEX IF NOT EXISTS key_inventory_checks_tenant_site_idx ON key_inventory_checks(tenant_id,site_id,checked_at DESC);
CREATE INDEX IF NOT EXISTS key_inventory_checks_tenant_bundle_idx ON key_inventory_checks(tenant_id,bundle_id,checked_at DESC);
CREATE INDEX IF NOT EXISTS key_inventory_check_items_tenant_key_idx ON key_inventory_check_items(tenant_id,key_id);
CREATE INDEX IF NOT EXISTS key_reminder_state_tenant_due_idx ON key_reminder_state(tenant_id,due_at,days);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'key_receipts','key_loss_reports','key_qr_tokens',
    'key_inventory_checks','key_inventory_check_items','key_reminder_state'
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
  ('keys:create','Create keys'),
  ('keys:update','Edit key master data'),
  ('keys:export','Export keys as CSV'),
  ('keys:view_history','Read immutable key movement history'),
  ('keys:qr:read','Issue a short-lived key QR reference'),
  ('keys:report_loss','Report and process key loss'),
  ('keys:inventory:read','Read key inventory checks'),
  ('keys:inventory:write','Record key inventory checks'),
  ('keys:reminder:write','Configure return-due reminders'),
  ('keys:bundle_history_read','Read immutable key bundle history'),
  ('keys:bundle_deactivate','Deactivate a key bundle')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key IN (
  'keys:create','keys:update','keys:export','keys:view_history','keys:qr:read','keys:report_loss',
  'keys:inventory:read','keys:inventory:write','keys:reminder:write','keys:bundle_history_read','keys:bundle_deactivate'
)
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'operator',id,'tenant' FROM permissions WHERE key IN (
  'keys:create','keys:update','keys:export','keys:view_history','keys:qr:read','keys:report_loss',
  'keys:inventory:read','keys:inventory:write','keys:reminder:write','keys:bundle_history_read','keys:bundle_deactivate'
)
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'viewer',id,'tenant' FROM permissions WHERE key IN (
  'keys:view_history','keys:qr:read','keys:inventory:read','keys:bundle_history_read'
)
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions WHERE key IN (
  'keys:create','keys:update','keys:export','keys:view_history','keys:qr:read','keys:report_loss',
  'keys:inventory:read','keys:inventory:write','keys:reminder:write','keys:bundle_history_read','keys:bundle_deactivate'
)
ON CONFLICT (role,permission_id) DO NOTHING;

INSERT INTO notification_subscriptions(tenant_id,role,event_type,channel)
SELECT t.id,role,'keys.return_due','in_app' FROM tenants t CROSS JOIN (VALUES ('admin'),('operator')) AS r(role)
WHERE NOT EXISTS (
  SELECT 1 FROM notification_subscriptions s
  WHERE s.tenant_id=t.id AND s.role=r.role AND s.event_type='keys.return_due' AND s.channel='in_app'
);

ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN (
    'alarms.panic','patrol.scan','watchbook.entry','scheduling.period',
    'scheduling.shift','scheduling.assignment','scheduling.rule_profile',
    'dms.document','keys.create','keys.issue','keys.return','keys.lost',
    'keys.deactivate','handover.create','handover.participant',
    'handover.confirm','handover.revoke','handover.correct',
    'keys.bundle.create','keys.bundle.item','keys.bundle.issue',
    'keys.bundle.return','maintenance.order.create',
    'keys.update','keys.block','keys.reactivate','keys.loss.report','keys.loss.update',
    'keys.qr.issue','keys.inventory.check','keys.bundle.deactivate','keys.bundle.item_removed'
  ));
