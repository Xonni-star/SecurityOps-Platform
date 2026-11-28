-- Additive migration: echtes Einsatz-, Alarm- und Vorfallmanagement der Leitstelle.
-- Bestehende Tabellen werden nur um Spalten/Indizes ergänzt; 001-066 bleiben unberührt.

-- ---------------------------------------------------------------------------
-- 1) incidents: Vorfallnummer, Typ, Kunde, Herkunft, Abschluss, Idempotenz
-- ---------------------------------------------------------------------------
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS incident_number text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS incident_type_id uuid;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS customer_id uuid;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS closed_by uuid;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS closure_note text;
ALTER TABLE incident_history ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE incident_history ADD COLUMN IF NOT EXISTS event_type text;

-- cancelled wird serverseitig als weiterer Endzustand benötigt.
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_status_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
  CHECK (status IN ('initiated','en_route','on_site','completed','cancelled'));

CREATE TABLE IF NOT EXISTS incident_number_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year text NOT NULL CHECK (year ~ '^[0-9]{4}$'),
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, year)
);

-- Atomare, mandanten- und jahresbezogene Nummernvergabe. SECURITY DEFINER ist
-- erforderlich, weil der Zähler auch beim Backfill ohne app.tenant_id erhöht
-- wird; die Vorfälle selbst bleiben durch ihre eigene RLS geschützt.
CREATE OR REPLACE FUNCTION assign_incident_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  incident_year text;
  next_value bigint;
BEGIN
  IF NEW.incident_number IS NOT NULL THEN RETURN NEW; END IF;
  incident_year := to_char(COALESCE(NEW.created_at, now()) AT TIME ZONE 'Europe/Berlin','YYYY');
  INSERT INTO incident_number_counters(tenant_id,year,last_value)
    VALUES (NEW.tenant_id,incident_year,1)
    ON CONFLICT (tenant_id,year) DO UPDATE
      SET last_value=incident_number_counters.last_value+1, updated_at=now()
    RETURNING last_value INTO next_value;
  NEW.incident_number := 'INC-'||incident_year||'-'||lpad(next_value::text,6,'0');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS incidents_assign_number ON incidents;
CREATE TRIGGER incidents_assign_number
  BEFORE INSERT OR UPDATE ON incidents
  FOR EACH ROW WHEN (NEW.incident_number IS NULL)
  EXECUTE FUNCTION assign_incident_number();

DO $$
DECLARE tenant_record record;
BEGIN
  FOR tenant_record IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant_record.id::text, true);
    UPDATE incidents SET incident_number=NULL
      WHERE tenant_id=tenant_record.id AND incident_number IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS incidents_tenant_number_uidx
  ON incidents(tenant_id, incident_number) WHERE incident_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_source_key_uidx
  ON incidents(tenant_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS incidents_type_idx ON incidents(tenant_id, incident_type_id);
CREATE INDEX IF NOT EXISTS incidents_customer_idx ON incidents(tenant_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS incidents_closed_idx ON incidents(tenant_id, closed_at) WHERE closed_at IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incidents_number_format_check') THEN
    ALTER TABLE incidents ADD CONSTRAINT incidents_number_format_check
      CHECK (incident_number IS NULL OR incident_number ~ '^INC-[0-9]{4}-[0-9]{6}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incidents_tenant_customer_fk') THEN
    ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_customer_fk
      FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incidents_tenant_closed_by_fk') THEN
    ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_closed_by_fk
      FOREIGN KEY (tenant_id,closed_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) incident_types
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,code)
);

