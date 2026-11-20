# ADR-018: Phase 4, step 13b — provider acceptance

## Status

Implemented. SMTP, SMS and TimeScan now expose explicit `not_configured`, `configured`, `verified` or `failed` states through the permission-protected `GET /api/v1/admin/provider-status` endpoint. The Admin page displays these states without exposing credentials.

## Decision

SMTP verification uses Nodemailer's non-delivery `verify()` operation. SMS verification is only attempted when both `SMS_GATEWAY_URL` and an explicitly supplied `SMS_GATEWAY_HEALTH_URL` exist; otherwise the provider remains `configured` and is not reported as verified. TimeScan verification uses an authenticated `HEAD /health` request and only runs when the tenant connection is enabled and its referenced environment secret exists. Verification errors use fixed messages and never include secrets.

## Evidence and open prerequisites

The acceptance evidence in this change is limited to the automated adapter contract/mock tests and the protected admin endpoint test. No production SMTP, SMS or TimeScan credentials/endpoints were present in the execution environment, so no real provider was verified and no test data is a production acceptance proof.

Before production acceptance, provide approved non-production or production endpoints and credentials through the deployment secret manager, run the admin status check for each provider, record the returned `verified` state and timestamp, and retain the provider-side audit evidence. Configure `SMS_GATEWAY_HEALTH_URL`; a configured SMS send URL alone is intentionally insufficient for verification.
