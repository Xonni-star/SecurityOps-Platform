# ADR-015: Phase 3, step 11 key management

## Decision

Keys are additive, tenant-scoped entities with an optional canonical `site_id`.
The persisted status machine is `available -> issued -> available`, with
`issued -> lost` and `available|issued|lost -> deactivated`; `deactivated` is
terminal. A key can reference exactly one minimized holder identity:
`holder_user_id` or `holder_employee_id`. Names, emails and other duplicated
personal data are not copied into key tables.

Every issue, return, loss and deactivation is a transaction that locks the
current key, validates the requested transition and appends an immutable
`key_movements` row plus a canonical `audit_events` entry. Replays use the
existing tenant-scoped `sync_receipts` contract with actions `keys.*`; a
different payload or action for the same mutation ID is rejected.

Reads and writes require the corresponding canonical `keys:*` permission and
site grants where applicable. Returns are allowed to the current user holder
or an operator/admin; employee-held keys require an operator/admin return.
Revoked authenticated devices cannot reach these operations because the
existing session/device binding rejects their session before routing.

## Privacy and operations

The database stores only UUID references for users/employees and keeps holder
history in immutable movement records. Key codes and labels are operational
metadata, not secrets; secret material must not be stored in PostgreSQL.
