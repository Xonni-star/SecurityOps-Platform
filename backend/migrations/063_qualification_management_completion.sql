-- Vollständige Qualifikationsverwaltung: Katalogfelder, Dokumentverknüpfung,
-- Objektanforderungen, Erinnerungshistorie und feinere Berechtigungen.
-- Alle Ergänzungen sind additiv; bestehende Datensätze bleiben erhalten.

ALTER TABLE qualification_catalog ADD COLUMN IF NOT EXISTS required_document_type text;
ALTER TABLE qualification_catalog DROP CONSTRAINT IF EXISTS qualification_catalog_required_document_type_check;
ALTER TABLE qualification_catalog ADD CONSTRAINT qualification_catalog_required_document_type_check
  CHECK (required_document_type IS NULL OR length(btrim(required_document_type)) BETWEEN 1 AND 120);

ALTER TABLE qualification_catalog DROP CONSTRAINT IF EXISTS qualification_catalog_category_check;
ALTER TABLE qualification_catalog ADD CONSTRAINT qualification_catalog_category_check
  CHECK (category IS NULL OR length(btrim(category)) BETWEEN 1 AND 80);

ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS catalog_id uuid;
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS issued_on date;
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS change_reason text;
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE employee_qualifications DROP CONSTRAINT IF EXISTS employee_qualifications_change_reason_check;
ALTER TABLE employee_qualifications ADD CONSTRAINT employee_qualifications_change_reason_check
  CHECK (change_reason IS NULL OR length(btrim(change_reason)) BETWEEN 1 AND 500);
ALTER TABLE employee_qualifications DROP CONSTRAINT IF EXISTS employee_qualifications_issued_on_check;
ALTER TABLE employee_qualifications ADD CONSTRAINT employee_qualifications_issued_on_check
  CHECK (issued_on IS NULL OR valid_until IS NULL OR issued_on <= valid_until);

UPDATE employee_qualifications
   SET issued_on = COALESCE(valid_from, updated_at::date)
 WHERE issued_on IS NULL;

-- Vorhandene, nicht mehr auflösbare Dokument-IDs dürfen die neue FK nicht
-- blockieren; sie waren vorher bereits nur freie UUID-Texte ohne FK.
UPDATE employee_qualifications q
   SET document_id = NULL
 WHERE q.document_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM dms_documents d
      WHERE d.tenant_id = q.tenant_id AND d.id = q.document_id
   );

ALTER TABLE employee_qualifications DROP CONSTRAINT IF EXISTS employee_qualifications_catalog_fk;
ALTER TABLE employee_qualifications ADD CONSTRAINT employee_qualifications_catalog_fk
  FOREIGN KEY (tenant_id, catalog_id) REFERENCES qualification_catalog(tenant_id, id) ON DELETE SET NULL;
ALTER TABLE employee_qualifications DROP CONSTRAINT IF EXISTS employee_qualifications_document_fk;
ALTER TABLE employee_qualifications ADD CONSTRAINT employee_qualifications_document_fk
  FOREIGN KEY (tenant_id, document_id) REFERENCES dms_documents(tenant_id, id) ON DELETE SET NULL;
ALTER TABLE employee_qualifications DROP CONSTRAINT IF EXISTS employee_qualifications_created_by_fk;
ALTER TABLE employee_qualifications ADD CONSTRAINT employee_qualifications_created_by_fk
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS employee_qualifications_employee_status_idx
  ON employee_qualifications(tenant_id, employee_id, status, valid_until);
CREATE INDEX IF NOT EXISTS employee_qualifications_document_idx
  ON employee_qualifications(tenant_id, document_id);
CREATE INDEX IF NOT EXISTS employee_qualifications_catalog_idx
  ON employee_qualifications(tenant_id, catalog_id);
CREATE INDEX IF NOT EXISTS qualification_catalog_category_idx
  ON qualification_catalog(tenant_id, category, active);

