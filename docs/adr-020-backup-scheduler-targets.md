# ADR-020: Backup scheduler and storage targets

## Status

Implemented additively on top of the Phase 4 load-test baseline.

## Decision

The in-process worker is lifecycle-safe (`startBackupWorker` is idempotent) and
persists tenant-scoped settings, runs, target attempts and artifact hashes.
PostgreSQL backup execution delegates to `scripts/backup-db.sh`; DMS objects
are read through the existing blob adapter and referenced by object key,
size and SHA-256 in a manifest. A run is successful only when at least one
enabled target received every artifact.

Targets support local files, SMB/CIFS, SFTP and S3-compatible storage. Unencrypted FTP is not supported; any future FTPS support must remain a separate encrypted adapter and API type.
providers. Target secrets are encrypted with `BACKUP_SECRET_KEY` or represented
by an external `secret_ref`; secrets are never returned by the API or logged.
Retries and failed target runs remain explicit evidence.

## Retention and prerequisites

Retention is tenant-scoped and must only address artifacts under the generated
`tenant/run-id/` prefix. Production deployments still require isolated backup
storage, credentials/secret references, provider connectivity and periodic
restore-drill execution. Existing CI and restore-drill blockers remain open
when those infrastructure prerequisites are unavailable.
# Provider settings and backup notifications

Provider settings are tenant-scoped and return only non-secret configuration
and `secret_ref`. Mutations require `settings:write`, a reason, and an audit
event. Backup failures use the existing notification subscription/delivery
tables; admins receive an in-app failure notification by default, while
success notifications are opt-in. Delivery uses the existing deduplication
key and retry queue, and never includes credentials in the event body.

Supported targets are local, SMB/CIFS, SFTP and S3-compatible storage
(including AWS and MinIO). Unencrypted FTP is intentionally rejected.
