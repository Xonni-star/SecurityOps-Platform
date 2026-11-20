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

## Phase 2, step 6: idempotent offline sync

Migration 013 adds the tenant-scoped `sync_receipts` table. It requires
PostgreSQL `pgcrypto`, the Phase-1 composite user key `(tenant_id,id)`, and
RLS transaction context (`app.tenant_id`). The API stores a canonical SHA-256
payload hash and completes the receipt and mobile mutation in one transaction.
It is safe to retry the same mutation after a lost response; a changed payload
or action is rejected with HTTP 409.

## Phase 2, step 7: authenticated devices

Migration 014 is additive. It extends the existing tenant-scoped `devices`
table with authenticated-device metadata, `revoked_at`, and binds `sessions`
through `(tenant_id,device_id)`. It requires PostgreSQL `pgcrypto`, the
Phase-1 RLS and composite-FK setup, and PostgreSQL transactional DML.
Existing unbound sessions are no longer accepted by the auth middleware; users
must sign in again with a client-generated device UUID.

## Phase 3, step 8: digital watchbook

Migration 015 adds tenant-scoped watchbook categories, priorities, immutable
entries, and append-only revisions. PostgreSQL RLS, composite foreign keys,
and an immutable-history trigger enforce tenant isolation and prevent update or
delete of revisions. Corrections must reference the prior revision and are
bound to the authenticated user session and device.

The initial category and priority set is inserted for existing tenants and can
be extended only with the corresponding scoped permissions. New mobile entries
use `client_entry_id` or `Idempotency-Key` with the existing sync receipts;
there is no delta, pull, or cross-device synchronization contract. Retention
and deletion of watchbook history require a separately approved operational
policy; the API exposes no history deletion operation.

## Phase 3, step 9: duty scheduling

Migration 016 adds tenant-scoped rule profile versions, schedule periods,
shifts, employee assignments, qualifications, absences, and persisted conflict
findings. All mutations use the existing authenticated session, CSRF, RBAC,
audit, and offline idempotency mechanisms. Site-scoped grants are enforced for
site-bound schedule operations.

Rule profiles are configurable JSON parameters owned by the tenant. The
implementation deliberately contains no hardcoded tariff, labor-law, or other
legal rule and makes no legal or tariff statement. Legal/tariff acceptance is
explicitly open. Overlaps, missing qualifications, absences, and configured
parameter deviations are recorded as explainable conflict findings rather than
silently rejected.

## Phase 3, step 11: key management

Migration 018 is additive and introduces tenant/site-scoped `keys` plus the
append-only `key_movements` history. It must not be edited after release.
Issue, return, loss and deactivation operations lock the current row, enforce
the explicit status machine, write an audit event and use offline idempotency
receipts. Holder references are UUID-only and never duplicate personal data.
PostgreSQL integration tests require `POSTGRES_TEST_DATABASE_URL`; without it,
the RLS suite is skipped and the missing database is reported explicitly by
the test command.

## Phase 3, step 12: shift handover protocols

Migration 019 adds tenant/site-scoped shift handovers, identity-bound
participants, append-only confirmation rows, and hash-chained append-only
events. Each participant references exactly one existing user or employee.
Confirmations record the authenticated session and device; corrections and
revocations append new records rather than silently changing history.

Handover mutations use the existing `sync_receipts` actions and reject action or
payload-hash mismatches. Site grants limit site-bound access, while the
`handover:confirm` own scope binds ordinary confirmations to the participant's
authenticated user identity. No direct task/attachment contract, delta/pull
feed, or cross-device synchronization is introduced. Retention and DSGVO
deletion require a separately approved policy.
