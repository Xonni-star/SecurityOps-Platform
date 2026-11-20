# ADR-019: Phase 4, Schritt 13c — Restore-Abnahme

## Status

Implemented. CI runs an isolated PostgreSQL and MinIO restore drill. Local
execution uses the same script and committed deterministic fixtures.

## Decision

PostgreSQL and DMS blobs are independent backup contracts and are restored in
that order: restore the custom-format database dump into a separately named
database, then mirror the source MinIO bucket into a separately named restore
bucket. The drill verifies the DMS contract version/status, tenant-scoped RLS
visibility, metadata-to-object-key linkage, byte sizes, SHA-256 values, and
retention policy/candidate state. It records UTC timestamps, backup duration,
restore duration, RPO, and RTO.

The script requires explicit isolated-resource confirmation and refuses to run
when `pg_dump`, `pg_restore`, `psql`, `sha256sum`, `mc`, PostgreSQL, MinIO, or
credentials are unavailable. It never deletes or cleans a source database or
bucket. The generated restore bucket is the only bucket created by the drill;
the temporary database must be created by the operator/CI as an isolated
resource.

## Evidence and open prerequisites

The CI workflow starts disposable Compose services and executes the drill on
every push and pull request. A local pass is valid only when the command output
contains `Restore drill passed` and the measured evidence lines. If the
environment lacks Docker, PostgreSQL, MinIO, credentials, or the required CLIs,
the result is **OFFEN**, not a restore acceptance. The drill does not prove
off-site replication, encryption-at-rest, provider durability, or production
scale performance.
