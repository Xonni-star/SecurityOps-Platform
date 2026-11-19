# ADR 001: Phase 1 foundation

- **Decision:** Use an npm-workspaces monorepo with Express/pg backend and React/Vite frontend.
- **Database:** PostgreSQL 16 with SQL migrations and tenant_id on every business table.
- **Authentication:** Stateless JWT access tokens with bcrypt password hashes; roles are admin, operator, viewer.
- **Consequences:** Simple deployable services and explicit SQL are easy to audit. A migration runner and refresh-token rotation are deferred to later phases.
