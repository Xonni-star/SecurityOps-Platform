# Backup and restore

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
