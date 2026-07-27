# Unified calendar across STR + home exchange

## Summary

- establishes `availability_record` as the canonical property calendar attached
  to the existing booking core;
- ingests confirmed bookings, holds, tentative holds, cancellations, and owner
  blocks through a credential-scoped lifecycle webhook;
- prevents overlapping occupied ranges with an atomic first-writer-wins policy;
- propagates both blocks and releases to Airbnb, Booking.com, Vrbo, and
  HomeExchange with idempotent per-channel attempts;
- exposes chronological records, conflicts, sync freshness, last-success time,
  and actionable partial failures in the server-rendered calendar and JSON API;
- preserves the existing propagation endpoint and Prodeology companion hook.

## Schema and runtime

Migration `002_unified_calendar` is additive and reversible. Every canonical
record, event, sync operation, attempt, connection query, and HTTP read/write
retains explicit tenant and property scope.

Provider identity is `(tenant, property, source, external record id)`. Delivery
identity is the provider event id. A sync operation is keyed by scope, provider
record identity, operation (`block` or `release`), and normalized night set.

Overlap detection and canonical persistence run in one `BEGIN IMMEDIATE`
transaction. Checkout/check-in adjacency is non-overlapping. An overlapping
incoming booking or hold is retained as `conflict`, names the winning record,
and produces no channel write.

## Verification

- `npm run typecheck`
- `npm test`
- migration up → down → up and restart-persistence exercise
- real HTTP lifecycle webhook → four adapters → calendar UI/API
- duplicate delivery convergence
- overlap rejection and same-day adjacency
- cancellation release
- tenant/property read and write isolation
- partial failure with successful channels remaining fresh
- screenshot evidence for complete calendar, conflict, and stale/failure states
- unchanged `.claude/hooks/prodeology-companion.mjs`

## Operational continuation

The integrated runtime uses real HTTP and configured credentials against the
repository’s conformance service. Production closure still requires partner or
sandbox access, authoritative contracts, endpoints, and credentials for each
platform. No production `*_API_BASE_URL` is currently configured.

Prodeology-Spec: 0768df7c-7dfd-4957-bb05-536076816eaf
