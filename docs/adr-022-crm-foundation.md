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

## Compatibility and rollout

The change is additive: existing customer/site columns and APIs remain valid.
No site is automatically assigned to a customer because that would create
unverifiable business data. Apply the migration through the existing advisory
locked migration runner, validate the email backfill and RLS/integrity tests in
staging, then deploy API changes in a later dependent step.

## Consequences

The schema can support the customer lifecycle without duplicating existing
operational site data. Customer-scoped API and portal authorization are still
open work and must not be inferred from tenant-only permissions.
