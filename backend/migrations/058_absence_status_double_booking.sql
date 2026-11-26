-- A cancelled or rejected absence is not an actual absence and must not block
-- shift assignments. The original trigger ignored employee_absences.status.
-- Only the status predicate changes; the double-booking check stays unchanged.

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
      AND status IN ('requested','approved')
      AND starts_at < shift_row.ends_at
      AND shift_row.starts_at < ends_at
  ) THEN
    RAISE EXCEPTION 'Employee is absent during this shift'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
