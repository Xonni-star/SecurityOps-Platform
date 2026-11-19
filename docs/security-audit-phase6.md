# Phase 6 security and production audit

## Reviewed controls

- Session cookies remain httpOnly and tenant/user permissions are loaded from PostgreSQL.
- State-changing routes use the existing session-bound CSRF token.
- Phase 6 NFC, reporting, TimeScan, audit, privacy and backup endpoints use explicit permissions and tenant predicates.
- Rate limiting, Helmet, CORS allow-listing, structured error handling and WebSocket session authentication remain enabled.
- TimeScan and notification credentials are environment/secret references; no credential is persisted in source or seed data.
- NFC identifiers are tenant-unique and assignments are limited to one employee, site or control point.
- Privacy export/delete is explicit, confirmed and audit-recorded; retention policies are tenant-configurable.

## Resolved findings

- Added dedicated `nfc_devices` permissions and tenant-safe assignment validation.
- Added audit records for generic CRUD and Phase 5 operations.
- Added idempotent TimeScan keys and notification outbox keys.
- Added production compose configuration without development credentials and executable backup/load-test tooling.

## Residual production actions

Configure TLS/reverse proxy, a centralized secret manager, encrypted off-site backups and restore drills,
monitoring/alerting, database migration execution outside first-start initialization, shared leases for
background workers, dependency vulnerability scanning and legal approval of retention periods.
