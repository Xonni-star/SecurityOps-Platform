# ADR-017: Phase 4, step 13a — TOTP MFA

## Status

Accepted for the Phase 4 acceptance gate. WebAuthn is intentionally not implemented: the existing stack has no verified WebAuthn ceremony, credential storage, or browser/server integration to reuse safely.

## Decision

Admin and superadmin accounts require MFA by default. A tenant administrator with `mfa:policy:write` can set the required role list to any combination of `admin`, `operator` (Leitstelle), `viewer`, and `superadmin`; an enrolled account remains MFA-protected even if its role is later removed from that list.

Passwords first create an opaque, device-bound session with `mfa_pending=true` and a six-minute expiry whenever policy requires MFA. `requireAuth` cannot use that session. A successful TOTP challenge (RFC 6238, 30-second steps, one adjacent step accepted) or one unused recovery code promotes the same session and extends it to the configured session TTL. TOTP steps are monotonic per account to prevent replay; five failed attempts lock MFA for 15 minutes, in addition to endpoint and login rate limits.

Enrollment generates a random TOTP secret, encrypts it with AES-256-GCM using the deployment-only `MFA_ENCRYPTION_KEY`, and returns an `otpauth://` URI once. The URI and secret are never logged. Ten recovery codes are returned once and stored only as Argon2id hashes. A privileged reset (`mfa:reset`) revokes all target sessions and emits an audit event. Enrollment, policy changes, challenge completion, recovery use, reset, CSRF, and Origin checks are covered by the existing audit and middleware model.

## Operational prerequisite

Production must provide a strong, rotated `MFA_ENCRYPTION_KEY` outside the repository. PostgreSQL integration is not marked complete unless migrations and RLS/RBAC tests are run against a real PostgreSQL instance.
