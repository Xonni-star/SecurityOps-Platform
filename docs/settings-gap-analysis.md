# Settings gap analysis and delivered block

## Current state

The Settings area is concentrated in `/admin`. It already has real backend connections for tenant backup scheduling and retention, backup targets and notifications, SMTP/SMS/TimeScan provider settings, audit export, account lockout, MFA, and authenticated-device revocation. These paths use the existing permission checks, CSRF protection, tenant context, encrypted provider secrets, and audit service.

The main security gap was the lack of an administrative view of individual authenticated sessions. Administrators could revoke a device, which revoked all sessions for that device, but could not inspect session ownership/activity or invalidate one compromised session without removing the whole device.

## Delivered block

Migration `035_authenticated_session_management.sql` adds tenant-scoped `authenticated_sessions:read` and `authenticated_sessions:write` permissions, RLS policies for administrator reads/updates, and an activity index. The backend exposes `GET /auth/sessions` and `POST /auth/sessions/:id/revoke`; session tokens are never selected or returned. Revocation is transactional and creates an immutable audit event.

The Admin Settings page now shows the account, role, device, platform, creation time, expiry state, and revocation action for each session. Revocation requires explicit confirmation. Existing device-wide revocation remains available for incident response.

## Deliberately open

- Tenant/company profile, branding, locale, and organizational master data are not yet centralized in Settings; the CRM/object-management foundations currently own those records.
- Configurable workflow/status catalogs, document/checklist templates, and general notification policies need domain-specific schemas and consumers before they can be exposed safely.
- Session listing currently reports authenticated sessions only; historical login-event analytics and IP/geolocation enrichment remain out of scope for this block.

## CRM PR #34 integration

CRM PR #34 (`xonni-star-crm-kundenakte-vollstaendig`) adds the Customer 360 route/page and customer-account API on top of the same base branch. It does not overlap the session-management files changed here, so no direct merge conflict is expected. Conceptually, future tenant/company and customer-default settings should consume the CRM account model rather than duplicate customer status, contacts, or contract configuration in `/admin`; this block intentionally leaves that integration unchanged.
