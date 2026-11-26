-- Geräteakte: Dokumente bleiben in der einen DMS-Datenhaltung und erhalten
-- nur eine optionale Zuordnung zum Betriebsgerät.
ALTER TABLE dms_documents
  ADD COLUMN IF NOT EXISTS device_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_tenant_device_fk') THEN
    ALTER TABLE dms_documents
      ADD CONSTRAINT dms_documents_tenant_device_fk
      FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS dms_documents_tenant_device_idx
  ON dms_documents(tenant_id, device_id);
