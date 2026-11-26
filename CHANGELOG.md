# Changelog

## 1.1.0 - Object management finalization and quality tooling

- Added A/B/C priorities from real backend metrics, grouped object navigation and record-level focus/highlighting for sites, employees, DMS, customers and the watchbook, with safe fallbacks for inaccessible or deleted records.
- Added optional `Idempotency-Key` receipts for maintenance-order creation; retries return the stored response, and key/payload mismatches are rejected with `409`.
- Added a repository-wide ESLint script and CI step, fixed the findings, and split the frontend production bundle so the Vite chunk-size warning no longer occurs.
- Added real-browser Desktop/Tablet verification for A/B/C groups, long chronicle lists, loading/empty/error states and viewer permissions.
- Added PostgreSQL integration-suite execution against a migrated test database and fixed the RLS/CRM/watchbook teardown; the DB pool now allows idle exit so Jest workers stop cleanly.
- Fixed the restore-drill role setup for isolated verification databases.
- Updated the Phase 9 quality report to the current verification baseline.

## 1.0.0 - Phase 6 completion

- Added NFC OWKS inventory with lifecycle and tenant-safe assignment to employees, sites and control points.
- Added management reports, TimeScan synchronization, audit/privacy tools and backup procedures.
- Added NSL communication, notification delivery, live telemetry, GPS, incidents and patrol workflows from phases 1-5.
- Added production compose configuration, security audit, release documentation and smoke-load harness.
