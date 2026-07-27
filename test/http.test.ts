/**
 * End-to-end: a confirmed-booking webhook arrives over HTTP with a real
 * credential, propagates to four channel endpoints over real HTTP, and the
 * resulting status page reflects each channel's actual outcome.
 *
 * Nothing here is stubbed in-process — two separate servers are listening and
 * every hop is a genuine request.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openTestDatabase, type Db } from '../src/db/index.ts';
import * as repo from '../src/db/repo.ts';
import { createApp } from '../src/http/app.ts';
import { listen, postJson, setTestCredentials, startConformance, type Listening } from './helpers.ts';

const KEY_A = 'key-tenant-a';
const KEY_B = 'key-tenant-b';
const TENANT_KEYS = new Map([
  [KEY_A, 'tenant-a'],
  [KEY_B, 'tenant-b'],
]);

const STAY = { checkIn: '2026-06-10', checkOut: '2026-06-13' };

let db: Db;
let conformance: Listening;
let app: Listening;

before(async () => {
  setTestCredentials();
  process.env.CHANNEL_TIMEOUT_MS = '400';
  process.env.CHANNEL_MAX_ATTEMPTS = '1';
  conformance = await startConformance();

  db = openTestDatabase();

  repo.createTenant(db, 'Tenant A', 'tenant-a');
  repo.createTenant(db, 'Tenant B', 'tenant-b');

  // All four channels accept.
  repo.createProperty(db, { id: 'prop-all', tenantId: 'tenant-a', name: 'Harbour Cottage', timezone: 'Europe/Amsterdam' });
  repo.createConnection(db, { tenantId: 'tenant-a', propertyId: 'prop-all', channel: 'airbnb', externalListingId: 'abnb-ok' });
  repo.createConnection(db, { tenantId: 'tenant-a', propertyId: 'prop-all', channel: 'booking_com', externalListingId: 'bcom-ok' });
  repo.createConnection(db, { tenantId: 'tenant-a', propertyId: 'prop-all', channel: 'vrbo', externalListingId: 'vrbo-ok' });
  repo.createConnection(db, { tenantId: 'tenant-a', propertyId: 'prop-all', channel: 'homeexchange', externalListingId: 'hex-ok' });

  // Vrbo times out, HomeExchange rejects, Booking.com is not connected.
  repo.createProperty(db, { id: 'prop-partial', tenantId: 'tenant-a', name: 'Garden Studio', timezone: 'Europe/Amsterdam' });
  repo.createConnection(db, { tenantId: 'tenant-a', propertyId: 'prop-partial', channel: 'airbnb', externalListingId: 'abnb-ok' });
  repo.createConnection(db, { tenantId: 'tenant-a', propertyId: 'prop-partial', channel: 'vrbo', externalListingId: 'vrbo-timeout' });
  repo.createConnection(db, { tenantId: 'tenant-a', propertyId: 'prop-partial', channel: 'homeexchange', externalListingId: 'hex-reject' });

  // No connections at all.
  repo.createProperty(db, { id: 'prop-bare', tenantId: 'tenant-a', name: 'Bare Loft', timezone: 'UTC' });

  // Another tenant's property.
  repo.createProperty(db, { id: 'prop-b', tenantId: 'tenant-b', name: 'Unrelated Villa', timezone: 'UTC' });

  app = await listen(createApp({ db, tenantKeys: TENANT_KEYS, propagateOptions: { retryDelayMs: 0 } }));
});

after(async () => {
  delete process.env.CHANNEL_TIMEOUT_MS;
  delete process.env.CHANNEL_MAX_ATTEMPTS;
  await app.close();
  await conformance.close();
  db.close();
});

function bookingEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-1',
    tenantId: 'tenant-a',
    propertyId: 'prop-all',
    sourceChannel: 'airbnb',
    externalBookingId: 'HMBOOK1',
    state: 'confirmed',
    ...STAY,
    ...overrides,
  };
}

function webhook(body: unknown, key = KEY_A) {
  return postJson(`${app.url}/webhooks/bookings`, body, { 'x-api-key': key });
}

describe('happy path — every connected channel accepts', () => {
  it('propagates to four channels and reports complete', async () => {
    const { status, body } = await webhook(bookingEvent({ eventId: 'evt-happy', externalBookingId: 'HM-HAPPY' }));

    assert.equal(status, 200);
    assert.equal(body.kind, 'processed');
    assert.equal(body.aggregateStatus, 'complete');

    const attempts = body.attempts as { channel: string; status: string; nights: number }[];
    assert.equal(attempts.length, 4);
    for (const attempt of attempts) {
      assert.equal(attempt.status, 'succeeded', `${attempt.channel}: ${JSON.stringify(attempt)}`);
      assert.equal(attempt.nights, 3);
    }
  });

  it('renders the mapped nights and an independent result per channel', async () => {
    const { body } = await webhook(bookingEvent({ eventId: 'evt-render', externalBookingId: 'HM-RENDER' }));
    const id = body.propagationId as string;

    const response = await fetch(`${app.url}/propagations/${id}`, {
      headers: { 'x-api-key': KEY_A },
    });
    const page = await response.text();

    assert.equal(response.status, 200);
    assert.match(page, /All channels updated/);
    for (const label of ['Airbnb', 'Booking.com', 'Vrbo', 'HomeExchange']) {
      assert.ok(page.includes(label), `status page should name ${label}`);
    }
    for (const night of ['2026-06-10', '2026-06-11', '2026-06-12']) {
      assert.ok(page.includes(night), `status page should show night ${night}`);
    }
    // The checkout date must not be presented as blocked.
    assert.ok(!page.includes('>2026-06-13</span>'), 'checkout date must not appear as a blocked night');
  });
});

describe('failure path — one channel delayed, one rejected', () => {
  it('keeps successes successful and does not claim complete', async () => {
    const { status, body } = await webhook(
      bookingEvent({ eventId: 'evt-partial', propertyId: 'prop-partial', externalBookingId: 'HM-PARTIAL' }),
    );

    assert.equal(status, 200);
    assert.equal(body.aggregateStatus, 'partial', JSON.stringify(body.attempts));

    const byChannel = new Map(
      (body.attempts as { channel: string; status: string; reasonCode: string | null }[]).map((a) => [
        a.channel,
        a,
      ]),
    );

    assert.equal(byChannel.get('airbnb')?.status, 'succeeded');
    assert.equal(byChannel.get('vrbo')?.status, 'delayed');
    assert.equal(byChannel.get('vrbo')?.reasonCode, 'timeout');
    assert.equal(byChannel.get('homeexchange')?.status, 'rejected');
    assert.ok(!byChannel.has('booking_com'), 'unconnected channel is not attempted');
  });

  it('shows the failing channels with reasons and no success claim', async () => {
    const { body } = await webhook(
      bookingEvent({ eventId: 'evt-partial-ui', propertyId: 'prop-partial', externalBookingId: 'HM-PARTIAL-UI' }),
    );
    const id = body.propagationId as string;

    const page = await (
      await fetch(`${app.url}/propagations/${id}`, { headers: { 'x-api-key': KEY_A } })
    ).text();

    assert.match(page, /Partially updated/);
    assert.ok(!page.includes('All channels updated'), 'must not claim full success');
    assert.match(page, /data-status="succeeded"/);
    assert.match(page, /data-status="delayed"/);
    assert.match(page, /data-status="rejected"/);
    assert.match(page, /stale/i);
    // Booking.com is connected nowhere here, and must be named as outside the attempt.
    assert.match(page, /Not attempted/);
    assert.match(page, /not connected/i);
  });
});

describe('empty connection set', () => {
  it('reports no targets rather than success', async () => {
    const { status, body } = await webhook(
      bookingEvent({ eventId: 'evt-bare', propertyId: 'prop-bare', externalBookingId: 'HM-BARE' }),
    );

    assert.equal(status, 202);
    assert.equal(body.kind, 'no_targets');
    assert.equal(body.aggregateStatus, 'no_targets');
    assert.match(String(body.reason), /not a cross-channel success/i);
  });
});

describe('replayed delivery', () => {
  it('converges without duplicating the propagation', async () => {
    const event = bookingEvent({ eventId: 'evt-replay', externalBookingId: 'HM-REPLAY' });

    const first = await webhook(event);
    const second = await webhook(event);

    assert.equal(first.body.duplicateDelivery, false);
    assert.equal(second.body.duplicateDelivery, true);
    assert.equal(second.body.propagationId, first.body.propagationId);
    assert.equal(second.body.replay, true);
    assert.equal((second.body.convergedChannels as string[]).length, 4);
    assert.equal(second.body.aggregateStatus, 'complete');
  });
});

describe('non-confirmed states', () => {
  it('does not propagate an arbitrary hold', async () => {
    const { status, body } = await webhook(
      bookingEvent({ eventId: 'evt-hold', externalBookingId: 'HM-HOLD', state: 'hold' }),
    );

    assert.equal(status, 202);
    assert.equal(body.kind, 'declined_not_confirmed');
    assert.equal(body.propagationId, null);
    assert.match(String(body.reason), /hold/i);
  });

  it('rejects an unrecognised state instead of assuming confirmed', async () => {
    const { status, body } = await webhook(
      bookingEvent({ eventId: 'evt-weird', externalBookingId: 'HM-WEIRD', state: 'probably_fine' }),
    );
    assert.equal(status, 400);
    assert.match(String(body.error), /booking state/i);
  });
});

describe('identity and scope at the boundary', () => {
  it('refuses an unauthenticated webhook', async () => {
    const response = await fetch(`${app.url}/webhooks/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bookingEvent()),
    });
    assert.equal(response.status, 401);
  });

  it('refuses an unrecognised key', async () => {
    const { status } = await webhook(bookingEvent(), 'not-a-real-key');
    assert.equal(status, 401);
  });

  it('refuses an event naming a different tenant than the credential', async () => {
    const { status, body } = await webhook(
      bookingEvent({ eventId: 'evt-spoof', tenantId: 'tenant-b', externalBookingId: 'HM-SPOOF' }),
      KEY_A,
    );
    assert.equal(status, 403);
    assert.match(String(body.error), /does not match/i);
  });

  it('refuses an event naming another tenant’s property', async () => {
    const { status, body } = await webhook(
      bookingEvent({ eventId: 'evt-crossprop', propertyId: 'prop-b', externalBookingId: 'HM-CROSSPROP' }),
      KEY_A,
    );
    assert.equal(status, 403);
    assert.match(String(body.error), /another tenant/i);
  });

  it('hides one tenant’s propagation from another', async () => {
    const { body } = await webhook(
      bookingEvent({ eventId: 'evt-isolate', externalBookingId: 'HM-ISOLATE' }),
    );
    const id = body.propagationId as string;

    const mine = await fetch(`${app.url}/api/propagations/${id}`, { headers: { 'x-api-key': KEY_A } });
    const theirs = await fetch(`${app.url}/api/propagations/${id}`, { headers: { 'x-api-key': KEY_B } });

    assert.equal(mine.status, 200);
    assert.equal(theirs.status, 404);
  });

  it('redirects an unauthenticated UI request to sign-in', async () => {
    const response = await fetch(`${app.url}/`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/signin');
  });

  it('issues an HttpOnly session cookie on sign-in', async () => {
    const response = await fetch(`${app.url}/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: KEY_A }).toString(),
      redirect: 'manual',
    });
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /hm_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it('rejects a bad key at sign-in', async () => {
    const response = await fetch(`${app.url}/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: 'wrong' }).toString(),
      redirect: 'manual',
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  });
});

describe('malformed input', () => {
  it('rejects a non-JSON body', async () => {
    const response = await fetch(`${app.url}/webhooks/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY_A },
      body: 'not json',
    });
    assert.equal(response.status, 400);
  });

  it('rejects a malformed date', async () => {
    const { status, body } = await webhook(
      bookingEvent({ eventId: 'evt-baddate', externalBookingId: 'HM-BADDATE', checkIn: '10/06/2026' }),
    );
    assert.equal(status, 400);
    assert.match(String(body.error), /calendar date/i);
  });

  it('rejects a missing required field', async () => {
    const event = bookingEvent({ eventId: 'evt-missing' }) as Record<string, unknown>;
    delete event.externalBookingId;
    const { status } = await webhook(event);
    assert.equal(status, 400);
  });

  it('rejects an unknown source channel', async () => {
    const { status, body } = await webhook(
      bookingEvent({ eventId: 'evt-badchan', externalBookingId: 'HM-BADCHAN', sourceChannel: 'expedia' }),
    );
    assert.equal(status, 400);
    assert.match(String(body.error), /sourceChannel/);
  });
});

describe('static and health routes', () => {
  it('serves the design system stylesheet', async () => {
    const response = await fetch(`${app.url}/assets/design-system.css`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/css/);
    const css = await response.text();
    // The enumerated component vocabulary must actually be present.
    for (const name of ['.layout', '.wrap', '.block', '.title', '.note', '.cardgrid', '.spec', '.mono']) {
      assert.ok(css.includes(name), `stylesheet should define ${name}`);
    }
    assert.match(css, /--ch-airbnb/);
  });

  it('answers health checks', async () => {
    const response = await fetch(`${app.url}/healthz`);
    assert.equal(response.status, 200);
  });
});
