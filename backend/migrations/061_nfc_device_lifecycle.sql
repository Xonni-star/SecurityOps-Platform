-- NFC-Geräte-Lebenszyklus: erweiterte Stammdaten, Wiederauffinden und
-- Archivierung. Die Migration ist additiv; vorhandene Geräte, Scans und
-- Historien werden nicht gelöscht oder stillschweigend umgeschrieben.

ALTER TABLE nfc_devices
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_reason text,
  ADD COLUMN IF NOT EXISTS recovered_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovered_reason text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='nfc_devices_model_length_check') THEN
    ALTER TABLE nfc_devices ADD CONSTRAINT nfc_devices_model_length_check
      CHECK (model IS NULL OR length(model) <= 200);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='nfc_devices_serial_number_length_check') THEN
    ALTER TABLE nfc_devices ADD CONSTRAINT nfc_devices_serial_number_length_check
      CHECK (serial_number IS NULL OR length(serial_number) <= 200);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='nfc_devices_description_length_check') THEN
    ALTER TABLE nfc_devices ADD CONSTRAINT nfc_devices_description_length_check
      CHECK (description IS NULL OR length(description) <= 2000);
  END IF;
END $$;

-- Vorhandene doppelte aktive Kontrollpunktzuordnungen werden archiviert statt
-- gelöscht. Behalten wird der Tag mit tatsächlicher Scan-Historie. Alle
-- alten Datensätze bleiben über nfc_device_id erhalten.
WITH duplicates AS (
  SELECT n.id,
    row_number() OVER (
      PARTITION BY n.tenant_id, n.control_point_id
      ORDER BY EXISTS (
        SELECT 1 FROM patrol_scans ps
        WHERE ps.tenant_id=n.tenant_id AND ps.nfc_device_id=n.id
      ) DESC, n.registered_at DESC, n.identifier ASC
    ) AS rank
  FROM nfc_devices n
  WHERE n.control_point_id IS NOT NULL AND n.status='active' AND n.archived_at IS NULL
)
UPDATE nfc_devices d
SET archived_at=now(),
    archived_reason='Doppelte aktive Kontrollpunktzuordnung bereinigt',
    event_reason='Doppelte aktive Kontrollpunktzuordnung bereinigt',
    updated_at=now()
FROM duplicates dup
WHERE d.id=dup.id AND dup.rank>1 AND d.archived_at IS NULL;

-- Ein Kontrollpunkt darf nur von einem aktiven, nicht archivierten Tag
-- belegt sein. Die Prüfung wird zusätzlich serverseitig vor jedem
-- Zuordnungswechsel durchgeführt.
CREATE UNIQUE INDEX IF NOT EXISTS nfc_devices_active_control_point_uidx
  ON nfc_devices(tenant_id,control_point_id)
  WHERE control_point_id IS NOT NULL AND status='active' AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS control_points_tenant_nfc_uid_uidx
  ON control_points(tenant_id,nfc_uid);

CREATE INDEX IF NOT EXISTS nfc_devices_tenant_archived_idx
  ON nfc_devices(tenant_id,archived_at);
