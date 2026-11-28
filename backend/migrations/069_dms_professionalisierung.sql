-- Additive DMS hardening: version idempotency, workflow states and list performance.
-- Existing migrations and data are left untouched.

-- Neue Mutationsart für unveränderliche Dokumentversionen zulassen. Die
-- vollständige Liste wird bewusst erneut geschrieben, damit frühere Migrationen
-- nicht nachträglich geändert werden müssen.
ALTER TABLE sync_receipts DROP CONSTRAINT IF EXISTS sync_receipts_action_check;
ALTER TABLE sync_receipts ADD CONSTRAINT sync_receipts_action_check
  CHECK (action IN (
    'alarms.panic','patrol.scan','watchbook.entry','scheduling.period',
    'scheduling.shift','scheduling.assignment','scheduling.rule_profile',
    'dms.document','dms.document.version','keys.create','keys.issue',
    'keys.return','keys.lost','keys.deactivate','handover.create',
    'handover.participant','handover.confirm','handover.revoke','handover.correct',
    'keys.bundle.create','keys.bundle.item','keys.bundle.issue',
    'keys.bundle.return','maintenance.order.create','keys.update','keys.block',
    'keys.reactivate','keys.loss.report','keys.loss.update','keys.qr.issue',
    'keys.inventory.check','keys.bundle.deactivate','keys.bundle.item_removed'
  ));

-- Statusübergänge und gelöschte Dokumente müssen konsistent bleiben. NOT VALID
-- schützt neue Schreibzugriffe, ohne historische Datensätze zu verändern.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dms_documents_deleted_at_check') THEN
    ALTER TABLE dms_documents ADD CONSTRAINT dms_documents_deleted_at_check
      CHECK ((document_status='deleted')=(deleted_at IS NOT NULL)) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS dms_documents_status_approval_idx
  ON dms_documents(tenant_id,document_status,approval_status,created_at DESC);
CREATE INDEX IF NOT EXISTS dms_documents_deleted_idx
  ON dms_documents(tenant_id,deleted_at) WHERE document_status='deleted';
CREATE INDEX IF NOT EXISTS dms_versions_lifecycle_idx
  ON dms_versions(tenant_id,document_id,lifecycle_state,version_no DESC);

CREATE OR REPLACE FUNCTION dms_documents_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dms_documents_touch_updated_at ON dms_documents;
CREATE TRIGGER dms_documents_touch_updated_at
  BEFORE UPDATE ON dms_documents
  FOR EACH ROW EXECUTE FUNCTION dms_documents_touch_updated_at();
