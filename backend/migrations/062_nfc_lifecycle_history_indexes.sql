-- additional indexes for NFC lifecycle history and rejected scan lookup
-- Existing migrations are left untouched.

CREATE INDEX IF NOT EXISTS audit_events_tenant_nfc_entity_idx
  ON audit_events (tenant_id, entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_tenant_scan_rejected_idx
  ON audit_events (tenant_id, created_at DESC)
  WHERE event_type = 'patrol.scan.rejected';

CREATE INDEX IF NOT EXISTS patrol_scans_tenant_nfc_scanned_idx
  ON patrol_scans (tenant_id, nfc_device_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS nfc_device_replacements_tenant_new_idx
  ON nfc_device_replacements (tenant_id, new_device_id, replaced_at DESC);
