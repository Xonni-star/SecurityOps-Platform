# SecurityOps Platform

Tenant-isolated security operations platform. Phases 1-5 provide alarm operations, patrols, sensor/GPS telemetry, incident management, NSL communication, reporting and operational protection.

## Run locally

1. `cp .env.example .env`
2. `docker compose up -d db`
3. `npm install`
4. `npm run migrate`
5. `npm run dev -w backend` and `npm run dev -w frontend`

API: http://localhost:3000. UI: http://localhost:5173. PostgreSQL migrations are mounted into the database image for first startup. For a reset, `docker compose down -v` then start again.

For an explicitly configured local development account, set `DEV_SEED_ENABLED=true`, `DEV_SEED_EMAIL`, `DEV_SEED_PASSWORD` (at least 12 characters), and `DEV_SEED_TENANT_NAME` in an untracked `.env`, then run `npm run seed:dev -w backend`. No development credentials are stored in the repository, and production disables this bootstrap path.

Migration execution, checksum validation, baseline handling, and deployment upgrades are documented in [`docs/migrations.md`](docs/migrations.md).

Phase 2 API highlights: `POST /api/v1/alarms/panic`, `POST /api/v1/alarms/:id/acknowledge`, `POST /api/v1/alarms/:id/resolve`, `GET /api/v1/alarms/:id/history`, priority CRUD, escalation-rule CRUD, control-point/route CRUD, and `POST /api/v1/patrol-routes/:routeId/scans`. WebSocket clients authenticated with the session cookie receive `alarm.created`, `alarm.acknowledged`, `alarm.escalated`, and `alarm.resolved` events. The backend runs a documented 30-second escalation worker on `npm run start`; it checks enabled rules and escalates open alarms after the configured delay.

Phase 3 API highlights: authenticated `POST /api/v1/telemetry` for fall, posture, inactivity, and battery events; `POST /api/v1/positions` plus history and `GET /api/v1/map-data`; configurable sensor thresholds; and incident creation, assignment, lifecycle, and history endpoints. Sensor thresholds feed the existing Phase 2 alarm system: fall defaults to critical, inactivity defaults to high, and all values are configurable per tenant. WebSocket clients receive `sensor.updated`, `position.updated`, `incident.created`, `incident.assigned`, and `incident.status_changed`. Retention indexes are included for operational cleanup of telemetry and position data.

Phase 4 API highlights: `GET /api/v1/nsl/dashboard` consolidates open alarms, active incidents, latest positions, and patrol progress; alarm reports export as CSV/PDF; handovers, direct messages, in-app notifications, subscriptions, and audit events are tenant-scoped. Alarm and incident events are queued in an idempotent outbox and delivered asynchronously through SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `NOTIFICATION_FROM`) and an HTTP SMS adapter (`SMS_GATEWAY_URL`, optional `SMS_GATEWAY_TOKEN`). The notification worker retries failed deliveries up to five times and starts with the backend. See `docs/adr-004-phase-4-notifications-nsl.md`.

Phase 5 API highlights: filtered management statistics and employee/site/patrol/alarm/incident/work-time reports under `/api/v1/reports`; idempotent TimeScan synchronization under `/api/v1/timescan`; tenant audit query/export; retention policies; data-subject export/anonymization; and backup status. TimeScan credentials are referenced by an environment variable name in `secret_ref`, never stored as a credential. Use `scripts/backup-db.sh` and `scripts/restore-db.sh`; the complete procedure is in `docs/backup-and-restore.md` and the design in `docs/adr-005-phase-5-reporting-timescan-security.md`.

Phase 8 adds the installable `/mobile` PWA. Patrol scans and panic alarms are
written to an encrypted IndexedDB outbox when offline and sent with a stable
`client_event_id`; the server enforces tenant-scoped uniqueness so retries are
idempotent. Conflicts remain visible for manual review and are never presented
as server-confirmed. Push subscriptions use `/api/v1/push-subscriptions` and
require an operator-provided Web Push delivery service and public key.

## Commands
`npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run format`. Backend tests use Jest/Supertest; frontend tests use Vitest and Testing Library.

## Security
Opaque server-side sessions are issued in an httpOnly, same-site cookie; only a SHA-256 token hash is stored, sessions expire and can be revoked on logout, and the CSRF double-submit check is timing-safe. State-changing browser requests require an explicit configured Origin allowlist, and login has a dedicated rate limit. Rotate `SESSION_TTL_HOURS`, database credentials, and all provider secrets through the deployment secret manager; revoke active sessions during incident response by setting `sessions.revoked_at`. Never use development secrets in production.

## Production readiness

Before go-live, configure TLS/reverse proxy, production secrets, SMTP/SMS/TimeScan providers, scheduled encrypted off-site backups and restore drills, a shared worker lease for horizontally scaled workers, monitoring/alerting, and tenant-specific retention/legal-review settings. The production backend runs the migration runner before starting the API.

Production deployment uses a secret-managed environment file:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Phase 7 operating procedures are documented in `docs/phase7-runbook.md`. The production
readiness endpoint is `/ready` and checks PostgreSQL; `/health` only confirms that the
HTTP process is alive. Use `scripts/restore-drill.sh` for an isolated restore validation
and complete `docs/phase7-uat-checklist.md` before operational sign-off.
