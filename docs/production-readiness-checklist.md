# Production readiness checklist

This checklist is an operational gate, not a certification statement. Mark an
item complete only with the evidence named in the row.

| Area | Evidence required | Repository status |
| --- | --- | --- |
| Database migrations | `npm run migrate` succeeds against the target database and migration checksums are recorded | Implemented; production Compose runs migrations only in the backend image |
| Health/readiness | Backend/frontend `/ready` (database) and `/ready/dms` (MinIO bucket + ClamAV ping) report ready, including after restart | Implemented; execute `npm run test:production-compose` |
| Tenant isolation | RLS integration tests plus negative API, WebSocket, report/export, DMS, offline and admin tests | Implemented in CI; run `POSTGRES_TEST_DATABASE_URL` integration tests for the target image |
| Authentication | Session, CSRF, origin allow-list, lockout and MFA tests are green | Implemented; configure production origins and keys |
| DMS uploads | Real ClamAV in the Compose stack; rejected, provider-error and integrity checks are exercised | Implemented in Compose, backend tests and E2E; signature updates require network access from the `clamav` service |
| Database + DMS backup | Successful run contains database, blob and manifest hashes on an encrypted local/SMB/CIFS/SFTP/S3 target | Implemented; configure target credentials and encryption key |
| Restore drill | CI or an isolated operator run reports database restore, tenant isolation, blob hashes/sizes, and corrupted/incomplete backup rejection | Implemented in `scripts/restore-drill.sh`; isolated PostgreSQL/MinIO resources are required |
| Worker resilience | `worker_leases` exists and restart takeover is observed; provider failures remain retryable and bounded | Implemented; verify lease takeover in the deployment topology |
| Load/stability | Isolated load test reports `PASS` for configured error, latency, throughput and WS fan-out thresholds | Harness implemented; isolated fixture and running backend are required |
| Supply chain | `npm ci`, high-severity audit, dependency review, secret scan, code scan and container scan are retained as CI evidence | `npm ci` and `npm audit` are CI-enforced; organization-approved secret/code/container scanners remain external prerequisites |
| TLS and secrets | TLS/reverse proxy, secret manager, rotation (see `docs/key-qr-rotation.md`), backups-at-rest and alerting are configured | External deployment prerequisite |
| Recovery operations | Restore promotion, rollback, incident contacts and retention/legal approvals are documented and rehearsed | External operational prerequisite |

Never use development credentials or production data in fixtures, restore
drills, load tests or browser E2E runs.
