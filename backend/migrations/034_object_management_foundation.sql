-- Object management foundation: richer site master data and tenant-safe CRM links.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS site_number text,
  ADD COLUMN IF NOT EXISTS alias text,
  ADD COLUMN IF NOT EXISTS site_type text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'planning',
  ADD COLUMN IF NOT EXISTS security_classification text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS latitude numeric(9,6),
  ADD COLUMN IF NOT EXISTS longitude numeric(9,6),
  ADD COLUMN IF NOT EXISTS opening_hours jsonb,
  ADD COLUMN IF NOT EXISTS access_information text,
  ADD COLUMN IF NOT EXISTS special_notes text,
  ADD COLUMN IF NOT EXISTS hazard_notes text,
  ADD COLUMN IF NOT EXISTS object_manager_employee_id uuid,
  ADD COLUMN IF NOT EXISTS operations_manager_employee_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS sites_tenant_site_number_uidx
  ON sites(tenant_id, site_number)
  WHERE site_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS sites_tenant_status_idx
  ON sites(tenant_id, status);
CREATE INDEX IF NOT EXISTS sites_tenant_manager_idx
  ON sites(tenant_id, object_manager_employee_id)
  WHERE object_manager_employee_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_status_check') THEN
    ALTER TABLE sites ADD CONSTRAINT sites_status_check
      CHECK (status IN ('planning','setup','active','restricted','temporarily_closed','decommissioned','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_security_classification_check') THEN
    ALTER TABLE sites ADD CONSTRAINT sites_security_classification_check
      CHECK (security_classification IN ('unknown','low','medium','high','critical'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_latitude_check') THEN
    ALTER TABLE sites ADD CONSTRAINT sites_latitude_check
      CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_longitude_check') THEN
    ALTER TABLE sites ADD CONSTRAINT sites_longitude_check
      CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_tenant_object_manager_fk') THEN
    ALTER TABLE sites ADD CONSTRAINT sites_tenant_object_manager_fk
      FOREIGN KEY (tenant_id, object_manager_employee_id)
      REFERENCES employees(tenant_id, id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_tenant_operations_manager_fk') THEN
    ALTER TABLE sites ADD CONSTRAINT sites_tenant_operations_manager_fk
      FOREIGN KEY (tenant_id, operations_manager_employee_id)
      REFERENCES employees(tenant_id, id) ON DELETE SET NULL;
  END IF;
END $$;
