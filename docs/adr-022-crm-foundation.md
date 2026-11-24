# ADR-022: Additive CRM foundation

- **Status:** Accepted
- **Date:** 2026-11-22
- **Decision:** Extend the existing tenant-scoped `customers` table and add
  canonical customer relationships, contacts, contracts, services, and
  contract join tables in migration `033_crm_foundation.sql`.

## Context

The platform already has tenant-scoped `customers` and `sites`, PostgreSQL RLS,
composite tenant foreign keys, audit services, and a migration runner. It does
not have customer contacts, customer-site ownership, contracts, services, or
contract history. A pre-existing customer/site relationship cannot be inferred
from the legacy schema.

## Decision details

- `customers` remains the canonical customer entity; no parallel customer table
  is introduced.
- `customer_sites` is the canonical many-to-many customer/site relationship.
- `customer_contacts` preserves the legacy single customer email as an idempotent
  primary contact row when present, without fabricating a contact name.
- `contracts` belongs to one customer. `contract_sites` can link a contract to
  only sites already associated with that customer.
- `services` is tenant-scoped and `contract_services` is the canonical
  contract/service relation.
- All new tables are `FORCE ROW LEVEL SECURITY` protected and use composite
  tenant-aware foreign keys.
- Internal CRM permissions are added for future API work. Customer portal
  identities and customer-facing authorization are explicitly not part of this
  migration.

## Implementation follow-through

Migration `042_customer_management.sql` and the customer API/UI build on this
model. They add structured business and billing addresses, contact-to-object
assignments, customer activity/task history, confidential customer-document
associations in the existing DMS, and tenant-scoped customer reporting over
already-linked sites. Customer and contract changes are audited; customer
documents use separate read/write permissions in addition to the DMS controls.

The existing object, employee assignment, schedule, incident, contract and
service tables remain canonical. No invoice or finance module, dedicated
complaints module, or general task module exists in this schema; invoice
records are therefore not duplicated, and follow-ups are limited to the
customer-specific task table. Customer-facing portal identities remain
explicitly deferred.

## Compatibility and rollout

The change is additive: existing customer/site columns and basic CRUD APIs
remain valid. No site is automatically assigned to a customer because that
would create unverifiable business data. Apply migrations through the existing
advisory-locked migration runner and validate the email backfill and
RLS/integrity tests in staging before production rollout.

## Consequences

The schema can support the customer lifecycle without duplicating existing
operational site data. Customer-scoped API and portal authorization are still
open work and must not be inferred from tenant-only permissions.
