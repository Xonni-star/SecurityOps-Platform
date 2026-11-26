# SecurityOps Platform

Tenant-isolated security operations platform covering phases 1-9: alarm operations, patrols, sensor/GPS telemetry, incident management, NSL communication, reporting, DMS, CRM/object management, maintenance workflows and the mobile offline PWA.

## Run locally

1. `cp .env.example .env`
2. `docker compose up -d db`
3. `npm install`
4. `npm run migrate`
5. `npm run dev -w backend` and `npm run dev -w frontend`

API: http://localhost:3000. UI: http://localhost:5173. PostgreSQL migrations are mounted into the database image for first startup. For a reset, `docker compose down -v` then start again.

Local seed login: `admin@example.com` / `password`. MFA is disabled only for this documented local seed account and its seed tenant.

For an explicitly configured local development account, set `DEV_SEED_ENABLED=true`, `DEV_SEED_EMAIL`, `DEV_SEED_PASSWORD` (at least 12 characters), and `DEV_SEED_TENANT_NAME` in an untracked `.env`, then run `npm run seed:dev -w backend`. No development credentials are stored in the repository, and production disables this bootstrap path.

Migration execution, checksum validation, baseline handling, and deployment upgrades are documented in [`docs/migrations.md`](docs/migrations.md).

Phase 2 API highlights: `POST /api/v1/alarms/panic`, `POST /api/v1/alarms/:id/acknowledge`, `POST /api/v1/alarms/:id/resolve`, `GET /api/v1/alarms/:id/history`, priority CRUD, escalation-rule CRUD, control-point/route CRUD, and `POST /api/v1/patrol-routes/:routeId/scans`. WebSocket clients authenticated with the session cookie receive `alarm.created`, `alarm.acknowledged`, `alarm.escalated`, and `alarm.resolved` events. The backend runs a documented 30-second escalation worker on `npm run start`; it checks enabled rules and escalates open alarms after the configured delay.

Phase 3 API highlights: authenticated `POST /api/v1/telemetry` for fall, posture, inactivity, and battery events; `POST /api/v1/positions` plus history and `GET /api/v1/map-data`; configurable sensor thresholds; and incident creation, assignment, lifecycle, and history endpoints. Sensor thresholds feed the existing Phase 2 alarm system: fall defaults to critical, inactivity defaults to high, and all values are configurable per tenant. WebSocket clients receive `sensor.updated`, `position.updated`, `incident.created`, `incident.assigned`, and `incident.status_changed`. Retention indexes are included for operational cleanup of telemetry and position data.

Phase 4 API highlights: `GET /api/v1/nsl/dashboard` consolidates open alarms, active incidents, latest positions, and patrol progress; alarm reports export as CSV/PDF; handovers, direct messages, in-app notifications, subscriptions, and audit events are tenant-scoped. Alarm and incident events are queued in an idempotent outbox and delivered asynchronously through SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `NOTIFICATION_FROM`) and an HTTP SMS adapter (`SMS_GATEWAY_URL`, optional `SMS_GATEWAY_TOKEN`). The notification worker retries failed deliveries up to five times and starts with the backend. See `docs/adr-004-phase-4-notifications-nsl.md`.

Phase 5 API highlights: filtered management statistics and employee/site/patrol/alarm/incident/work-time reports under `/api/v1/reports`; idempotent TimeScan synchronization under `/api/v1/timescan`; tenant audit query/export; retention policies; data-subject export/anonymization; and backup status. TimeScan credentials are referenced by an environment variable name in `secret_ref`, never stored as a credential. Use `scripts/backup-db.sh` and `scripts/restore-db.sh`; the complete procedure is in `docs/backup-and-restore.md` and the design in `docs/adr-005-phase-5-reporting-timescan-security.md`.
Provider acceptance status is available to authorized administrators at `/api/v1/admin/provider-status` and in the Admin page. Status is never `verified` when a provider is unconfigured; SMS requires the separate `SMS_GATEWAY_HEALTH_URL` for a non-mutating health check. See `docs/adr-018-phase-4-step-13b-provider-acceptance.md`.

The administration UI also exposes weekly backup weekday selection, external
alarm forwarding, customer evidence exports/read-only portal access, and
account-lockout administration. Forwarding and report routes remain tenant
scoped and audit every configuration/export action. `DIN-77200` is shown only
as a documentation profile, never as a certification or legal guarantee.

Backup targets are local, SMB/CIFS, SFTP, or S3-compatible only; unencrypted
FTP is deliberately unavailable. SFTP host-key fingerprints are mandatory.
Use `secret_ref` with deployment-managed JSON payloads for SFTP, S3, SMB,
SMTP, SMS, and forwarding credentials. See `docs/backup-runbook.md` for
formats, worker behavior, restore verification, and rollback.

