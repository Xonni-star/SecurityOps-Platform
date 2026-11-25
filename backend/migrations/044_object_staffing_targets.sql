ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS required_staff_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='sites_required_staff_count_check'
  ) THEN
    ALTER TABLE sites
      ADD CONSTRAINT sites_required_staff_count_check
      CHECK (required_staff_count >= 0);
  END IF;
END $$;
