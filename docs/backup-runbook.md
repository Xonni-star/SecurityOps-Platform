# Backup scheduler runbook

Configure `BACKUP_SECRET_KEY` through deployment secret management and set
`BACKUP_DB_SCRIPT` only when the standard `scripts/backup-db.sh` location is
different. Never put target passwords in frontend configuration, logs, or
repository files. Prefer `secret_ref` for an external secret manager.

Use the tenant API with `settings:write` to set a daily or weekly UTC/IANA
timezone schedule and retention count/days. Use `backup:manage` to create
`local`, `smb`, `sftp` or `s3` targets and trigger a manual run. Unencrypted
FTP is not supported. SFTP should use an SSH key through `secret_ref`; S3
credentials should use `secret_ref` or encrypted server-side storage. Every
change requires a reason and is audited without secret values.

Failed runs notify the `admin` role in-app by default. Add email/SMS rules via
`/api/v1/settings/backup-notifications`; success notifications are opt-in.
Notification delivery is deduplicated by event key and recipient, retried with
bounded backoff, and failures are recorded in the audit log. Provider status
remains `not_configured` or `configured` until a real verification succeeds.

`/api/v1/backups/status` exposes the worker state, last run, target outcomes and
recent errors without secret payloads.

Operational verification requires a successful run with database and DMS
artifact hashes, followed by the existing isolated `scripts/restore-drill.sh`.
If PostgreSQL, MinIO, provider credentials or required CLIs are unavailable,
the restore acceptance remains **OFFEN** and must not be reported as fixed.
