# ADR-024: Kundenakte / 360°-Ansicht

- **Status:** Accepted
- **Date:** 2026-11-22
- **Decision:** Build the first productive CRM application step on the existing
  `customers`, `customer_contacts`, `customer_sites`, `contracts`,
  `contract_services`, `services`, and `audit_events` tables.

## Gap and prioritization

The CRM and object-management migrations already provide the canonical,
tenant-scoped data model, but the UI only exposed generic customer CRUD and
object context. The highest-value P0 gap was the missing customer-centered
read model: users could not inspect contacts, linked sites, contracts,
services, or customer history together.

P0 implemented here: a server-authorized customer 360 endpoint and a linked
customer-account view. P1 remains complaint/service-request workflows, and P2
remains pipeline, offers, and financial KPIs because their canonical source
tables do not yet exist.

## Security and compatibility

`GET /api/v1/customers/:id/360` derives the tenant from the authenticated
session, requires `customers:read` at tenant/system scope, and adds tenant
predicates to every relationship and audit query. It does not trust a client
tenant identifier or expose portal identities. Viewing an account is recorded
through the existing audit service. No migration or duplicate model is needed:
the endpoint is a read model over migrations 033 and 034 plus existing audit
events.
