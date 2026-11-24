ALTER TABLE employee_absences
  ADD COLUMN IF NOT EXISTS absence_type text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS document_id uuid,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employee_absences_type_check') THEN
    ALTER TABLE employee_absences ADD CONSTRAINT employee_absences_type_check
      CHECK (absence_type IN ('vacation','sick','training','special_leave','compensatory','unavailable','other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employee_absences_status_check') THEN
    ALTER TABLE employee_absences ADD CONSTRAINT employee_absences_status_check
      CHECK (status IN ('requested','approved','rejected','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employee_absences_tenant_created_by_fk') THEN
    ALTER TABLE employee_absences ADD CONSTRAINT employee_absences_tenant_created_by_fk
      FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employee_absences_tenant_document_fk') THEN
    ALTER TABLE employee_absences ADD CONSTRAINT employee_absences_tenant_document_fk
      FOREIGN KEY (tenant_id,document_id) REFERENCES dms_documents(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employee_absences_tenant_employee_time_idx
  ON employee_absences(tenant_id,employee_id,starts_at,ends_at,status);