ALTER TABLE incident_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_types FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON incident_types;
CREATE POLICY tenant_isolation ON incident_types
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
DECLARE tenant_record record;
BEGIN
  FOR tenant_record IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant_record.id::text, true);
    INSERT INTO incident_types(tenant_id,code,name,description)
    SELECT tenant_record.id,v.code,v.name,v.description FROM (VALUES
      ('technical_fault','Technischer Fehler','Technische Störung an Anlage oder Gerät'),
      ('alarm','Alarm','Ausgelöster Alarm'),
      ('key_loss','Schlüsselverlust','Verlust oder Missbrauch eines Schlüssels'),
      ('nfc_loss','NFC-Verlust','Verlust oder Ausfall eines NFC-Mediums'),
      ('qualification_gap','Qualifikationslücke','Fehlende oder ungültige Qualifikation'),
      ('staffing_gap','Besetzungslücke','Unzureichende Besetzung'),
      ('hazard','Gefährdung','Gefährdung von Personen oder Objekten'),
      ('other','Sonstiges','Sonstiger Vorfall')
    ) v(code,name,description)
    ON CONFLICT (tenant_id,code) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incidents_tenant_type_fk') THEN
    ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_type_fk
      FOREIGN KEY (tenant_id,incident_type_id) REFERENCES incident_types(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) incident_documents (nur Verknüpfung, keine Blob-Daten)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL,
  document_id uuid NOT NULL,
  linked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  note text,
  category text NOT NULL DEFAULT 'attachment',
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,incident_id,document_id,category),
  CONSTRAINT incident_documents_category_check
    CHECK (category IN ('attachment','report','evidence')),
  CONSTRAINT incident_documents_tenant_incident_fk
    FOREIGN KEY (tenant_id,incident_id) REFERENCES incidents(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT incident_documents_tenant_document_fk
    FOREIGN KEY (tenant_id,document_id) REFERENCES dms_documents(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT incident_documents_tenant_linked_by_fk
    FOREIGN KEY (tenant_id,linked_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS incident_documents_tenant_incident_idx
  ON incident_documents(tenant_id,incident_id,category,created_at DESC);
CREATE INDEX IF NOT EXISTS incident_documents_tenant_document_idx
  ON incident_documents(tenant_id,document_id);

ALTER TABLE incident_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON incident_documents;
CREATE POLICY tenant_isolation ON incident_documents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 4) incident_reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL,
  summary text,
  cause text,
  actions text,
  result text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,incident_id),
  CONSTRAINT incident_reports_tenant_incident_fk
    FOREIGN KEY (tenant_id,incident_id) REFERENCES incidents(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT incident_reports_tenant_created_by_fk
    FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL,
  CONSTRAINT incident_reports_tenant_updated_by_fk
    FOREIGN KEY (tenant_id,updated_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS incident_reports_tenant_idx ON incident_reports(tenant_id,updated_at DESC);

ALTER TABLE incident_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON incident_reports;
CREATE POLICY tenant_isolation ON incident_reports
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 5) escalation_log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS escalation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id uuid,
  alarm_id uuid,
  rule_id uuid,
  trigger text NOT NULL,
  from_status text,
  to_status text,
  reason text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  CONSTRAINT escalation_log_trigger_check CHECK (trigger IN ('manual','automatic')),
  CONSTRAINT escalation_log_tenant_incident_fk
    FOREIGN KEY (tenant_id,incident_id) REFERENCES incidents(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT escalation_log_tenant_alarm_fk
    FOREIGN KEY (tenant_id,alarm_id) REFERENCES alarms(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT escalation_log_tenant_rule_fk
    FOREIGN KEY (tenant_id,rule_id) REFERENCES escalation_rules(tenant_id,id) ON DELETE SET NULL,
  CONSTRAINT escalation_log_tenant_actor_fk
    FOREIGN KEY (tenant_id,actor_user_id) REFERENCES users(tenant_id,id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS escalation_log_tenant_incident_idx
  ON escalation_log(tenant_id,incident_id,created_at DESC);
CREATE INDEX IF NOT EXISTS escalation_log_tenant_alarm_idx
  ON escalation_log(tenant_id,alarm_id,created_at DESC);

ALTER TABLE escalation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON escalation_log;
CREATE POLICY tenant_isolation ON escalation_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 6) escalation_rules: konfigurierbares Ziel und Benachrichtigung
-- ---------------------------------------------------------------------------
ALTER TABLE escalation_rules ADD COLUMN IF NOT EXISTS target_status text NOT NULL DEFAULT 'escalated';
ALTER TABLE escalation_rules ADD COLUMN IF NOT EXISTS notify_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE escalation_rules ADD COLUMN IF NOT EXISTS target_user_id uuid;

DO $$
DECLARE tenant_record record;
BEGIN
  FOR tenant_record IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant_record.id::text, true);
    UPDATE escalation_rules SET target_status='escalated'
      WHERE tenant_id=tenant_record.id AND target_status IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='escalation_rules_target_status_check') THEN
    ALTER TABLE escalation_rules ADD CONSTRAINT escalation_rules_target_status_check
      CHECK (target_status IN ('escalated','acknowledged'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='escalation_rules_tenant_target_user_fk') THEN
    ALTER TABLE escalation_rules ADD CONSTRAINT escalation_rules_tenant_target_user_fk
      FOREIGN KEY (tenant_id,target_user_id) REFERENCES users(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7) alarms: source_key für Idempotenz
-- ---------------------------------------------------------------------------
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS request_fingerprint text;

DO $$
DECLARE tenant_record record;
BEGIN
  FOR tenant_record IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant_record.id::text, true);
    UPDATE alarms SET source_key='alarm:'||id::text
      WHERE tenant_id=tenant_record.id AND source_key IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS alarms_source_key_uidx
  ON alarms(tenant_id,source_key) WHERE source_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 8) Permissions und Rollen (site/tenant/system konsistent zu 011/066)
-- ---------------------------------------------------------------------------
INSERT INTO permissions(key,description) VALUES
  ('incident_documents:read','Vorfall-Dokumentverknüpfungen lesen'),
  ('incident_documents:write','Vorfall-Dokumentverknüpfungen bearbeiten'),
  ('incident_reports:read','Einsatzberichte lesen'),
  ('incident_reports:write','Einsatzberichte bearbeiten'),
  ('incidents:escalate','Vorfälle eskalieren'),
  ('escalation_log:read','Eskalationsprotokoll lesen'),
  ('einsatz:reports:read','Einsatzkennzahlen lesen')
ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description, updated_at=now();

INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key IN (
  'incident_documents:read','incident_documents:write','incident_reports:read',
  'incident_reports:write','incidents:escalate','escalation_log:read','einsatz:reports:read')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'operator',id,'tenant' FROM permissions WHERE key IN (
  'incident_documents:read','incident_documents:write','incident_reports:read',
  'incident_reports:write','incidents:escalate','escalation_log:read','einsatz:reports:read')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'viewer',id,'tenant' FROM permissions WHERE key IN (
  'incident_documents:read','incident_reports:read','escalation_log:read','einsatz:reports:read')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions WHERE key IN (
  'incident_documents:read','incident_documents:write','incident_reports:read',
  'incident_reports:write','incidents:escalate','escalation_log:read','einsatz:reports:read')
ON CONFLICT (role,permission_id) DO NOTHING;
