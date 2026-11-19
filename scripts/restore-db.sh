#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${1:?Usage: scripts/restore-db.sh path/to/backup.dump}"
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$1"
