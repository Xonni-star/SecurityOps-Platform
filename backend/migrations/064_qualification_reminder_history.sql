-- Erweitert die Erinnerungshistorie um Pflichtnachweis-Ereignisse und
-- später erfasste Empfängergruppen. Bestehende Einträge bleiben erhalten.

ALTER TABLE qualification_reminder_state ADD COLUMN IF NOT EXISTS employee_id uuid;
ALTER TABLE qualification_reminder_state ADD COLUMN IF NOT EXISTS catalog_id uuid;
ALTER TABLE qualification_reminder_state ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'qualification.expiring';
ALTER TABLE qualification_reminder_state ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE qualification_reminder_state ADD COLUMN IF NOT EXISTS body text;

UPDATE qualification_reminder_state s
   SET employee_id=q.employee_id, catalog_id=c.id, title='Qualifikation läuft ab'
  FROM employee_qualifications q
  LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.code=q.code
 WHERE q.tenant_id=s.tenant_id AND q.id=s.qualification_id AND s.employee_id IS NULL;

ALTER TABLE qualification_reminder_state ALTER COLUMN employee_id SET NOT NULL;
ALTER TABLE qualification_reminder_state DROP CONSTRAINT IF EXISTS qualification_reminder_state_days_check;
ALTER TABLE qualification_reminder_state ADD CONSTRAINT qualification_reminder_state_days_check CHECK (days >= 0);
ALTER TABLE qualification_reminder_state DROP CONSTRAINT IF EXISTS qualification_reminder_state_event_type_check;
ALTER TABLE qualification_reminder_state ADD CONSTRAINT qualification_reminder_state_event_type_check
  CHECK (event_type IN ('qualification.expiring','qualification.expired','qualification.missing_required'));

ALTER TABLE qualification_reminder_state DROP CONSTRAINT IF EXISTS qualification_reminder_state_pkey;
ALTER TABLE qualification_reminder_state ADD PRIMARY KEY (tenant_id,event_key);
DROP INDEX IF EXISTS qualification_reminder_state_unique_assignment;
CREATE UNIQUE INDEX qualification_reminder_state_unique_assignment
  ON qualification_reminder_state(tenant_id,qualification_id,days,due_date)
  WHERE qualification_id IS NOT NULL;
DROP INDEX IF EXISTS qualification_reminder_state_unique_required;
CREATE UNIQUE INDEX qualification_reminder_state_unique_required
  ON qualification_reminder_state(tenant_id,employee_id,catalog_id,days,due_date)
  WHERE qualification_id IS NULL;

ALTER TABLE qualification_reminder_state DROP CONSTRAINT IF EXISTS qualification_reminder_state_employee_fk;
ALTER TABLE qualification_reminder_state ADD CONSTRAINT qualification_reminder_state_employee_fk
  FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE qualification_reminder_state DROP CONSTRAINT IF EXISTS qualification_reminder_state_catalog_fk;
ALTER TABLE qualification_reminder_state ADD CONSTRAINT qualification_reminder_state_catalog_fk
  FOREIGN KEY (tenant_id,catalog_id) REFERENCES qualification_catalog(tenant_id,id) ON DELETE CASCADE;

ALTER TABLE qualification_reminder_state ALTER COLUMN qualification_id DROP NOT NULL;

INSERT INTO notification_subscriptions(tenant_id,role,event_type,channel)
SELECT t.id,r.role,e.event_type,'in_app'
  FROM tenants t
  CROSS JOIN (VALUES ('admin'),('operator')) AS r(role)
  CROSS JOIN (VALUES ('qualification.expiring'),('qualification.expired'),('qualification.missing_required')) AS e(event_type)
 WHERE NOT EXISTS (
   SELECT 1 FROM notification_subscriptions s
    WHERE s.tenant_id=t.id AND s.role=r.role AND s.event_type=e.event_type AND s.channel='in_app'
 );
