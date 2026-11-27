-- Additive migration: recertification keeps historical assignments.
-- The previous UNIQUE(tenant_id, employee_id, code) prevented a second
-- certification after a revocation. Only one current assignment per
-- employee and qualification is allowed from now on; revoked or removed
-- rows remain untouched and are retained as history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.employee_qualifications'::regclass
       AND conname='employee_qualifications_tenant_id_employee_id_code_key'
  ) THEN
    ALTER TABLE public.employee_qualifications
      DROP CONSTRAINT employee_qualifications_tenant_id_employee_id_code_key;
  END IF;
END $$;

CREATE UNIQUE INDEX employee_qualifications_current_assignment_uq
  ON public.employee_qualifications (tenant_id,employee_id,code)
  WHERE status IN ('valid','expired');

-- Provenance of valid_until: NULL = legacy/unknown, manual = explicitly
-- entered, catalog_default = computed from catalog.default_validity_days,
-- unlimited = explicitly no expiry.
ALTER TABLE public.employee_qualifications
  ADD COLUMN IF NOT EXISTS valid_until_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.employee_qualifications'::regclass
       AND conname='employee_qualifications_valid_until_source_check'
  ) THEN
    ALTER TABLE public.employee_qualifications
      ADD CONSTRAINT employee_qualifications_valid_until_source_check
      CHECK (valid_until_source IS NULL OR valid_until_source IN ('manual','catalog_default','unlimited'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employee_qualifications_history_idx
  ON public.employee_qualifications (tenant_id,employee_id,code,created_at DESC);
