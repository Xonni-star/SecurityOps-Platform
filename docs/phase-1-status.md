# Phase 1 status

Implemented: runnable PostgreSQL-backed API, migrations and seed, Argon2id authentication with opaque server-side httpOnly sessions, login/logout, session-bound CSRF protection, granular PostgreSQL permissions, tenant-isolated CRUD for employees/customers/sites/devices/alarms, updated_at timestamps and indexes, OpenAPI endpoint, session-authenticated WebSocket heartbeat, security middleware, frontend login/logout/protected navigation/basic CRUD, tests, Docker Compose, CI, and documentation.

Phase 2 complete: configurable tenant-scoped alarm priorities, expanded alarm model and lifecycle history, panic alarms, authenticated tenant-filtered WebSocket alarm events, configurable escalation rules with a 30-second worker, NFC control points and patrol routes, scan deviation alarms, and Leitstelle/patrol UI views. Phase 2 migrations are in `backend/migrations/004_phase2_alarm_patrol.sql`; deployment starts the escalation worker with the backend process.

Phase 3 complete: tenant-scoped sensor thresholds/events, authenticated telemetry ingest, fall/posture/inactivity/battery alarm evaluation through the Phase 2 alarm service, GPS position history and realtime pushes, Leaflet/OpenStreetMap live map, and incident management with assignments and lifecycle history. Phase 3 migration is `backend/migrations/005_phase3_telemetry_incidents.sql`. Telemetry and positions are purpose-limited and indexed for retention cleanup; production operations must define a retention job appropriate to the tenant policy.

Known follow-ups: add a dedicated migration runner for environments where init scripts are not appropriate; add session renewal/rotation, pagination/filtering, richer frontend validation, and end-to-end browser tests.
