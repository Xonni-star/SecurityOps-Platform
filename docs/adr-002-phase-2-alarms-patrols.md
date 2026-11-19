# ADR 002: Phase 2 alarms and patrols

## Decision

Extend the existing `alarms` table in place and add tenant-scoped priorities, history, escalation rules, control points, routes, assignments, and scans. Lifecycle writes create an `alarm_history` row and publish a WebSocket event only after the database operation succeeds.

Automatic escalation uses an in-process 30-second interval started by `backend/src/server.ts`. It is intentionally bounded and deployment-visible: production deployments must run the API as a continuously running service, and multiple replicas should use a single worker or a database advisory-lock wrapper before enabling horizontal scaling.

Patrol deviation detection is deterministic: an NFC UID must belong to the route, and a scan whose sequence is not greater than the employee's last scan is marked `out_of_order` and creates a medium-priority alarm. The schema keeps only fields needed for operational verification.

## Consequences

The implementation reuses Phase 1 sessions, RBAC, tenant predicates, PostgreSQL, and WebSocket authentication. Existing alarm records are migrated in place, with their severity mapped to seeded priorities and their message copied to `description`.