Object management is centered on `/sites`. The overview combines real backend
metrics into `A – Sofort handeln`, `B – Zeitnah bearbeiten` and
`C – Objektinformationen`; the object file links into existing employee, DMS,
customer and watchbook sections with record-level focus and safe fallbacks for
inaccessible or deleted records. Maintenance-order creation accepts an optional
`Idempotency-Key` (UUID) so client retries return the stored response instead of
creating duplicate orders or audit events. Payload/key mismatches return `409`.

Customer management is centered on `/customers`. The cockpit derives its KPIs
and the `A – Sofort handeln`, `B – Zeitnah bearbeiten`, `C – Kundeninformationen`
buckets from tenant data. The customer list is filtered, sorted and paginated on
the server (`GET /api/v1/customers` with `q`, status, risk, priority, account
manager, contract status, `active`, `sort`, `dir`, `page`, `pageSize`); totals are
returned in `X-Total-Count`/`X-Page-Count`. `GET /customers/export` produces a CSV
of the same server-filtered selection with `customers:export`, and
`POST /customers/bulk` archives/status-changes/reassigns up to 100 selected
customers atomically. Customer files at `/customers/:id` expose only the sections
authorized by `visible_sections`: contacts, objects, contracts, customer
documents, tasks and history each have their own read permission, so
`customers:read` alone still opens the file with safe fallback messages. Contract
deadlines and reminders are derived from live contract terms without duplicate
rows; task priorities use `customer_tasks:read`/`customer_tasks:write`.
The object file's customer-link form searches the same server-side customer list
by name or number, so recently created customers remain linkable in large tenants.

Key management is centered on `/keys` and uses the existing `keys`, `key_movements`,
`key_bundles` and `key_bundle_movements` records; there is no second key store or
navigation entry. `GET /api/v1/keys` searches, filters, sorts and paginates on the
server (`q`, `status`, `key_type`, site/holder/bundle/location filters, `sort`, `dir`,
`page`, bounded `pageSize` 1–100, `X-Total-Count`/`X-Page-Count`). The cockpit's six
KPIs, expandable metrics and `A – Sofort handeln`, `B – Zeitnah bearbeiten`,
`C – Schlüsselinformationen` actions come from live key, holder, due-date and
movement data; every action deep-links to `/keys/:keyId` or its history section.
`GET /keys/:id` returns `visible_sections`, and the file at `/keys/:keyId/:section`
shows master data, object/standort linkage, holders, immutable history, loss
reports, inventory and a short-lived QR reference. Issue and return are guided by
employee/site pickers rather than UUID text fields, re-check availability with
`SELECT … FOR UPDATE`, can attach a tenant/site-matching DMS receipt, and store the
receipt, movement, audit and notification in one transaction. Loss reports support
risk assessment, immediate measures, status tracking and an optional existing or
new incident. Bundles support creation, membership, issue, partial/full return,
deactivation and immutable history. CSV export, history, QR, inventory and loss
processing are gated by dedicated `keys:*` permissions; the existing `keys:read`,
`keys:write`, `keys:issue`, `keys:return`, `keys:manage` and bundle scopes remain
valid. Migration 054 adds columns, tables, indexes, RLS policies and grants and
widens legacy CHECK constraints for the new values; existing key rows keep their
IDs and histories. Configure `KEY_QR_SECRET`, `KEY_REMINDER_DAYS` (a subset of `7,3,1,0`) and
`KEY_REMINDER_INTERVAL_MS`; overdue (`-1`) reminders are always queued once and
deduplicated by tenant, key, due date and day.

When the isolated E2E fixture is enabled, a viewer account
`e2e-viewer@example.invalid` with the same `E2E_PASSWORD` is created alongside
the operator account so read-only file access and denied mutations can be tested
without touching real users.

Phase 8 adds the installable `/mobile` PWA. Patrol scans and panic alarms are
written to an encrypted IndexedDB outbox when offline and sent with a stable
`client_event_id`; the server enforces tenant-scoped uniqueness so retries are
idempotent. Conflicts remain visible for manual review and are never presented
as server-confirmed. Push subscriptions use `/api/v1/push-subscriptions` and
require an operator-provided Web Push delivery service and public key.

Phase 3, step 10 adds `/dms` and the `/api/v1/dms/*` API. Document metadata and
immutable versions are tenant/RLS scoped. Uploads are size/content-type/hash
validated, stored through the MinIO/S3 adapter in quarantine, scanned through
the ClamAV adapter, and become downloadable only in `available` state. The API
never exposes provider URLs or object paths. Binary content is intentionally
not part of the generic offline sync protocol; only metadata/lifecycle actions
may be synchronized by a future explicit contract.

Configure `MINIO_*` and `CLAMAV_*` for providers. PostgreSQL/DB backups do not
back up blobs: configure and monitor the explicit `DMS_BLOB_BACKUP_PROVIDER`,
`DMS_BLOB_BACKUP_STATUS`, and `/api/v1/dms/backup/status` contract separately.

