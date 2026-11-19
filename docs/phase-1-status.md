# Phase 1 status

Implemented: runnable PostgreSQL-backed API, migrations and seed, Argon2id authentication with opaque server-side httpOnly sessions, login/logout, session-bound CSRF protection, granular PostgreSQL permissions, tenant-isolated CRUD for employees/customers/sites/devices/alarms, updated_at timestamps and indexes, OpenAPI endpoint, session-authenticated WebSocket heartbeat, security middleware, frontend login/logout/protected navigation/basic CRUD, tests, Docker Compose, CI, and documentation.

Phase 2 complete: configurable tenant-scoped alarm priorities, expanded alarm model and lifecycle history, panic alarms, authenticated tenant-filtered WebSocket alarm events, configurable escalation rules with a 30-second worker, NFC control points and patrol routes, scan deviation alarms, and Leitstelle/patrol UI views. Phase 2 migrations are in `backend/migrations/004_phase2_alarm_patrol.sql`; deployment starts the escalation worker with the backend process.

Phase 3 complete: tenant-scoped sensor thresholds/events, authenticated telemetry ingest, fall/posture/inactivity/battery alarm evaluation through the Phase 2 alarm service, GPS position history and realtime pushes, Leaflet/OpenStreetMap live map, and incident management with assignments and lifecycle history. Phase 3 migration is `backend/migrations/005_phase3_telemetry_incidents.sql`. Telemetry and positions are purpose-limited and indexed for retention cleanup; production operations must define a retention job appropriate to the tenant policy.

Phase 4 complete: NSL dashboard, alarm/incident reports, shift handovers, direct messages, in-app notifications, configurable subscriptions, SMTP/SMS adapters, idempotent notification outbox with retry worker, and tenant-scoped audit events. Migration `backend/migrations/006_phase4_nsl_communications.sql`.

Phase 5 complete: management statistics and filtered CSV/PDF reports, TimeScan adapter and idempotent work-time sync, retention policies, audit export, data-subject export/anonymization, backup status, and tested backup/restore scripts. Migration `backend/migrations/007_phase5_reporting_timescan_security.sql`.

Known production follow-ups: add a dedicated migration runner for environments where init scripts are not appropriate; add session renewal/rotation, pagination, richer frontend validation, end-to-end browser tests, centralized secret management, encrypted off-site backups, shared worker leases, monitoring, and legal approval of retention periods.
