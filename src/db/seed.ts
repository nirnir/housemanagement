/**
 * Development seed.
 *
 * Creates two tenants so tenant isolation is observable, and two properties for
 * the first tenant: one whose channels all accept, and one wired to a delayed
 * and a rejecting channel so the partial-result path is reachable without
 * editing code. The failure behaviour lives in the listing ids, which is how the
 * conformance server selects it.
 */

import { migrateUp, openDatabase } from './index.ts';
import * as calendarRepo from './calendar-repo.ts';
import * as repo from './repo.ts';

const db = openDatabase();
migrateUp(db);

function reset(): void {
  for (const table of [
    'availability_sync_attempt',
    'availability_sync',
    'calendar_event',
    'availability_record',
    'ingest_event',
    'propagation_attempt',
    'propagation',
    'booking',
    'channel_connection',
    'property',
    'tenant',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

reset();

const acme = repo.createTenant(db, 'Acme Hosting', 'tenant-acme');
const other = repo.createTenant(db, 'Unrelated Host', 'tenant-other');

/* Property 1 — every channel accepts. */
const harbour = repo.createProperty(db, {
  id: 'prop-harbour',
  tenantId: acme.id,
  name: 'Harbour Cottage',
  timezone: 'Europe/Amsterdam',
});
repo.createConnection(db, { tenantId: acme.id, propertyId: harbour.id, channel: 'airbnb', externalListingId: 'abnb-harbour-1' });
repo.createConnection(db, { tenantId: acme.id, propertyId: harbour.id, channel: 'booking_com', externalListingId: 'bcom-harbour-1' });
repo.createConnection(db, { tenantId: acme.id, propertyId: harbour.id, channel: 'vrbo', externalListingId: 'vrbo-harbour-1' });
repo.createConnection(db, { tenantId: acme.id, propertyId: harbour.id, channel: 'homeexchange', externalListingId: 'hex-harbour-1' });

/* Canonical sample calendar — one record from every v1 channel. */
for (const [source, externalRecordId, checkIn, checkOut] of [
  ['airbnb', 'airbnb-sample-1', '2026-08-03', '2026-08-06'],
  ['booking_com', 'booking-sample-1', '2026-08-08', '2026-08-11'],
  ['vrbo', 'vrbo-sample-1', '2026-08-13', '2026-08-15'],
  ['homeexchange', 'exchange-sample-1', '2026-08-18', '2026-08-22'],
] as const) {
  const booking = repo.upsertBooking(db, {
    tenantId: acme.id,
    propertyId: harbour.id,
    sourceChannel: source,
    externalBookingId: externalRecordId,
    state: source === 'homeexchange' ? 'hold' : 'confirmed',
    checkIn,
    checkOut,
  });
  calendarRepo.upsertAvailabilityRecord(db, {
    tenantId: acme.id,
    propertyId: harbour.id,
    bookingId: booking.id,
    source,
    externalRecordId,
    recordKind: source === 'homeexchange' ? 'hold' : 'booking',
    lifecycleState: 'active',
    checkIn,
    checkOut,
    providerEventId: `seed-${externalRecordId}`,
  });
}

/* Property 2 — Vrbo times out, HomeExchange rejects: the partial path. */
const garden = repo.createProperty(db, {
  id: 'prop-garden',
  tenantId: acme.id,
  name: 'Garden Studio',
  timezone: 'Europe/Amsterdam',
});
repo.createConnection(db, { tenantId: acme.id, propertyId: garden.id, channel: 'airbnb', externalListingId: 'abnb-garden-2' });
repo.createConnection(db, { tenantId: acme.id, propertyId: garden.id, channel: 'vrbo', externalListingId: 'vrbo-garden-2-timeout' });
repo.createConnection(db, { tenantId: acme.id, propertyId: garden.id, channel: 'homeexchange', externalListingId: 'hex-garden-2-reject' });
// Booking.com is intentionally NOT connected here — the "unconnected channel" case.

/* A property belonging to a different tenant, for isolation checks. */
const villa = repo.createProperty(db, {
  id: 'prop-villa',
  tenantId: other.id,
  name: 'Unrelated Villa',
  timezone: 'America/Los_Angeles',
});
repo.createConnection(db, { tenantId: other.id, propertyId: villa.id, channel: 'airbnb', externalListingId: 'abnb-villa-9' });

console.log('Seeded:');
console.log(`  tenant ${acme.id}   properties: ${harbour.id} (all accept), ${garden.id} (partial)`);
console.log(`  tenant ${other.id}  property:   ${villa.id}`);
db.close();
