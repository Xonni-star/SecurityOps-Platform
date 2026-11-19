# ADR-004: NSL and notification delivery

## Context

Phase 4 needs a consolidated NSL view and reliable email/SMS/in-app delivery without coupling the API to external providers.

## Decision

NSL reads tenant-scoped alarms, active incidents, latest device positions and patrol progress through one dashboard endpoint. Alarm and incident events are written to the existing realtime channel and to an in-app notification table. Email and SMS deliveries are persisted in an idempotent outbox keyed by event, channel and recipient. A bounded in-process worker retries failed deliveries with exponential backoff; SMTP uses Nodemailer and SMS uses a configured HTTP gateway adapter.

Direct messages, shift handovers and generic audit events are stored with tenant and actor references. Notification subscriptions are explicit by user or role and channel; no recipient data beyond the configured address is copied into event payloads.

## Consequences

- Provider outages do not block alarm creation; delivery retries asynchronously.
- Multiple API calls for the same event cannot create duplicate provider deliveries.
- Horizontal deployments should run one notification worker or add a shared leasing mechanism.
- Deployment must configure `SMTP_HOST` and/or `SMS_GATEWAY_URL` for external delivery.
