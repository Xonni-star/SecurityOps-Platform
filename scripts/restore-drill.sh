#!/usr/bin/env bash
set -euo pipefail

# This drill is intentionally explicit about its prerequisites and target
# resources. It must only be run against disposable source and restore
# databases/buckets.
if [[ -z "${DATABASE_URL:-}" ]]; then echo "OFFEN: DATABASE_URL is missing; drill did not run" >&2; exit 2; fi
if [[ -z "${RESTORE_DATABASE_URL:-}" ]]; then echo "OFFEN: RESTORE_DATABASE_URL is missing; drill did not run" >&2; exit 2; fi
if [[ -z "${MINIO_ENDPOINT:-}" ]]; then echo "OFFEN: MINIO_ENDPOINT is missing; drill did not run" >&2; exit 2; fi
if [[ -z "${MINIO_ACCESS_KEY:-}" ]]; then echo "OFFEN: MINIO_ACCESS_KEY is missing; drill did not run" >&2; exit 2; fi
if [[ -z "${MINIO_SECRET_KEY:-}" ]]; then echo "OFFEN: MINIO_SECRET_KEY is missing; drill did not run" >&2; exit 2; fi
if [[ -z "${MINIO_BUCKET:-}" ]]; then echo "OFFEN: MINIO_BUCKET is missing; drill did not run" >&2; exit 2; fi
if [[ -z "${RESTORE_DRILL_ALLOW_ISOLATED_RESOURCES:-}" ]]; then echo "OFFEN: RESTORE_DRILL_ALLOW_ISOLATED_RESOURCES is missing; drill did not run" >&2; exit 2; fi

if [[ "$RESTORE_DRILL_ALLOW_ISOLATED_RESOURCES" != "YES" ]]; then
  echo "OFFEN: RESTORE_DRILL_ALLOW_ISOLATED_RESOURCES must be YES; no resources were changed" >&2
  exit 2
fi
if [[ "$DATABASE_URL" == "$RESTORE_DATABASE_URL" ]]; then
  echo "OFFEN: source and restore database URLs must be different isolated resources" >&2
  exit 2
fi
RESTORE_BUCKET="${RESTORE_BUCKET:-${MINIO_BUCKET}-restore-$(date -u +%Y%m%d%H%M%S)-$$}"
if [[ "$MINIO_BUCKET" == "$RESTORE_BUCKET" ]]; then
  echo "OFFEN: source and restore buckets must be different isolated resources" >&2
  exit 2
fi

FIXTURE_SQL="${FIXTURE_SQL:-$(dirname "$0")/restore-drill-fixture.sql}"
FIXTURE_BLOB_DIRECTORY="${FIXTURE_BLOB_DIRECTORY:-$(dirname "$0")/restore-drill-fixture-blobs}"
WORK_DIRECTORY="${RESTORE_DRILL_WORK_DIRECTORY:-$(mktemp -d "${TMPDIR:-/tmp}/securityops-restore-drill.XXXXXX")}"
BACKUP_FILE="${BACKUP_FILE:-$WORK_DIRECTORY/database.dump}"
MC_ALIAS="${MC_ALIAS:-restore-drill}"
MC="${MC:-mc}"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date +%s)"

cleanup() {
  rm -rf "$WORK_DIRECTORY"
  if [[ "${KEEP_BACKUP_FILE:-0}" != "1" ]]; then rm -f "$BACKUP_FILE"; fi
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "OFFEN: required command '$1' is unavailable; drill did not run" >&2
    exit 2
  }
}

for command in pg_dump pg_restore psql "$MC"; do require_command "$command"; done
if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | awk '{print $1}'; }
else
  require_command shasum
  hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
fi
[[ -f "$FIXTURE_SQL" ]] || { echo "OFFEN: fixture SQL missing: $FIXTURE_SQL" >&2; exit 2; }
[[ -d "$FIXTURE_BLOB_DIRECTORY" ]] || { echo "OFFEN: fixture blobs missing: $FIXTURE_BLOB_DIRECTORY" >&2; exit 2; }
mkdir -p "$WORK_DIRECTORY/source-blobs" "$WORK_DIRECTORY/restored-blobs"

echo "Restore drill started at $started_at"
echo "Source database: isolated resource required; restore database: isolated resource required"
echo "Source bucket: $MINIO_BUCKET; restore bucket: $RESTORE_BUCKET"

