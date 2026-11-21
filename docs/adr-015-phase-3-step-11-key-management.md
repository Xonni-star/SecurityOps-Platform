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

Key bundles are additive tenant-scoped containers with explicit immutable
membership rows. A bundle return requires an explicit list of member key IDs;
the server locks the bundle and the selected keys in stable order, validates
membership, status, site scope, and holder authorization for every key before
performing any update. Each returned key receives its own `key_movements` and
`audit_events` row in the same transaction, so a failed partial return leaves
all keys unchanged.

## Privacy and operations

The database stores only UUID references for users/employees and keeps holder
history in immutable movement records. Key codes and labels are operational
metadata, not secrets; secret material must not be stored in PostgreSQL.

## Gap analysis and follow-up

This slice deliberately does not claim a complete key-management UI or
offline client workflow. The existing single-key screen remains single-key
only until bundle membership and per-key return selection are fully exposed.
Next phases should add a read API for bundle membership and a bound UI flow,
then add an authenticated offline queue with conflict handling and an
inventory/reconciliation workflow. Customer, object, building, document and
responsible-person relationships also remain explicit follow-up work; no
unconnected mock is treated as delivered functionality.
