-- Professionelle NFC-Geräteverwaltung: nachvollziehbare Statusereignisse,
-- Zuordnungs- und Ersatzhistorie sowie Dokumente direkt an NFC-Geräten.
-- Alle bestehenden Geräte, Scans und Rollen bleiben erhalten; die Migration
-- ist rein additiv beziehungsweise ergänzt engmaschige Prüfungen.

ALTER TABLE nfc_devices
  ADD COLUMN IF NOT EXISTS lost_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_at timestamptz,
  ADD COLUMN IF NOT EXISTS event_reason text,
  ADD COLUMN IF NOT EXISTS reported_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='nfc_devices_tenant_reported_by_fk') THEN
    ALTER TABLE nfc_devices
      ADD CONSTRAINT nfc_devices_tenant_reported_by_fk
      FOREIGN KEY (tenant_id,reported_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL (reported_by);
  END IF;
END $$;

ALTER TABLE nfc_devices DROP CONSTRAINT IF EXISTS nfc_devices_device_type_check;
ALTER TABLE nfc_devices ADD CONSTRAINT nfc_devices_device_type_check
  CHECK (device_type IN ('tag','reader'));

CREATE TABLE IF NOT EXISTS nfc_device_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  previous_assignment jsonb NOT NULL DEFAULT '{}'::jsonb,
  assignment jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  reason text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,device_id) REFERENCES nfc_devices(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES users(tenant_id,id) ON DELETE SET NULL (actor_user_id)
);

CREATE TABLE IF NOT EXISTS nfc_device_replacements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  old_device_id uuid NOT NULL,
  new_device_id uuid NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  notes text,
  old_assignment jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_assignment jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid NOT NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,new_device_id),
  FOREIGN KEY (tenant_id,old_device_id) REFERENCES nfc_devices(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,new_device_id) REFERENCES nfc_devices(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK (old_device_id <> new_device_id)
);

-- DMS-Dokumente können wie Betriebsgeräte auch NFC-Geräten zugeordnet werden.
ALTER TABLE dms_documents ADD COLUMN IF NOT EXISTS nfc_device_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_tenant_nfc_device_fk') THEN
    ALTER TABLE dms_documents
      ADD CONSTRAINT dms_documents_tenant_nfc_device_fk
      FOREIGN KEY (tenant_id,nfc_device_id) REFERENCES nfc_devices(tenant_id,id) ON DELETE SET NULL (nfc_device_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS nfc_device_assignment_history_tenant_device_idx
  ON nfc_device_assignment_history(tenant_id,device_id,assigned_at DESC);
CREATE INDEX IF NOT EXISTS nfc_device_replacements_tenant_old_idx
  ON nfc_device_replacements(tenant_id,old_device_id,replaced_at DESC);
CREATE INDEX IF NOT EXISTS nfc_devices_tenant_identifier_idx
  ON nfc_devices(tenant_id,identifier);
CREATE INDEX IF NOT EXISTS patrol_scans_tenant_nfc_device_idx
  ON patrol_scans(tenant_id,nfc_device_id,server_received_at DESC);
CREATE INDEX IF NOT EXISTS dms_documents_tenant_nfc_device_idx
  ON dms_documents(tenant_id,nfc_device_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'nfc_device_assignment_history','nfc_device_replacements'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

-- Sensible Statusänderungen (Sperre, Verlust, Ersatz, Reaktivierung) erhalten
-- eine eigene Berechtigung. Bestehende read/write-Rechte unverändert.
INSERT INTO permissions(key,description)
VALUES ('nfc_devices:security','NFC-Geräte sperren, als verloren melden, ersetzen und reaktivieren')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role,permission_id)
SELECT role,id FROM permissions CROSS JOIN (VALUES ('admin'),('operator')) AS r(role)
WHERE key='nfc_devices:security'
ON CONFLICT (role,permission_id) DO NOTHING;
