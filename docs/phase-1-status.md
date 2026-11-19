# Phase 1 status

Implemented: runnable PostgreSQL-backed API, migrations and seed, Argon2id authentication with opaque server-side httpOnly sessions, login/logout, session-bound CSRF protection, granular PostgreSQL permissions, tenant-isolated CRUD for employees/customers/sites/devices/alarms, updated_at timestamps and indexes, OpenAPI endpoint, session-authenticated WebSocket heartbeat, security middleware, frontend login/logout/protected navigation/basic CRUD, tests, Docker Compose, CI, and documentation.

Phase 2 complete: configurable tenant-scoped alarm priorities, expanded alarm model and lifecycle history, panic alarms, authenticated tenant-filtered WebSocket alarm events, configurable escalation rules with a 30-second worker, NFC control points and patrol routes, scan deviation alarms, and Leitstelle/patrol UI views. Phase 2 migrations are in `backend/migrations/004_phase2_alarm_patrol.sql`; deployment starts the escalation worker with the backend process.

Known follow-ups: add a dedicated migration runner for environments where init scripts are not appropriate; add session renewal/rotation, pagination/filtering, richer frontend validation, and end-to-end browser tests.
