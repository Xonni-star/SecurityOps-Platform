ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS street text,
  ADD COLUMN IF NOT EXISTS house_number text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS contact_person text;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS asset_number text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS manufacturer text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS location_id uuid,
  ADD COLUMN IF NOT EXISTS responsible_employee_id uuid,
  ADD COLUMN IF NOT EXISTS operational_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS installed_on date,
  ADD COLUMN IF NOT EXISTS commissioned_on date,
  ADD COLUMN IF NOT EXISTS last_inspection_on date,
  ADD COLUMN IF NOT EXISTS next_inspection_on date,
  ADD COLUMN IF NOT EXISTS maintenance_interval_days integer,
  ADD COLUMN IF NOT EXISTS next_maintenance_on date,
  ADD COLUMN IF NOT EXISTS last_maintenance_on date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='devices_operational_status_check') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_operational_status_check
      CHECK (operational_status IN ('active','maintenance','fault','offline','decommissioned'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='devices_maintenance_interval_check') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_maintenance_interval_check
      CHECK (maintenance_interval_days IS NULL OR maintenance_interval_days>0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='devices_tenant_location_fk') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_tenant_location_fk
      FOREIGN KEY (tenant_id,location_id) REFERENCES object_locations(tenant_id,id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='devices_tenant_responsible_fk') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_tenant_responsible_fk
      FOREIGN KEY (tenant_id,responsible_employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS devices_tenant_asset_number_uidx
  ON devices(tenant_id,asset_number) WHERE asset_number IS NOT NULL;

ALTER TABLE dms_documents
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
