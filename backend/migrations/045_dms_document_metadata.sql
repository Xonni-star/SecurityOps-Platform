ALTER TABLE dms_documents
  ADD COLUMN IF NOT EXISTS document_number text,
  ADD COLUMN IF NOT EXISTS document_type text,
  ADD COLUMN IF NOT EXISTS responsible_employee_id uuid,
  ADD COLUMN IF NOT EXISTS valid_from date,
  ADD COLUMN IF NOT EXISTS valid_until date,
  ADD COLUMN IF NOT EXISTS review_on date,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS location_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_validity_check') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_documents_validity_check
      CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until>=valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_review_check') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_documents_review_check
      CHECK (review_on IS NULL OR valid_from IS NULL OR review_on>=valid_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_approval_status_check') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_documents_approval_status_check
      CHECK (approval_status IN ('draft','pending_approval','approved','rejected','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_tenant_employee_fk') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_documents_tenant_employee_fk
      FOREIGN KEY (tenant_id,responsible_employee_id) REFERENCES employees(tenant_id,id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_tenant_location_fk') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_documents_tenant_location_fk
      FOREIGN KEY (tenant_id,location_id) REFERENCES object_locations(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS dms_documents_validity_idx
  ON dms_documents(tenant_id,valid_until)
  WHERE document_status='active';
