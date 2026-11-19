# SecurityOps Platform

Tenant-isolated security operations platform. Phase 3 adds live telemetry, GPS positions, sensor-driven alarms, live mapping, and incident management on top of the Phase 1/2 foundation.

## Run locally

1. `cp .env.example .env`
2. `docker compose up -d db`
3. `npm install`
4. `npm run dev -w backend` and `npm run dev -w frontend`

API: http://localhost:3000 (seed login `admin@example.com` / `password`; change immediately). UI: http://localhost:5173. PostgreSQL migrations are mounted into the database image for first startup. For a reset, `docker compose down -v` then start again.

Phase 2 API highlights: `POST /api/v1/alarms/panic`, `POST /api/v1/alarms/:id/acknowledge`, `POST /api/v1/alarms/:id/resolve`, `GET /api/v1/alarms/:id/history`, priority CRUD, escalation-rule CRUD, control-point/route CRUD, and `POST /api/v1/patrol-routes/:routeId/scans`. WebSocket clients authenticated with the session cookie receive `alarm.created`, `alarm.acknowledged`, `alarm.escalated`, and `alarm.resolved` events. The backend runs a documented 30-second escalation worker on `npm run start`; it checks enabled rules and escalates open alarms after the configured delay.

Phase 3 API highlights: authenticated `POST /api/v1/telemetry` for fall, posture, inactivity, and battery events; `POST /api/v1/positions` plus history and `GET /api/v1/map-data`; configurable sensor thresholds; and incident creation, assignment, lifecycle, and history endpoints. Sensor thresholds feed the existing Phase 2 alarm system: fall defaults to critical, inactivity defaults to high, and all values are configurable per tenant. WebSocket clients receive `sensor.updated`, `position.updated`, `incident.created`, `incident.assigned`, and `incident.status_changed`. Retention indexes are included for operational cleanup of telemetry and position data.

## Commands
`npm run typecheck`, `npm test`, `npm run build`, `npm run format`. Backend tests use Jest/Supertest; frontend tests use Vitest and Testing Library.

## Security
Opaque server-side sessions are issued in an httpOnly cookie, with Argon2id password hashes and a session-bound double-submit CSRF token for state-changing requests. Granular permissions are loaded from PostgreSQL role mappings; tenant-scoped SQL predicates, Helmet, CORS allow-list, rate limiting, structured logging, and a WebSocket heartbeat authenticated by the session cookie are included. Alarm history stores purpose-specific state transitions, and patrol scans retain only operational evidence needed for deviation detection. Never use development secrets in production.
