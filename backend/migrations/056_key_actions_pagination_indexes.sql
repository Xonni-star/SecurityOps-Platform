-- Supporting indexes for paginated key pickers, SQL-ranked A/B/C actions and
-- batched CSV exports. All additions are idempotent and non-destructive.
CREATE INDEX IF NOT EXISTS keys_tenant_key_code_lower_idx ON keys(tenant_id, lower(key_code), id);
CREATE INDEX IF NOT EXISTS key_movements_tenant_type_created_idx ON key_movements(tenant_id, movement_type, created_at DESC);
CREATE INDEX IF NOT EXISTS key_bundles_tenant_status_idx ON key_bundles(tenant_id, status);
CREATE INDEX IF NOT EXISTS key_bundle_items_tenant_bundle_key_idx ON key_bundle_items(tenant_id, bundle_id, key_id);
