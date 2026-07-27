import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as calendarRepo from '../src/db/calendar-repo.ts';
import * as repo from '../src/db/repo.ts';
import type { ChannelKey } from '../src/domain/types.ts';
import { buildCalendarView } from '../src/worker/calendar-view.ts';
import { ingestCalendarEvent, type CalendarEvent } from '../src/worker/calendar-ingest.ts';
import { addTenant, seedFixture, stubAdapter } from './helpers.ts';

const CHANNELS: ChannelKey[] = ['airbnb', 'booking_com', 'vrbo', 'homeexchange'];

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: 'evt-1',
    tenantId: 'tenant-a',
    propertyId: 'prop-a',
    source: 'airbnb',
    externalRecordId: 'booking-1',
    state: 'confirmed',
    checkIn: '2026-08-01',
    checkOut: '2026-08-04',
    ...overrides,
  };
}

function allSuccessAdapters() {
  return Object.fromEntries(
    CHANNELS.map((channel) => [channel, stubAdapter(channel, { status: 'succeeded' })]),
  );
}

describe('canonical unified calendar', () => {
  it('combines Airbnb, Booking.com, Vrbo and HomeExchange exactly once', async () => {
    const { db } = seedFixture({
      connections: CHANNELS.map((channel) => ({ channel, listingId: `${channel}-1` })),
    });
    const adapters = allSuccessAdapters();
    for (const [index, source] of CHANNELS.entries()) {
      const day = String(1 + index * 3).padStart(2, '0');
      const checkout = String(3 + index * 3).padStart(2, '0');
      await ingestCalendarEvent(
        db,
        event({
          eventId: `evt-${source}`,
          source,
          externalRecordId: `ref-${source}`,
          checkIn: `2026-08-${day}`,
          checkOut: `2026-08-${checkout}`,
        }),
        { adapters, retryDelayMs: 0 },
      );
    }

    const view = buildCalendarView(db, 'tenant-a', 'prop-a');
    assert.equal(view.records.length, 4);
    assert.deepEqual(
      new Set(view.records.map((entry) => entry.record.source)),
      new Set(CHANNELS),
    );

    const replay = await ingestCalendarEvent(
      db,
      event({
        eventId: 'evt-airbnb',
        source: 'airbnb',
        externalRecordId: 'ref-airbnb',
        checkIn: '2026-08-01',
        checkOut: '2026-08-03',
      }),
      { adapters, retryDelayMs: 0 },
    );
    assert.equal(replay.duplicateDelivery, true);
    assert.equal(buildCalendarView(db, 'tenant-a', 'prop-a').records.length, 4);
    db.close();
  });

  it('blocks overlaps without calling any channel and allows checkout adjacency', async () => {
    const { db } = seedFixture({
      connections: [{ channel: 'airbnb', listingId: 'airbnb-1' }],
    });
    const airbnb = stubAdapter('airbnb', { status: 'succeeded' });
    await ingestCalendarEvent(db, event(), {
      adapters: { airbnb },
      retryDelayMs: 0,
    });
    assert.equal(airbnb.calls.length, 1);

    const conflict = await ingestCalendarEvent(
      db,
      event({
        eventId: 'evt-overlap',
        source: 'vrbo',
        externalRecordId: 'booking-overlap',
        checkIn: '2026-08-03',
        checkOut: '2026-08-06',
      }),
      { adapters: { airbnb }, retryDelayMs: 0 },
    );
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.blockSync, null);
    assert.equal(airbnb.calls.length, 1);

    const adjacent = await ingestCalendarEvent(
      db,
      event({
        eventId: 'evt-adjacent',
        source: 'booking_com',
        externalRecordId: 'booking-adjacent',
        checkIn: '2026-08-04',
        checkOut: '2026-08-06',
      }),
      { adapters: { airbnb }, retryDelayMs: 0 },
    );
    assert.equal(adjacent.outcome, 'accepted');
    assert.equal(airbnb.calls.length, 2);
    db.close();
  });

  it('preserves holds, owner blocks and cancellation releases', async () => {
    const { db } = seedFixture({
      connections: [{ channel: 'airbnb', listingId: 'airbnb-1' }],
    });
    const airbnb = stubAdapter('airbnb', { status: 'succeeded' });
    await ingestCalendarEvent(
      db,
      event({ state: 'hold', externalRecordId: 'hold-1' }),
      { adapters: { airbnb }, retryDelayMs: 0 },
    );
    await ingestCalendarEvent(
      db,
      event({
        eventId: 'evt-owner',
        source: 'owner',
        externalRecordId: 'owner-1',
        state: 'owner_block',
        checkIn: '2026-08-10',
        checkOut: '2026-08-12',
      }),
      { adapters: { airbnb }, retryDelayMs: 0 },
    );
    const cancelled = await ingestCalendarEvent(
      db,
      event({
        eventId: 'evt-cancel',
        state: 'cancelled',
        externalRecordId: 'hold-1',
      }),
      { adapters: { airbnb }, retryDelayMs: 0 },
    );

    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.record.lifecycleState, 'cancelled');
    assert.deepEqual(
      airbnb.calls.map((call) => call.operation),
      ['block', 'block', 'release'],
    );
    const records = calendarRepo.listAvailabilityRecords(db, 'tenant-a', 'prop-a');
    assert.deepEqual(
      records.map((record) => record.recordKind).sort(),
      ['hold', 'owner_block'],
    );
    db.close();
  });

  it('keeps per-channel partial failure truthful and fresh successes independent', async () => {
    const { db } = seedFixture({
      connections: [
        { channel: 'airbnb', listingId: 'airbnb-1' },
        { channel: 'vrbo', listingId: 'vrbo-1' },
      ],
    });
    const airbnb = stubAdapter('airbnb', { status: 'succeeded' });
    const vrbo = stubAdapter('vrbo', {
      status: 'delayed',
      reason: 'Rate limited',
      reasonCode: 'rate_limited',
      retryable: true,
    });
    const result = await ingestCalendarEvent(db, event(), {
      adapters: {
        airbnb,
        vrbo,
      },
      env: { ...process.env, CHANNEL_MAX_ATTEMPTS: '1' },
      retryDelayMs: 0,
    });
    assert.equal(result.blockSync?.aggregateStatus, 'partial');
    const view = buildCalendarView(db, 'tenant-a', 'prop-a');
    const byChannel = new Map(
      view.connections.map((connection) => [connection.connection.channel, connection]),
    );
    assert.equal(byChannel.get('airbnb')?.freshness, 'fresh');
    assert.equal(byChannel.get('vrbo')?.freshness, 'stale');
    assert.match(byChannel.get('vrbo')?.connection.lastSyncError ?? '', /rate limited/i);

    await ingestCalendarEvent(db, event(), {
      adapters: { airbnb, vrbo },
      env: { ...process.env, CHANNEL_MAX_ATTEMPTS: '1' },
      retryDelayMs: 0,
    });
    assert.equal(airbnb.calls.length, 1, 'retry must not resubmit an already-successful channel');
    assert.equal(vrbo.calls.length, 2, 'retry must reattempt the stale channel');
    db.close();
  });

  it('never reads or writes another tenant/property scope', async () => {
    const { db } = seedFixture();
    addTenant(db, 'tenant-b', 'prop-b');
    await ingestCalendarEvent(db, event(), { retryDelayMs: 0 });

    assert.equal(calendarRepo.listAvailabilityRecords(db, 'tenant-b', 'prop-b').length, 0);
    assert.throws(() => buildCalendarView(db, 'tenant-b', 'prop-a'), repo.CrossTenantError);
    await assert.rejects(
      ingestCalendarEvent(
        db,
        event({ eventId: 'evt-cross', tenantId: 'tenant-b', propertyId: 'prop-a' }),
      ),
      repo.CrossTenantError,
    );
    db.close();
  });
});
