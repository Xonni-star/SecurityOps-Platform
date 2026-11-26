# Changelog

## 1.3.0 - Enterprise key management cockpit

- Extended the existing `/keys` module into a server-side cockpit with six real KPIs, expandable secondary metrics and A/B/C actions that deep-link to the concrete key file.
- Added a bounded, tenant-scoped key list with combinable filters, sorting, pagination headers, selection, permission-gated CSV export and status badges.
- Added digital key files with permission-filtered sections, object/site linkage, holders and complete immutable movement history.
- Added guided issue/return flows with employee and site pickers, receipt documents, atomic availability re-checks, return conditions and consistent status resets.
- Added configurable, idempotent return reminders through the existing notification infrastructure and a loss workflow with risk, immediate measures, status and optional incident linkage.
- Added key bundles with membership, issue, partial/full return, deactivation, history, object linkage, safe QR references and inventory checks.
- Added migration 054 with columns, tables, indexes, RLS policies, `keys:*` role grants and widened CHECK constraints; existing keys, bundles and history rows are unchanged.
- Extended backend, frontend, PostgreSQL integration and real-browser E2E coverage, including a restricted viewer account.

## 1.2.0 - Enterprise customer cockpit

- Added a server-side customer list with combinable search/filter/sort/pagination, bounded page sizes and total-count headers.
- Added real KPIs plus A/B/C action buckets derived from risks, contract deadlines, overdue tasks, incidents and master-data gaps.
- Added permission-checked CSV export, atomic bulk archive/status/manager actions and audited reminders from live contract terms.
- Split the customer file into permission-filtered sections with `visible_sections`, dedicated `customer_tasks:*` scopes and safe read-only fallbacks.
- Added task priorities, unique primary-contact handling, object/contract/document linkage improvements and CRM indexes in a non-destructive migration.
- Extended backend, frontend, PostgreSQL integration and real-browser E2E coverage including a restricted viewer account.
- Kept object-file customer linking usable with the paginated customer list by adding a server-side customer search.

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
