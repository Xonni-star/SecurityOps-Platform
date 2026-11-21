ALTER TABLE patrol_scans
  ADD COLUMN IF NOT EXISTS server_received_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS scan_authentication text NOT NULL DEFAULT 'uid_registered',
  ADD COLUMN IF NOT EXISTS nfc_device_id uuid;

ALTER TABLE patrol_scans DROP CONSTRAINT IF EXISTS patrol_scans_authentication_check;
ALTER TABLE patrol_scans
  ADD CONSTRAINT patrol_scans_authentication_check
  CHECK (scan_authentication IN ('uid_registered','cryptographic','manual_exception'));

ALTER TABLE patrol_scans DROP CONSTRAINT IF EXISTS patrol_scans_nfc_device_fk;
ALTER TABLE patrol_scans
  ADD CONSTRAINT patrol_scans_nfc_device_fk
  FOREIGN KEY (tenant_id, nfc_device_id) REFERENCES nfc_devices(tenant_id, id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS patrol_scans_integrity_idx
  ON patrol_scans(tenant_id, route_id, server_received_at);
