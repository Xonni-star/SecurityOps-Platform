# Backup scheduler runbook

Configure `BACKUP_SECRET_KEY` through deployment secret management and set
`BACKUP_DB_SCRIPT` only when the standard `scripts/backup-db.sh` location is
different. Never put target passwords in frontend configuration, logs, or
repository files. Prefer `secret_ref` for an external secret manager.

Use the tenant API with `settings:write` to set a daily or weekly UTC/IANA
timezone schedule and retention count/days. Use `backup:manage` to create
targets and trigger a manual run. `/api/v1/backups/status` exposes the worker
state, last run, target outcomes and recent errors without secret payloads.

Operational verification requires a successful run with database and DMS
artifact hashes, followed by the existing isolated `scripts/restore-drill.sh`.
If PostgreSQL, MinIO, provider credentials or required CLIs are unavailable,
the restore acceptance remains **OFFEN** and must not be reported as fixed.
