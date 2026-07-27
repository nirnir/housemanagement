import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openTestDatabase, type Db } from '../src/db/index.ts';
import * as repo from '../src/db/repo.ts';
import { createApp } from '../src/http/app.ts';
import {
  listen,
  postJson,
  setTestCredentials,
  startConformance,
  type Listening,
} from './helpers.ts';

const KEY = 'calendar-key';
let db: Db;
let conformance: Listening;
let app: Listening;

before(async () => {
  setTestCredentials();
  process.env.CHANNEL_TIMEOUT_MS = '250';
  process.env.CHANNEL_MAX_ATTEMPTS = '1';
  conformance = await startConformance();
  db = openTestDatabase();
  repo.createTenant(db, 'Calendar tenant', 'tenant-calendar');
  repo.createProperty(db, {
    id: 'prop-calendar',
    tenantId: 'tenant-calendar',
    name: 'Harbour Cottage',
    timezone: 'Europe/London',
  });
  for (const [channel, externalListingId] of [
    ['airbnb', 'airbnb-ok'],
    ['booking_com', 'booking-ok'],
    ['vrbo', 'vrbo-timeout'],
    ['homeexchange', 'homeexchange-reject'],
  ] as const) {
    repo.createConnection(db, {
      tenantId: 'tenant-calendar',
      propertyId: 'prop-calendar',
      channel,
      externalListingId,
    });
  }
  app = await listen(
    createApp({
      db,
      tenantKeys: new Map([[KEY, 'tenant-calendar']]),
      propagateOptions: { retryDelayMs: 0 },
    }),
  );
});

after(async () => {
  delete process.env.CHANNEL_TIMEOUT_MS;
  delete process.env.CHANNEL_MAX_ATTEMPTS;
  await app.close();
  await conformance.close();
  db.close();
});

function calendarEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'cal-1',
    tenantId: 'tenant-calendar',
    propertyId: 'prop-calendar',
    source: 'airbnb',
    externalRecordId: 'booking-1',
    state: 'confirmed',
    checkIn: '2026-09-10',
    checkOut: '2026-09-13',
    ...overrides,
  };
}

function webhook(body: unknown) {
  return postJson(`${app.url}/webhooks/calendar`, body, { 'x-api-key': KEY });
}

describe('unified calendar HTTP path', () => {
  it('ingests through real HTTP and reports independent channel failures', async () => {
    const response = await webhook(calendarEvent());
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'accepted');
    const sync = response.body.blockSync as {
      aggregateStatus: string;
      attempts: { channel: string; status: string }[];
    };
    assert.equal(sync.aggregateStatus, 'partial');
    assert.deepEqual(
      new Map(sync.attempts.map((attempt) => [attempt.channel, attempt.status])),
      new Map([
        ['airbnb', 'succeeded'],
        ['booking_com', 'succeeded'],
        ['homeexchange', 'rejected'],
        ['vrbo', 'delayed'],
      ]),
    );
  });

  it('renders source/state, conflicts and actionable stale channel status', async () => {
    const conflict = await webhook(
      calendarEvent({
        eventId: 'cal-conflict',
        source: 'homeexchange',
        externalRecordId: 'exchange-1',
        checkIn: '2026-09-12',
        checkOut: '2026-09-15',
      }),
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.outcome, 'conflict');

    const response = await fetch(`${app.url}/calendar/prop-calendar`, {
      headers: { 'x-api-key': KEY },
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Unified calendar/);
    assert.match(html, /Airbnb/);
    assert.match(html, /HomeExchange/);
    assert.match(html, /Conflict — not propagated/);
    assert.match(html, /Rate limit|timed out|timeout|did not respond/i);
    assert.match(html, /Last successful sync/);
    assert.match(html, /Retry failed channels/);
  });

  it('releases a cancellation and converges duplicate provider events', async () => {
    const first = await webhook(
      calendarEvent({ eventId: 'cal-cancel', state: 'cancelled' }),
    );
    const replay = await webhook(
      calendarEvent({ eventId: 'cal-cancel', state: 'cancelled' }),
    );
    assert.equal(first.body.outcome, 'cancelled');
    assert.equal(replay.body.duplicateDelivery, true);
    assert.equal(
      (replay.body.releaseSync as { convergedChannels: string[] }).convergedChannels.length,
      2,
    );
  });
});
