#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-./backups}"
mkdir -p "$BACKUP_DIRECTORY"
file="$BACKUP_DIRECTORY/securityops-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --file="$file" "$DATABASE_URL"
echo "$file"
