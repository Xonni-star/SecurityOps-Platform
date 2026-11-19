# ADR-005: Reporting, TimeScan and platform protection

## Context

The platform needs management reporting, a provider integration for working time, and
operational controls for auditability, privacy and recovery.

## Decision

Reports use tenant-scoped SQL with explicit date, site and employee filters and export
to CSV or a dependency-free PDF representation. TimeScan is accessed only through the
`TimeScanAdapter`; credentials are referenced by an environment variable name stored as
`secret_ref`, never stored in the database. Sync runs are recorded and work-time rows
use `(tenant, provider, external_id)` as an idempotency key.

Audit events are queryable and exportable. Retention policies are tenant-configurable
with conservative defaults. Data-subject export returns scoped records, while deletion
removes direct-message content and anonymizes the user identity. PostgreSQL custom-format
backups and restore scripts are versioned and use `DATABASE_URL`; backup artifacts are
not committed.

## Consequences

- Provider credentials remain deployment secrets and can be rotated without code changes.
- Reports and privacy operations are auditable and permission protected.
- Restore must be tested in an isolated database before production use.
- Backup storage, encryption at rest, off-site replication and scheduled execution remain
  deployment responsibilities.
