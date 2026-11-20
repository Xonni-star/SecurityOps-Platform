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

Baseline validation checks the longest complete prefix of the migration set.
This matters when a database predates the runner: the nine existing migrations
are recorded as a baseline and `010_tenant_rls_and_composite_fks.sql` is then
executed normally instead of being silently skipped.

## Phase 1, step 3: tenant isolation

Migration 010 is additive and must not be edited after release. Before adding
composite foreign keys it validates every tenant-bearing relationship and aborts
with an explicit error on the first cross-tenant row. It backfills tenant IDs
for `sessions`, `patrol_route_points`, and `incident_assignments`, then adds
`(tenant_id,id)`-based references and enables `FORCE ROW LEVEL SECURITY` on all
tenant data tables.

`tenants`, `permissions`, and `role_permissions` are deliberate global tables.
Login and session lookup use server-set, short-lived transaction settings;
authenticated requests use `app.tenant_id`, set by the backend request
context. The application does not use a superuser or `BYPASSRLS` path.

Run PostgreSQL integration checks against a disposable database with:

```sh
POSTGRES_TEST_DATABASE_URL=postgres://... npm test -w backend -- rls.integration
```

The test database role must be able to create a temporary `NOSUPERUSER
NOBYPASSRLS` role. Roll out first to a restored staging copy, inspect the
cross-tenant validation failure output, and monitor migration duration,
constraint creation locks, RLS-denied errors, and worker throughput. Rollback
requires restoring the pre-migration database or applying a separately
reviewed forward migration; do not disable RLS in production.
