-- Production employee master data and operational links.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS employee_number text,
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS mobile text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS hire_date date,
  ADD COLUMN IF NOT EXISTS termination_date date,
  ADD COLUMN IF NOT EXISTS employment_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS employment_type text NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS department text,
  ADD COLUMN IF NOT EXISTS position text,
  ADD COLUMN IF NOT EXISTS work_location text,
  ADD COLUMN IF NOT EXISTS weekly_hours numeric(5,2),
  ADD COLUMN IF NOT EXISTS user_id uuid;

UPDATE employees
SET first_name=split_part(name,' ',1),
    last_name=CASE WHEN strpos(name,' ')>0 THEN substr(name,strpos(name,' ')+1) ELSE NULL END
WHERE first_name IS NULL OR last_name IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employees_employment_status_check') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_employment_status_check
      CHECK (employment_status IN ('active','probation','leave','terminated','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employees_employment_type_check') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_employment_type_check
      CHECK (employment_type IN ('employee','temporary','contractor','intern','apprentice','freelancer'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employees_weekly_hours_check') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_weekly_hours_check
      CHECK (weekly_hours IS NULL OR (weekly_hours >= 0 AND weekly_hours <= 168));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS employees_tenant_employee_number_uidx
  ON employees(tenant_id,employee_number) WHERE employee_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employees_tenant_user_uidx
  ON employees(tenant_id,user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employees_tenant_status_idx ON employees(tenant_id,employment_status,department);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employees_tenant_user_fk') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_tenant_user_fk
      FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS employee_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  contract_number text,
  contract_type text NOT NULL CHECK (contract_type IN ('permanent','fixed_term','part_time','temporary','internship','freelance','apprenticeship')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','ended','cancelled')),
  starts_on date NOT NULL,
  ends_on date,
  weekly_hours numeric(5,2) CHECK (weekly_hours IS NULL OR (weekly_hours >= 0 AND weekly_hours <= 168)),
  probation_ends_on date,
  notice_period_days integer CHECK (notice_period_days IS NULL OR notice_period_days >= 0),
  cost_center text,
  salary_amount numeric(12,2),
  currency text NOT NULL DEFAULT 'EUR',
  document_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,employee_id,contract_number),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,document_id) REFERENCES dms_documents(tenant_id,id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS employee_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_time time NOT NULL,
  ends_time time NOT NULL,
  available boolean NOT NULL DEFAULT true,
  valid_from date,
  valid_until date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_time > starts_time),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employee_object_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  site_id uuid NOT NULL,
  assignment_type text NOT NULL DEFAULT 'operational',
  role text,
  starts_on date NOT NULL,
  ends_on date,
  primary_assignment boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_primary_object_uidx
  ON employee_object_assignments(tenant_id,employee_id) WHERE primary_assignment=true AND ends_on IS NULL;
CREATE INDEX IF NOT EXISTS employee_object_assignment_history_idx
  ON employee_object_assignments(tenant_id,employee_id,starts_on DESC,ends_on);

CREATE TABLE IF NOT EXISTS employee_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  event_type text NOT NULL,
  event_on timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES users(tenant_id,id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS employee_history_tenant_employee_idx ON employee_history(tenant_id,employee_id,event_on DESC);

ALTER TABLE dms_documents
  ADD COLUMN IF NOT EXISTS employee_id uuid,
  ADD COLUMN IF NOT EXISTS employee_document_category text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_tenant_employee_fk') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_documents_tenant_employee_fk
      FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS dms_documents_employee_idx ON dms_documents(tenant_id,employee_id,created_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'employee_contracts','employee_availability','employee_object_assignments','employee_history'
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

-- Database-level protection against a single employee being assigned to overlapping shifts.
CREATE OR REPLACE FUNCTION prevent_employee_shift_double_booking()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shift_row record;
  overlapping record;
BEGIN
  IF NEW.status <> 'assigned' THEN RETURN NEW; END IF;
  SELECT starts_at,ends_at,period_id INTO shift_row
  FROM schedule_shifts WHERE tenant_id=NEW.tenant_id AND id=NEW.shift_id;
  IF shift_row IS NULL THEN
    RAISE EXCEPTION 'Schedule shift not found' USING ERRCODE='23503';
  END IF;
  SELECT a.id INTO overlapping
  FROM schedule_assignments a
  JOIN schedule_shifts s ON s.tenant_id=a.tenant_id AND s.id=a.shift_id
  WHERE a.tenant_id=NEW.tenant_id
    AND a.employee_id=NEW.employee_id
    AND a.status='assigned'
    AND s.starts_at < shift_row.ends_at
    AND shift_row.starts_at < s.ends_at
    AND (TG_OP='INSERT' OR a.id<>NEW.id)
  LIMIT 1;
  IF overlapping.id IS NOT NULL THEN
    RAISE EXCEPTION 'Employee already assigned to an overlapping shift'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM employee_absences
    WHERE tenant_id=NEW.tenant_id
      AND employee_id=NEW.employee_id
      AND starts_at < shift_row.ends_at
      AND shift_row.starts_at < ends_at
  ) THEN
    RAISE EXCEPTION 'Employee is absent during this shift'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS schedule_assignments_double_booking_trg ON schedule_assignments;
CREATE TRIGGER schedule_assignments_double_booking_trg
BEFORE INSERT OR UPDATE ON schedule_assignments
FOR EACH ROW EXECUTE FUNCTION prevent_employee_shift_double_booking();
