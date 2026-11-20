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

Targets support local files, SMB/CIFS, FTP/FTPS, SFTP and S3-compatible
providers. Target secrets are encrypted with `BACKUP_SECRET_KEY` or represented
by an external `secret_ref`; secrets are never returned by the API or logged.
Retries and failed target runs remain explicit evidence.

## Retention and prerequisites

Retention is tenant-scoped and must only address artifacts under the generated
`tenant/run-id/` prefix. Production deployments still require isolated backup
storage, credentials/secret references, provider connectivity and periodic
restore-drill execution. Existing CI and restore-drill blockers remain open
when those infrastructure prerequisites are unavailable.
