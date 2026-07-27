# housemanagement

One tenant- and property-scoped calendar for Airbnb, Booking.com, Vrbo,
HomeExchange, holds, cancellations, and owner-blocked dates. Incoming lifecycle
events are normalized exactly once, checked for overlaps, and propagated to
every connected channel with an independent, truthful sync result.

Built for Prodeology spec `0768df7c-7dfd-4957-bb05-536076816eaf` v20.

## Quick start

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed
```

Then, in two terminals:

```bash
npm run conformance
```

```bash
npm run start
```

Open http://127.0.0.1:4500 and sign in with `dev-acme-key`. The seed includes
one chronological record from each v1 channel.

Send a canonical calendar event:

```bash
curl -X POST http://127.0.0.1:4500/webhooks/calendar -H 'x-api-key: dev-acme-key' -H 'content-type: application/json' -d '{"eventId":"evt-1","tenantId":"tenant-acme","propertyId":"prop-harbour","source":"airbnb","externalRecordId":"HM1","state":"confirmed","checkIn":"2026-09-10","checkOut":"2026-09-13"}'
```

Supported states are `confirmed`, `hold`, `tentative`, `cancelled`, and
`owner_block`. Owner blocks use `"source":"owner"`. The legacy
`/webhooks/bookings` propagation endpoint remains available for compatibility.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | full suite (161 tests) |
| `npm run migrate` / `migrate:down` | apply / roll back migrations |
| `npm run seed` | reset and seed development data |
| `npm run conformance` | channel conformance server |
| `npm start` | webhook + status UI |

## How it works

```
provider or owner event
  → POST /webhooks/calendar          tenant resolved from credential
  → calendar-ingest.ts               validate + dedupe provider delivery
                                     → BEGIN IMMEDIATE
                                     → scope + overlap check + canonical write
                                     → COMMIT
  → calendar-sync.ts                 block or release → idempotency key
  → per channel, independently:
      nights reshaped per channel policy → adapter → platform HTTP
      outcome recorded as succeeded | delayed | failed | rejected
  → GET /calendar/:propertyId        chronological calendar + sync state
  → GET /api/calendar/:propertyId    tenant-scoped JSON read model
```

### Design decisions worth knowing

**Nights model.** A stay blocks each night from the check-in date through the
night before checkout. The checkout date stays bookable so a same-day arrival
can take it. This is expressed per channel as `checkoutNightPolicy` in
[src/config/channels.ts](src/config/channels.ts) — see *Approved assumptions*
below.

**Calendar dates, never instants.** Availability is a calendar-date concept on
every target platform, so dates are never converted to timestamps. A property in
`Pacific/Auckland` and one in `America/Los_Angeles` derive identical nights from
identical check-in/check-out pairs.

**Idempotency and identity.** Canonical records are unique on `(tenant,
property, source, external record id)`. Provider deliveries are keyed by event
id, and block/release operations are keyed by scope, record identity, operation,
and night set. Successful channel attempts are not resubmitted on replay.

**Conflict policy.** The first active occupied interval wins. Overlap detection
and persistence share an immediate database transaction; a later overlapping
booking or hold is retained in `conflict` state for action but is never silently
accepted or propagated. Checkout/check-in adjacency remains valid.

**Lifecycle correction.** Holds and owner blocks occupy dates. Cancellation
marks the canonical record cancelled and propagates release of its prior nights.
A moved active record releases its previous range before blocking the new one.

**Tenant scoping.** Every query carries a `tenantId` predicate. Primary-key
lookups additionally verify ownership and raise `CrossTenantError`. No HTTP
route accepts a tenant id as input — it is resolved from a credential, and the
webhook rejects an event whose `tenantId` disagrees with the authenticated one.

**Honest aggregates.** `complete` requires every attempt to have succeeded. One
delayed, failed or rejected channel caps the result at `partial`; no successes at
all makes it `failed`. Channels that are not connected are named as outside the
attempted propagation rather than counted either way.

**No money.** Booking amounts and revenue are deliberately absent from this
model, which the spec permits, avoiding currency and refund/reversal handling in
a workflow that has no need for it.

## Layout

```
src/
  config/channels.ts       per-platform date policy, booking-type mapping, endpoints
  domain/                  dates, types, propagation rules, sync-window evaluation
  db/                      reversible schema + tenant/property-scoped repositories
  channels/                adapter contract, HTTP transport, one adapter per platform
  worker/                  canonical ingestion, overlap policy, sync workers, read models
  http/                    lifecycle webhooks + calendar UI/API + credential identity
  ui/design-system.css     the workspace design-system token and component vocabulary
  conformance/             channel contract server (see below)
test/                      161 tests, including real-HTTP end-to-end coverage
```

## The conformance server

Live availability-write access for Airbnb, Booking.com and Vrbo is gated behind
partner-programme approval that this repository cannot create. `npm run
conformance` starts a server that speaks each platform's request/response
contract as modelled here — per-night JSON for Airbnb, inclusive ranges for Vrbo,
XML for Booking.com, a flat date list for HomeExchange — including credential
checks, rejections, rate limiting and timeouts.

It is not an in-process mock. It is a separate process reached over real HTTP
with real credentials; only the remote hostname is substituted. Scenarios are
selected by a suffix on the listing id (`-timeout`, `-ratelimit`, `-reject`,
`-partial`, `-conflict`, `-unsupported`), so failure paths are set up purely
through connection data.

## Going live on a channel

Set that channel's `*_API_BASE_URL` and its token. Nothing else changes. Before
you do, three things are required per platform — see the checkpoint in
[.env.example](.env.example):

1. partner / connectivity-programme approval for the account,
2. a production or sandbox credential,
3. the published API contract, to confirm the two approved assumptions below.

## Approved implementation decisions

The repository owner approved this runtime and its existing booking table as the
Unified Booking Core attachment, HomeExchange as the v1 exchange channel, and
the first-active-interval-wins conflict policy. Canonical state is retained
during partial failures, retryable outcomes may be retried, and rejected/stale
outcomes require visible reconciliation.

Two channel-contract fields remain assumptions pending validation against each
platform's authoritative contract:

- **`checkoutNightPolicy: 'checkout_available'`** on all four channels — the
  nights model described above.
- **`confirmedBookingType`** — what each platform is expected to accept a
  confirmed host-side unavailability block as (`unavailable`, `closed`,
  `RESERVED`, `blocked`).

The specific home-exchange platform was also not named, so it is registered under
a neutral `homeexchange` key; swapping it means changing one adapter and one
registry entry.

## Out of scope

Multi-property portfolio management, analytics, guest details, unified inbox,
cleaning buffers, property content, monetization, and channel onboarding flows.

Prodeology-Spec: 0768df7c-7dfd-4957-bb05-536076816eaf
