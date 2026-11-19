# Phase 1 status

Implemented: runnable PostgreSQL-backed API, migrations and seed, Argon2id authentication with opaque server-side httpOnly sessions, login/logout, session-bound CSRF protection, granular PostgreSQL permissions, tenant-isolated CRUD for employees/customers/sites/devices/alarms, updated_at timestamps and indexes, OpenAPI endpoint, session-authenticated WebSocket heartbeat, security middleware, frontend login/logout/protected navigation/basic CRUD, tests, Docker Compose, CI, and documentation.

Known follow-ups: add a dedicated migration runner for environments where init scripts are not appropriate; add session renewal/rotation, audit log, pagination/filtering, richer frontend validation, and end-to-end browser tests.
