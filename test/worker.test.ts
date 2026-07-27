/**
 * The propagation worker: fan-out, per-channel independence, idempotent replay,
 * tenant/property scoping, and the connection-set edge cases.
 *
 * These use stub adapters so the worker's own logic is isolated. The real
 * over-HTTP path is covered in channels.test.ts and http.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as repo from '../src/db/repo.ts';
import { CrossTenantError } from '../src/db/repo.ts';
import { propagateBooking } from '../src/worker/propagate.ts';
import { ingestBookingEvent } from '../src/worker/ingest.ts';
import { buildPropagationView } from '../src/worker/view.ts';
import type { BookingState } from '../src/domain/types.ts';
import { addTenant, seedFixture, stubAdapter } from './helpers.ts';

const ALL_FOUR = [
  { channel: 'airbnb' as const, listingId: 'abnb-1' },
  { channel: 'booking_com' as const, listingId: 'bcom-1' },
  { channel: 'vrbo' as const, listingId: 'vrbo-1' },
  { channel: 'homeexchange' as const, listingId: 'hex-1' },
];

const STAY = { checkIn: '2026-06-10', checkOut: '2026-06-13' };
const NIGHTS = ['2026-06-10', '2026-06-11', '2026-06-12'];

function addBooking(
  fixture: ReturnType<typeof seedFixture>,
  overrides: { state?: BookingState; externalBookingId?: string } = {},
) {
  return repo.upsertBooking(fixture.db, {
    tenantId: fixture.tenantId,
    propertyId: fixture.propertyId,
    sourceChannel: 'airbnb',
    externalBookingId: overrides.externalBookingId ?? 'HMABC123',
    state: overrides.state ?? 'confirmed',
    ...STAY,
  });
}

const OPTS = { retryDelayMs: 0 };

describe('fan-out to every connected channel', () => {
  it('attempts all four channels with the mapped nights', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    const booking = addBooking(fixture);
    const adapters = {
      airbnb: stubAdapter('airbnb', { status: 'succeeded' }),
      booking_com: stubAdapter('booking_com', { status: 'succeeded' }),
      vrbo: stubAdapter('vrbo', { status: 'succeeded' }),
      homeexchange: stubAdapter('homeexchange', { status: 'succeeded' }),
    };

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters,
    });

    assert.equal(result.kind, 'processed');
    assert.equal(result.aggregateStatus, 'complete');
    assert.equal(result.attempts.length, 4);
    for (const attempt of result.attempts) {
      assert.equal(attempt.status, 'succeeded', `${attempt.channel} should have succeeded`);
      assert.deepEqual(attempt.submittedNights, NIGHTS);
    }
    for (const adapter of Object.values(adapters)) {
      assert.equal(adapter.calls.length, 1);
      assert.deepEqual(adapter.calls[0]?.nights, NIGHTS);
    }
  });

  it('sends each channel its own mapped booking type', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    const booking = addBooking(fixture);
    const adapters = {
      airbnb: stubAdapter('airbnb', { status: 'succeeded' }),
      booking_com: stubAdapter('booking_com', { status: 'succeeded' }),
      vrbo: stubAdapter('vrbo', { status: 'succeeded' }),
      homeexchange: stubAdapter('homeexchange', { status: 'succeeded' }),
    };

    await propagateBooking(fixture.db, fixture.tenantId, booking.id, { ...OPTS, adapters });

    assert.equal(adapters.airbnb.calls[0]?.bookingType, 'unavailable');
    assert.equal(adapters.booking_com.calls[0]?.bookingType, 'closed');
    assert.equal(adapters.vrbo.calls[0]?.bookingType, 'RESERVED');
    assert.equal(adapters.homeexchange.calls[0]?.bookingType, 'blocked');
  });
});

describe('per-channel outcomes stay independent', () => {
  it('keeps a success successful when another channel times out', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    const booking = addBooking(fixture);

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: {
        airbnb: stubAdapter('airbnb', { status: 'succeeded' }),
        booking_com: stubAdapter('booking_com', { status: 'succeeded' }),
        vrbo: stubAdapter('vrbo', {
          status: 'delayed',
          reason: 'Vrbo did not respond within 8000ms.',
          reasonCode: 'timeout',
        }),
        homeexchange: stubAdapter('homeexchange', { status: 'succeeded' }),
      },
    });

    const byChannel = new Map(result.attempts.map((a) => [a.channel, a]));
    assert.equal(byChannel.get('airbnb')?.status, 'succeeded');
    assert.equal(byChannel.get('booking_com')?.status, 'succeeded');
    assert.equal(byChannel.get('homeexchange')?.status, 'succeeded');
    assert.equal(byChannel.get('vrbo')?.status, 'delayed');
    assert.equal(byChannel.get('vrbo')?.reasonCode, 'timeout');

    // The aggregate must not claim complete success.
    assert.equal(result.aggregateStatus, 'partial');
  });

  it('records a rejection without disturbing the accepted channels', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    const booking = addBooking(fixture);

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: {
        airbnb: stubAdapter('airbnb', { status: 'succeeded' }),
        booking_com: stubAdapter('booking_com', { status: 'succeeded' }),
        vrbo: stubAdapter('vrbo', { status: 'succeeded' }),
        homeexchange: stubAdapter('homeexchange', {
          status: 'rejected',
          reason: 'member calendar is locked',
          reasonCode: 'rejected_by_platform',
        }),
      },
    });

    assert.equal(result.aggregateStatus, 'partial');
    assert.equal(result.attempts.filter((a) => a.status === 'succeeded').length, 3);
    const rejected = result.attempts.find((a) => a.channel === 'homeexchange');
    assert.equal(rejected?.status, 'rejected');
    assert.match(rejected?.reason ?? '', /locked/);
  });

  it('is failed when no channel accepted', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    const booking = addBooking(fixture);

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: {
        airbnb: stubAdapter('airbnb', { status: 'failed', reasonCode: 'unauthorized' }),
        booking_com: stubAdapter('booking_com', { status: 'failed', reasonCode: 'unauthorized' }),
        vrbo: stubAdapter('vrbo', { status: 'rejected', reasonCode: 'conflict' }),
        homeexchange: stubAdapter('homeexchange', { status: 'delayed', reasonCode: 'timeout' }),
      },
    });

    assert.equal(result.aggregateStatus, 'failed');
  });

  it('retries a retryable outcome up to the channel budget', async () => {
    const fixture = seedFixture({ connections: [ALL_FOUR[0]!] });
    const booking = addBooking(fixture);
    const flaky = stubAdapter('airbnb', {
      status: 'delayed',
      reasonCode: 'timeout',
      retryable: true,
    });

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: { airbnb: flaky },
    });

    assert.equal(flaky.calls.length, 3, 'maxAttempts for Airbnb is 3');
    assert.equal(result.attempts[0]?.status, 'delayed');
    assert.equal(result.attempts[0]?.attemptCount, 3, 'persisted count reflects real submissions');
  });

  it('does not retry a non-retryable rejection', async () => {
    const fixture = seedFixture({ connections: [ALL_FOUR[0]!] });
    const booking = addBooking(fixture);
    const rejecting = stubAdapter('airbnb', {
      status: 'rejected',
      reasonCode: 'rejected_invalid_request',
      retryable: false,
    });

    await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: { airbnb: rejecting },
    });

    assert.equal(rejecting.calls.length, 1);
  });
});

describe('idempotent replay', () => {
  it('converges on a second run without re-submitting to any channel', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    const booking = addBooking(fixture);
    const adapters = {
      airbnb: stubAdapter('airbnb', { status: 'succeeded' }),
      booking_com: stubAdapter('booking_com', { status: 'succeeded' }),
      vrbo: stubAdapter('vrbo', { status: 'succeeded' }),
      homeexchange: stubAdapter('homeexchange', { status: 'succeeded' }),
    };

    const first = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters,
    });
    const second = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters,
    });

    assert.equal(second.propagationId, first.propagationId, 'same propagation record');
    assert.equal(second.replay, true);
    assert.equal(second.convergedChannels.length, 4);
    assert.equal(second.aggregateStatus, 'complete');

    for (const adapter of Object.values(adapters)) {
      assert.equal(adapter.calls.length, 1, `${adapter.channel} must not be called twice`);
    }

    // One attempt row per channel, not two.
    assert.equal(repo.listAttempts(fixture.db, fixture.tenantId, first.propagationId!).length, 4);
    assert.equal(repo.listPropagations(fixture.db, fixture.tenantId).length, 1);
  });

  it('retries only the channel that had not succeeded', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    const booking = addBooking(fixture);
    const ok = () => stubAdapter('airbnb', { status: 'succeeded' });

    const failing = stubAdapter('vrbo', { status: 'delayed', reasonCode: 'timeout' });
    const others = {
      airbnb: ok(),
      booking_com: stubAdapter('booking_com', { status: 'succeeded' }),
      homeexchange: stubAdapter('homeexchange', { status: 'succeeded' }),
    };

    await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: { ...others, vrbo: failing },
    });

    const recovered = stubAdapter('vrbo', { status: 'succeeded' });
    const second = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: { ...others, vrbo: recovered },
    });

    assert.equal(others.airbnb.calls.length, 1, 'already-succeeded channel is untouched');
    assert.equal(recovered.calls.length, 1, 'the failed channel is retried');
    assert.equal(second.aggregateStatus, 'complete');
  });

  it('converges across a replayed webhook delivery', async () => {
    const fixture = seedFixture({ connections: [ALL_FOUR[0]!] });
    const adapter = stubAdapter('airbnb', { status: 'succeeded' });
    const event = {
      eventId: 'evt-replay-1',
      tenantId: fixture.tenantId,
      propertyId: fixture.propertyId,
      sourceChannel: 'airbnb' as const,
      externalBookingId: 'HMREPLAY',
      state: 'confirmed' as const,
      ...STAY,
    };

    const first = await ingestBookingEvent(fixture.db, event, { ...OPTS, adapters: { airbnb: adapter } });
    const second = await ingestBookingEvent(fixture.db, event, { ...OPTS, adapters: { airbnb: adapter } });

    assert.equal(first.duplicateDelivery, false);
    assert.equal(second.duplicateDelivery, true);
    assert.equal(second.bookingId, first.bookingId);
    assert.equal(second.propagation.propagationId, first.propagation.propagationId);
    assert.equal(adapter.calls.length, 1, 'a replayed delivery must not re-submit');
    assert.equal(repo.listPropagations(fixture.db, fixture.tenantId).length, 1);
  });

  it('treats a different stay as a distinct propagation', async () => {
    const fixture = seedFixture({ connections: [ALL_FOUR[0]!] });
    const adapter = stubAdapter('airbnb', { status: 'succeeded' });

    const one = addBooking(fixture, { externalBookingId: 'BK-1' });
    const two = addBooking(fixture, { externalBookingId: 'BK-2' });

    const a = await propagateBooking(fixture.db, fixture.tenantId, one.id, { ...OPTS, adapters: { airbnb: adapter } });
    const b = await propagateBooking(fixture.db, fixture.tenantId, two.id, { ...OPTS, adapters: { airbnb: adapter } });

    assert.notEqual(a.propagationId, b.propagationId);
    assert.equal(repo.listPropagations(fixture.db, fixture.tenantId).length, 2);
  });
});

describe('non-confirmed states', () => {
  for (const state of ['hold', 'tentative', 'cancelled', 'modified', 'refunded'] as BookingState[]) {
    it(`declines "${state}" and creates no propagation`, async () => {
      const fixture = seedFixture({ connections: ALL_FOUR });
      const booking = addBooking(fixture, { state });
      const adapter = stubAdapter('airbnb', { status: 'succeeded' });

      const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
        ...OPTS,
        adapters: { airbnb: adapter },
      });

      assert.equal(result.kind, 'declined_not_confirmed');
      assert.equal(result.propagationId, null);
      assert.equal(adapter.calls.length, 0);
      assert.equal(repo.listPropagations(fixture.db, fixture.tenantId).length, 0);
      assert.match(result.reason ?? '', /\S/);
    });
  }

  it('does not propagate an arbitrary hold even when connections exist', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    const booking = addBooking(fixture, { state: 'hold' });
    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, OPTS);
    assert.match(result.reason ?? '', /hold/i);
  });
});

describe('connection-set edge cases', () => {
  it('reports no targets when nothing is connected', async () => {
    const fixture = seedFixture({ connections: [] });
    const booking = addBooking(fixture);

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, OPTS);

    assert.equal(result.kind, 'no_targets');
    assert.equal(result.aggregateStatus, 'no_targets');
    assert.equal(result.attempts.length, 0);
    assert.match(result.reason ?? '', /not a cross-channel success/i);
  });

  it('handles a single connected channel without implying others were updated', async () => {
    const fixture = seedFixture({ connections: [ALL_FOUR[0]!] });
    const booking = addBooking(fixture);

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: { airbnb: stubAdapter('airbnb', { status: 'succeeded' }) },
    });

    assert.equal(result.attempts.length, 1);
    const view = buildPropagationView(fixture.db, fixture.tenantId, result.propagationId!);
    assert.equal(view?.unattemptedChannels.length, 3);
    for (const entry of view?.unattemptedChannels ?? []) {
      assert.match(entry.reason, /not connected/i);
    }
  });

  it('excludes a disabled connection and names it as unattempted', async () => {
    const fixture = seedFixture({
      connections: [ALL_FOUR[0]!, { channel: 'vrbo', listingId: 'vrbo-1', enabled: false }],
    });
    const booking = addBooking(fixture);

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: {
        airbnb: stubAdapter('airbnb', { status: 'succeeded' }),
        vrbo: stubAdapter('vrbo', { status: 'succeeded' }),
      },
    });

    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.channel, 'airbnb');

    const view = buildPropagationView(fixture.db, fixture.tenantId, result.propagationId!);
    const vrbo = view?.unattemptedChannels.find((c) => c.channel === 'vrbo');
    assert.match(vrbo?.reason ?? '', /disabled/i);
  });

  it('reports a missing credential as a failed channel, not a success', async () => {
    const fixture = seedFixture({ connections: [ALL_FOUR[0]!] });
    const booking = addBooking(fixture);
    const saved = process.env.AIRBNB_API_TOKEN;
    delete process.env.AIRBNB_API_TOKEN;

    try {
      const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, OPTS);
      assert.equal(result.attempts[0]?.status, 'failed');
      assert.equal(result.attempts[0]?.reasonCode, 'missing_credential');
      assert.equal(result.aggregateStatus, 'failed');
      // The variable name may appear; a secret value may not.
      assert.match(result.attempts[0]?.reason ?? '', /AIRBNB_API_TOKEN/);
    } finally {
      if (saved !== undefined) process.env.AIRBNB_API_TOKEN = saved;
    }
  });
});

describe('tenant and property scoping', () => {
  it('rejects propagating another tenant’s booking', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    addTenant(fixture.db, 'tenant-b', 'prop-b');
    const booking = addBooking(fixture);

    await assert.rejects(
      () => propagateBooking(fixture.db, 'tenant-b', booking.id, OPTS),
      CrossTenantError,
    );
  });

  it('rejects an event naming another tenant’s property', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    addTenant(fixture.db, 'tenant-b', 'prop-b');

    await assert.rejects(
      () =>
        ingestBookingEvent(fixture.db, {
          eventId: 'evt-cross-1',
          tenantId: fixture.tenantId,
          propertyId: 'prop-b', // belongs to tenant-b
          sourceChannel: 'airbnb',
          externalBookingId: 'HMCROSS',
          state: 'confirmed',
          ...STAY,
        }),
      CrossTenantError,
    );
  });

  it('never reaches another tenant’s connections', async () => {
    const fixture = seedFixture({ connections: ALL_FOUR });
    addTenant(fixture.db, 'tenant-b', 'prop-b');
    repo.createConnection(fixture.db, {
      tenantId: 'tenant-b',
      propertyId: 'prop-b',
      channel: 'airbnb',
      externalListingId: 'abnb-other-tenant',
    });

    const booking = addBooking(fixture);
    const adapters = {
      airbnb: stubAdapter('airbnb', { status: 'succeeded' }),
      booking_com: stubAdapter('booking_com', { status: 'succeeded' }),
      vrbo: stubAdapter('vrbo', { status: 'succeeded' }),
      homeexchange: stubAdapter('homeexchange', { status: 'succeeded' }),
    };

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters,
    });

    assert.equal(result.attempts.length, 4, 'only this property’s four connections');
    for (const attempt of result.attempts) {
      assert.equal(attempt.tenantId, fixture.tenantId);
      assert.equal(attempt.propertyId, fixture.propertyId);
    }
    // The other tenant sees nothing.
    assert.equal(repo.listPropagations(fixture.db, 'tenant-b').length, 0);
    assert.equal(buildPropagationView(fixture.db, 'tenant-b', result.propagationId!), null);
  });

  it('scopes the status view to the owning tenant', async () => {
    const fixture = seedFixture({ connections: [ALL_FOUR[0]!] });
    addTenant(fixture.db, 'tenant-b', 'prop-b');
    const booking = addBooking(fixture);
    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: { airbnb: stubAdapter('airbnb', { status: 'succeeded' }) },
    });

    assert.ok(buildPropagationView(fixture.db, fixture.tenantId, result.propagationId!));
    assert.equal(buildPropagationView(fixture.db, 'tenant-b', result.propagationId!), null);
  });
});

describe('invalid stays', () => {
  it('declines a zero-night booking without contacting a channel', async () => {
    const fixture = seedFixture({ connections: [ALL_FOUR[0]!] });
    const booking = repo.upsertBooking(fixture.db, {
      tenantId: fixture.tenantId,
      propertyId: fixture.propertyId,
      sourceChannel: 'airbnb',
      externalBookingId: 'HMZERO',
      state: 'confirmed',
      checkIn: '2026-06-10',
      checkOut: '2026-06-10',
    });
    const adapter = stubAdapter('airbnb', { status: 'succeeded' });

    const result = await propagateBooking(fixture.db, fixture.tenantId, booking.id, {
      ...OPTS,
      adapters: { airbnb: adapter },
    });

    assert.equal(result.kind, 'invalid_stay');
    assert.equal(adapter.calls.length, 0);
    assert.equal(repo.listPropagations(fixture.db, fixture.tenantId).length, 0);
  });
});
