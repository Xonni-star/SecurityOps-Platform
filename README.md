# SecurityOps Platform

Phase 1 production-oriented monorepo for tenant-isolated security operations.

## Run locally

1. `cp .env.example .env`
2. `docker compose up -d db`
3. `npm install`
4. `npm run dev -w backend` and `npm run dev -w frontend`

API: http://localhost:3000 (seed login `admin@example.com` / `password`; change immediately). UI: http://localhost:5173. PostgreSQL migrations are mounted into the database image for first startup. For a reset, `docker compose down -v` then start again.

## Commands
`npm run typecheck`, `npm test`, `npm run build`, `npm run format`. Backend tests use Jest/Supertest; frontend tests use Vitest and Testing Library.

## Security
Opaque server-side sessions are issued in an httpOnly cookie, with Argon2id password hashes and a session-bound double-submit CSRF token for state-changing requests. Granular permissions are loaded from PostgreSQL role mappings; tenant-scoped SQL predicates, Helmet, CORS allow-list, rate limiting, structured logging, and a WebSocket heartbeat authenticated by the session cookie are included. Never use development secrets in production.