fixture_started="$(date +%s)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$FIXTURE_SQL" >/dev/null
latest_data_epoch="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT FLOOR(EXTRACT(EPOCH FROM MAX(created_at))::numeric)::bigint FROM dms_versions")"
echo "Fixture load: $(( $(date +%s) - fixture_started ))s"

"$MC" alias set "$MC_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --api S3v4 >/dev/null
"$MC" mb --ignore-existing "$MC_ALIAS/$MINIO_BUCKET" >/dev/null
"$MC" mirror --overwrite "$FIXTURE_BLOB_DIRECTORY" "$MC_ALIAS/$MINIO_BUCKET"

backup_started="$(date +%s)"
pg_dump --format=custom --file="$BACKUP_FILE" "$DATABASE_URL"
"$MC" mirror --overwrite "$MC_ALIAS/$MINIO_BUCKET" "$WORK_DIRECTORY/source-blobs"
backup_finished="$(date +%s)"

restore_started="$(date +%s)"
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null
"$MC" mb --ignore-existing "$MC_ALIAS/$RESTORE_BUCKET" >/dev/null
"$MC" mirror --overwrite "$WORK_DIRECTORY/source-blobs" "$MC_ALIAS/$RESTORE_BUCKET"
"$MC" mirror --overwrite "$MC_ALIAS/$RESTORE_BUCKET" "$WORK_DIRECTORY/restored-blobs"
restore_finished="$(date +%s)"

assert_equals() {
  local expected="$1" actual="$2" label="$3"
  [[ "$expected" == "$actual" ]] || { echo "FAILED: $label (expected $expected, got $actual)" >&2; exit 1; }
}

assert_equals 2 "$(psql "$RESTORE_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM tenants WHERE name LIKE '\''Restore Drill Tenant %'\''')" "tenant count"
assert_equals 2 "$(psql "$RESTORE_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM dms_versions WHERE lifecycle_state = '\''available'\''')" "available DMS version count"
assert_equals 2 "$(psql "$RESTORE_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM dms_blob_backup_status WHERE contract_version='dms-blob-backup-v1' AND status='healthy'")" "DMS blob backup contract"
assert_equals 2 "$(psql "$RESTORE_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM dms_retention_policies WHERE name='restore-drill' AND retention_days=30")" "retention policy"
assert_equals 1 "$(psql "$RESTORE_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM dms_versions WHERE retention_until <= now() AND lifecycle_state='available'")" "expired retention candidate"
assert_equals 0 "$(psql "$RESTORE_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM dms_versions WHERE retention_until > now() AND lifecycle_state <> 'available'")" "future retention state"

psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE restore_drill_rls;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000a1', false);
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM dms_versions
  WHERE tenant_id = '00000000-0000-0000-0000-0000000000b1';
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'tenant isolation failed: % foreign rows visible', visible_count;
  END IF;
END $$;
ROLLBACK;
SQL

while IFS=$'\t' read -r object_key expected_hash expected_size; do
  [[ -n "$object_key" ]] || continue
  object_file="$WORK_DIRECTORY/restored-blobs/$object_key"
  [[ -f "$object_file" ]] || { echo "FAILED: missing restored blob $object_key" >&2; exit 1; }
  actual_hash="$(hash_file "$object_file")"
  actual_size="$(wc -c < "$object_file" | tr -d ' ')"
  assert_equals "$expected_hash" "$actual_hash" "blob hash $object_key"
  assert_equals "$expected_size" "$actual_size" "blob size $object_key"
done < <(psql "$RESTORE_DATABASE_URL" -At -F $'\t' -v ON_ERROR_STOP=1 -c \
  "SELECT object_key, sha256, size_bytes FROM dms_versions WHERE lifecycle_state='available' ORDER BY object_key")

latest_restore_epoch="$(psql "$RESTORE_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT FLOOR(EXTRACT(EPOCH FROM MAX(created_at))::numeric)::bigint FROM dms_versions")"
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
finished_epoch="$(date +%s)"
echo "Restore drill passed at $finished_at"
echo "Evidence: started_at=$started_at finished_at=$finished_at"
echo "Evidence: backup_seconds=$((backup_finished - backup_started)) restore_seconds=$((restore_finished - restore_started))"
echo "Evidence: rpo_seconds=$((backup_started - latest_data_epoch)) restored_latest_data_epoch=$latest_restore_epoch"
echo "Evidence: rto_seconds=$((finished_epoch - restore_started))"
echo "Evidence: checks=database_restore,blob_restore,tenant_isolation,dms_metadata_blob_links,retention,sha256"
