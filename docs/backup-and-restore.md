# Backup and restore

## Restore-Abnahme (Phase 4, Schritt 13c)

The acceptance drill is reproducible and never uses production resources. It
requires disposable PostgreSQL source and restore databases, a disposable
MinIO source bucket, `pg_dump`, `pg_restore`, `psql`, `sha256sum`, `mc`, and
explicit `RESTORE_DRILL_ALLOW_ISOLATED_RESOURCES=YES`. The committed fixture
creates two tenants and DMS metadata; fixture blobs are restored independently.
The drill refuses to run when a prerequisite is missing and reports `OFFEN`
instead of a pass.

Run locally only against isolated resources:

```bash
DATABASE_URL=postgres://securityops:securityops@127.0.0.1:5432/securityops \
RESTORE_DATABASE_URL=postgres://securityops:securityops@127.0.0.1:5432/securityops_restore \
MINIO_ENDPOINT=http://127.0.0.1:9000 \
MINIO_ACCESS_KEY=restore-drill \
MINIO_SECRET_KEY=restore-drill-secret \
MINIO_BUCKET=securityops-dms-restore-drill \
RESTORE_DRILL_ALLOW_ISOLATED_RESOURCES=YES \
./scripts/restore-drill.sh
```

The CI job starts disposable PostgreSQL and builds the pinned official MinIO
release source from GitHub into a runner-local server binary. The source
archive URL, release tag, and SHA-256 are pinned in the workflow; no Docker Hub,
Quay, registry credential, or production service is needed. The binary listens
only on loopback, and its process and data directory are removed in an
`if: always()` cleanup step. CI then applies the schema, creates a separate
restore database, and executes the same drill. Restore order is PostgreSQL
dump/restore first, then MinIO bucket restore. The result
prints UTC timestamps, backup/restore durations, RPO (source fixture data to
backup start), RTO (restore start to completed checks), and each check:
database restore, tenant isolation through PostgreSQL RLS, DMS metadata and
object-key linkage, retention metadata/candidate state, object sizes, and
SHA-256 hashes. A successful PostgreSQL backup alone is not evidence that DMS
blobs are recoverable.

Known limits: the drill validates the configured S3-compatible bucket contract
and metadata linkage, not provider replication, encryption-at-rest, off-site
copy, or a production-scale throughput target. If PostgreSQL, MinIO, Docker,
credentials, or required CLIs are unavailable, the acceptance remains **OFFEN**
with the prerequisite in the command output; no production data or secret is
used.

Set `DATABASE_URL` and `BACKUP_DIRECTORY` from deployment secrets. Create a compressed
PostgreSQL custom-format backup with:

```bash
mkdir -p backups
DATABASE_URL="$DATABASE_URL" BACKUP_DIRECTORY=./backups ./scripts/backup-db.sh
```

Restore into an isolated PostgreSQL database first:

```bash
DATABASE_URL="$RESTORE_DATABASE_URL" ./scripts/restore-db.sh backups/securityops-<timestamp>.dump
```

The restore procedure uses `pg_restore --clean --if-exists --no-owner`. Validate `/health`,
run the migration/test suite, and perform a tenant-scoped login and report export before
promoting the restored database. Production operations must schedule the backup, encrypt
files at rest, copy them off-site, restrict access, and periodically execute a restore
drill. The API exposes `/api/v1/backups/status` for configured backup-artifact visibility.
