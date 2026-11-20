# Database migrations

SecurityOps uses the typed migration runner in `backend/src/db/migration-runner.ts`.
Migration files remain append-only and are ordered by their numeric prefix. The
runner computes a SHA-256 checksum for every file, applies pending files in one
transaction, and takes a PostgreSQL advisory lock so only one deploy can migrate
at a time.

## Local execution

```sh
npm run migrate
```

The command uses `DATABASE_URL` (or the backend default) and records state in
`securityops_migrations`. Re-running it is safe: applied files are skipped after
their checksums are verified.

## Deployments and upgrades

The production backend image runs the runner before starting Express. The
existing Docker PostgreSQL init mount is intentionally retained for fresh
volumes; when that init path has already created the schema, the runner validates
the schema and records all nine existing migrations as a baseline instead of
executing them again. Subsequent migrations are applied normally.

Never edit an applied migration. Add the next contiguous `NNN_description.sql`
file. A missing sequence, unknown recorded migration, or checksum change fails
the deployment with an explicit error and rolls back the current transaction.

Baseline validation checks all tables declared by the nine existing migration
files and all columns added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
An incomplete or drifted pre-runner database is rejected; it must be repaired
or restored before upgrading.
