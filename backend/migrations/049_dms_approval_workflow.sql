-- Makes document approval attributable and closes the FK-name collision left by 039/045.
-- Idempotent: safe to re-run against existing installations.
ALTER TABLE dms_documents
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS approval_feedback text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_tenant_approver_fk') THEN
    ALTER TABLE dms_documents
      ADD CONSTRAINT dms_documents_tenant_approver_fk
      FOREIGN KEY (tenant_id,approved_by) REFERENCES users(tenant_id,id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_employee_document_category_check') THEN
    ALTER TABLE dms_documents
      ADD CONSTRAINT dms_documents_employee_document_category_check
      CHECK (employee_document_category IS NULL OR employee_document_category IN ('contract','qualification','training','instruction','personal','other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS dms_documents_site_type_validity_idx
  ON dms_documents(tenant_id,site_id,document_type,approval_status,valid_until)
  WHERE document_status='active';

CREATE INDEX IF NOT EXISTS dms_documents_review_idx
  ON dms_documents(tenant_id,review_on)
  WHERE document_status='active' AND review_on IS NOT NULL;