## Commands
`npm run typecheck`, `npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run format`. Backend tests use Jest/Supertest; frontend tests use Vitest and Testing Library. `npm run e2e` runs the real-browser Playwright suite; `npm run test:production-compose` validates the production Compose stack. PostgreSQL integration suites run when `POSTGRES_TEST_DATABASE_URL` points to a migrated disposable test database; CI applies the migrations and sets this variable. Current verification results are documented in [`docs/phase9-quality-report.md`](docs/phase9-quality-report.md).

Playwright E2E requires PostgreSQL 16 plus the backend and frontend dev servers:

```bash
docker compose up -d db
npm install
npx playwright install chromium
npm run test:e2e
```

`npm run test:e2e` starts the backend on port 3000 and Vite on port 5173 through
`playwright.config.ts`. The suite covers unauthenticated redirects, admin login
with both session/CSRF cookies, the four NSL dashboard areas, panic alarm
visibility, acknowledge/resolve lifecycle, report CSV/PDF responses, and the
mobile scan/panic/offline-outbox surface. Reset the database with
`docker compose down -v` when a clean seeded database is needed.

## Android debug APK

The mobile WebView is configured with Capacitor (`de.example.securityops`) and
uses the built PWA from `frontend/dist`:

```bash
npm run android:debug
```

The APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`. Install it with
`adb install -r android/app/build/outputs/apk/debug/app-debug.apk` and calculate
the delivery checksum with
`shasum -a 256 android/app/build/outputs/apk/debug/app-debug.apk`.

The native client also supports the existing server contracts directly:
Keystore-encrypted sessions, Room/WorkManager offline sync, native NFC reader
mode, the Android camera intent and an FCM token receiver. Build it with a
non-secret backend URL:

```bash
./gradlew assembleDebug -PsecurityopsApiBaseUrl=https://securityops.example/api/v1
```

FCM server registration/delivery, physical NFC/camera acceptance, background
execution and tablet layout still require environment-specific verification.

## Security
Opaque server-side sessions are issued in an httpOnly, same-site cookie; only a SHA-256 token hash is stored, sessions expire and can be revoked on logout, and the CSRF double-submit check is timing-safe. State-changing browser requests require an explicit configured Origin allowlist, and login has a dedicated rate limit. Rotate `SESSION_TTL_HOURS`, database credentials, and all provider secrets through the deployment secret manager; revoke active sessions during incident response by setting `sessions.revoked_at`. Never use development secrets in production.

## Production readiness

Before go-live, configure TLS/reverse proxy, production secrets, SMTP/SMS/TimeScan providers, scheduled encrypted off-site backups and restore drills, a shared worker lease for horizontally scaled workers, monitoring/alerting, and tenant-specific retention/legal-review settings. The production backend runs the migration runner before starting the API.

Production deployment uses a secret-managed environment file. For an interactive first-time setup, run:

```bash
./scripts/install-production.sh
```

The installer validates the HTTPS frontend origin, rejects localhost/loopback and wildcard CORS values, asks for ports and database settings, reads secrets without echo, generates a strong database password when omitted, writes `.env.production` with mode `0600`, starts the Compose stack, and verifies `/ready`. It never prints configured secrets.

For unattended or existing managed deployments, configure `.env.production` separately and run:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Set `CORS_ORIGIN` to the exact browser origin(s) that users will use, separated
by commas; production rejects missing values, localhost/loopback origins and
wildcards. For a Pi on a LAN without a public DNS name:

```dotenv
HTTP_PORT=8080
API_PORT=3000
CORS_ORIGIN=https://192.168.1.50
```

For DNS behind a reverse proxy, terminate TLS at the proxy and forward the
same host to the frontend port while keeping the API port bound to loopback:

```dotenv
HTTP_PORT=8080
API_PORT=3000
CORS_ORIGIN=https://securityops.example.com
```

The proxy must preserve `Host`, `Origin`, `X-Forwarded-For` and WebSocket
upgrade headers, and must provide a valid certificate for the configured DNS
name. The deployment host must provide Docker Compose, persistent storage for
`postgres-data`, an externally managed production secret file, DNS/LAN routing,
TLS certificates, and configured SMTP/SMS/TimeScan and backup targets.
Verify both `http://127.0.0.1:${API_PORT}/ready` and
`https://securityops.example.com/ready`; the latter is the frontend proxy's
database-backed readiness check, not a static HTTP 200.

Phase 7 operating procedures are documented in `docs/phase7-runbook.md`. The production
readiness endpoint is `/ready` and checks PostgreSQL; `/health` only confirms that the
HTTP process is alive. Use `scripts/restore-drill.sh` for an isolated restore validation
and complete [`docs/production-readiness-checklist.md`](docs/production-readiness-checklist.md)
and `docs/phase7-uat-checklist.md` before operational sign-off.
