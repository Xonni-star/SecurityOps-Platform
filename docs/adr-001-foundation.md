# ADR 001: Phase 1 foundation

- **Decision:** Use an npm-workspaces monorepo with Express/pg backend and React/Vite frontend.
- **Database:** PostgreSQL 16 with SQL migrations and tenant_id on every business table.
- **Authentication:** Argon2id password hashes with opaque, server-side sessions in httpOnly cookies. A session-bound double-submit CSRF token protects state-changing requests. Roles (admin, operator, viewer) map to granular permission records.
- **Consequences:** Simple deployable services and explicit SQL are easy to audit. A migration runner, session renewal/rotation, and audit log are deferred to later phases.