CREATE TABLE IF NOT EXISTS site_qualification_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  catalog_id uuid NOT NULL,
  required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  responsible_employee_id uuid,
  notes text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, catalog_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, catalog_id) REFERENCES qualification_catalog(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, responsible_employee_id) REFERENCES employees(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS site_qualification_requirements_site_idx
  ON site_qualification_requirements(tenant_id, site_id, active);
ALTER TABLE site_qualification_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_qualification_requirements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON site_qualification_requirements;
CREATE POLICY tenant_isolation ON site_qualification_requirements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS qualification_reminder_state (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qualification_id uuid NOT NULL,
  days integer NOT NULL CHECK (days > 0),
  due_date date NOT NULL,
  event_key text NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, qualification_id, days, due_date),
  FOREIGN KEY (tenant_id, qualification_id) REFERENCES employee_qualifications(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS qualification_reminder_state_due_idx
  ON qualification_reminder_state(tenant_id, due_date, days);
ALTER TABLE qualification_reminder_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_reminder_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON qualification_reminder_state;
CREATE POLICY tenant_isolation ON qualification_reminder_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Erinnerungstage: 1..8 positive, eindeutige Werte. Ein Trigger wird verwendet,
-- weil PostgreSQL CHECK keine Mengenprüfung über unnest() erlaubt.
CREATE OR REPLACE FUNCTION validate_qualification_reminder_days() RETURNS trigger AS $$
BEGIN
  IF NEW.reminder_days IS NULL
     OR cardinality(NEW.reminder_days) < 1
     OR cardinality(NEW.reminder_days) > 8
     OR EXISTS (SELECT 1 FROM unnest(NEW.reminder_days) d WHERE d IS NULL OR d <= 0 OR d > 3650)
     OR (SELECT count(DISTINCT d) FROM unnest(NEW.reminder_days) d) <> cardinality(NEW.reminder_days) THEN
    RAISE EXCEPTION 'Erinnerungstage müssen 1 bis 8 eindeutige positive Tage (1 bis 3650) sein';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS qualification_reminder_settings_days_check ON qualification_reminder_settings;
CREATE TRIGGER qualification_reminder_settings_days_check
  BEFORE INSERT OR UPDATE OF reminder_days ON qualification_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION validate_qualification_reminder_days();

-- existing catalog entries receive meaningful categories without changing codes or validity
UPDATE qualification_catalog SET category =CASE code
    WHEN 'sachkunde_34a' THEN 'Gesetzliche Qualifikationen'
    WHEN 'erste_hilfe' THEN 'Erste Hilfe und medizinische Qualifikationen'
    WHEN 'brandschutz' THEN 'Brandschutz'
    WHEN 'fuehrungszeugnis' THEN 'Gesetzliche Qualifikationen'
    WHEN 'waffenschein' THEN 'Sicherheit und Spezialausbildungen'
  END
 WHERE code IN ('sachkunde_34a','erste_hilfe','brandschutz','fuehrungszeugnis','waffenschein')
   AND category IS NULL;

INSERT INTO permissions(key,description) VALUES
  ('qualifications:catalog:write','Verwalten des Qualifikationskatalogs'),
  ('qualifications:revoke','Qualifikationen widerrufen'),
  ('qualifications:documents:read','Qualifikationsnachweise ansehen'),
  ('qualifications:documents:download','Qualifikationsnachweise herunterladen'),
  ('qualifications:reminders:write','Erinnerungsintervalle verwalten'),
  ('qualifications:export','Qualifikationsauswertungen exportieren')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'admin',id,'tenant' FROM permissions WHERE key IN (
  'qualifications:catalog:write','qualifications:revoke','qualifications:documents:read',
  'qualifications:documents:download','qualifications:reminders:write','qualifications:export')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'operator',id,'tenant' FROM permissions WHERE key IN (
  'qualifications:revoke','qualifications:documents:read','qualifications:documents:download',
  'qualifications:export')
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'viewer',id,'tenant' FROM permissions WHERE key='qualifications:documents:read'
ON CONFLICT (role,permission_id) DO NOTHING;
INSERT INTO role_permissions(role,permission_id,scope)
SELECT 'superadmin',id,'system' FROM permissions WHERE key LIKE 'qualifications:%'
ON CONFLICT (role,permission_id) DO NOTHING;
