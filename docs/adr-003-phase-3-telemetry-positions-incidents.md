# ADR 003: Phase 3 telemetry, positions, and incidents

## Decision

Mobile devices submit sensor events and GPS positions through the existing authenticated session and CSRF boundary. Every device is checked against the session tenant before persistence. Sensor thresholds are tenant-configurable in PostgreSQL; evaluation calls the existing Phase 2 `createAlarm` service so all sensor alarms use the same priorities, history, permissions, escalation, and WebSocket publication.

Positions are append-only operational history with latest-position projection performed by the map query. The frontend uses Leaflet with OpenStreetMap tiles and receives incremental updates through the existing WebSocket channel.

Incidents are separate operational records linked to alarms, objects, employees, priorities, assignments, and status history. Allowed transitions are `initiated -> en_route -> on_site -> completed`; invalid transitions are rejected.

## Data protection

Telemetry and position records are stored only for operational safety and response purposes, tenant-scoped, permission-guarded, and indexed for retention cleanup. A deployment must schedule deletion/archiving according to its documented retention policy; no unbounded retention is implied by the schema.

## Consequences

The design reuses Phase 1/2 authentication, RBAC, PostgreSQL, alarm creation, and WebSocket infrastructure. Horizontal scaling requires the existing realtime fan-out and worker deployment considerations to be handled at the platform layer.
