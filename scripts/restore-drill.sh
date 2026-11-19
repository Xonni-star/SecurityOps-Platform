#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_FILE:?BACKUP_FILE must point to a pg_dump custom-format file}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL must point to an isolated restore database}"
: "${HEALTH_URL:=}"

pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null

if [[ -n "$HEALTH_URL" ]]; then
  curl --fail --silent --show-error "$HEALTH_URL/ready" >/dev/null
fi

echo "Restore drill passed for $BACKUP_FILE"
