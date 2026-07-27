/**
 * Channel adapters over real HTTP against the conformance server.
 *
 * These are not in-process mocks: each test performs an actual fetch to a
 * separate listening server that speaks the platform's modelled contract,
 * presenting a real credential. The only thing substituted is the hostname.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { airbnbAdapter } from '../src/channels/airbnb.ts';
import { bookingComAdapter, buildAvailabilityXml, parseConfirmedDates, parseFault } from '../src/channels/booking-com.ts';
import { homeExchangeAdapter } from '../src/channels/homeexchange.ts';
import { vrboAdapter } from '../src/channels/vrbo.ts';
import { MissingCredentialError, redact } from '../src/channels/credentials.ts';
import { sameNights } from '../src/channels/transport.ts';
import type { AvailabilityRequest, ChannelAdapter } from '../src/channels/contract.ts';
import type { ChannelKey } from '../src/domain/types.ts';
import { listen, setTestCredentials, startConformance, type Listening } from './helpers.ts';

const NIGHTS = ['2026-06-10', '2026-06-11', '2026-06-12'];

let conformance: Listening;

before(async () => {
  setTestCredentials();
  // Keep the timeout path fast; the machinery under test is identical.
  process.env.CHANNEL_TIMEOUT_MS = '400';
  conformance = await startConformance();
});

after(async () => {
  delete process.env.CHANNEL_TIMEOUT_MS;
  await conformance.close();
});

function request(channel: ChannelKey, listingId: string, bookingType: string): AvailabilityRequest {
  return {
    tenantId: 'tenant-a',
    propertyId: 'prop-a',
    channel,
    externalListingId: listingId,
    nights: NIGHTS,
    bookingType,
    sourceBookingRef: 'HMABC123',
    idempotencyKey: 'idem-key-abc',
  };
}

const CASES: { adapter: ChannelAdapter; channel: ChannelKey; prefix: string; type: string }[] = [
  { adapter: airbnbAdapter, channel: 'airbnb', prefix: 'abnb', type: 'unavailable' },
  { adapter: bookingComAdapter, channel: 'booking_com', prefix: 'bcom', type: 'closed' },
  { adapter: vrboAdapter, channel: 'vrbo', prefix: 'vrbo', type: 'RESERVED' },
  { adapter: homeExchangeAdapter, channel: 'homeexchange', prefix: 'hex', type: 'blocked' },
];

for (const { adapter, channel, prefix, type } of CASES) {
  describe(`${channel} adapter`, () => {
    it('accepts the mapped nights over real HTTP', async () => {
      const outcome = await adapter.submitUnavailability(request(channel, `${prefix}-ok`, type));
      assert.equal(outcome.status, 'succeeded', outcome.reason ?? '');
      assert.equal(outcome.mappedBookingType, type);
      assert.ok(sameNights(NIGHTS, outcome.confirmedNights));
      assert.ok(outcome.latencyMs >= 0);
    });

    it('records a platform rejection as rejected and not retryable', async () => {
      const outcome = await adapter.submitUnavailability(request(channel, `${prefix}-reject`, type));
      assert.equal(outcome.status, 'rejected', outcome.reason ?? '');
      assert.equal(outcome.retryable, false);
      assert.match(outcome.reason ?? '', /\S/);
      assert.deepEqual(outcome.confirmedNights, []);
    });

    it('records a timeout as delayed and retryable', async () => {
      const outcome = await adapter.submitUnavailability(request(channel, `${prefix}-timeout`, type));
      assert.equal(outcome.status, 'delayed');
      assert.equal(outcome.reasonCode, 'timeout');
      assert.equal(outcome.retryable, true);
      assert.match(outcome.reason ?? '', /unconfirmed|did not respond/i);
    });

    it('records rate limiting as delayed', async () => {
      const outcome = await adapter.submitUnavailability(request(channel, `${prefix}-ratelimit`, type));
      assert.equal(outcome.status, 'delayed');
      assert.equal(outcome.reasonCode, 'rate_limited');
      assert.equal(outcome.retryable, true);
    });

    it('rejects a 409 conflict for the separate conflict-safety workflow', async () => {
      const outcome = await adapter.submitUnavailability(request(channel, `${prefix}-conflict`, type));
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.reasonCode, 'conflict');
    });

    it('rejects an unsupported operation instead of claiming success', async () => {
      const outcome = await adapter.submitUnavailability(
        request(channel, `${prefix}-unsupported`, type),
      );
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.reasonCode, 'unsupported_operation');
    });

    it('does not accept a success status that confirms fewer nights', async () => {
      const outcome = await adapter.submitUnavailability(request(channel, `${prefix}-partial`, type));
      assert.notEqual(outcome.status, 'succeeded');
      assert.equal(outcome.reasonCode, 'partial_confirmation');
      assert.match(outcome.reason ?? '', /2 of 3/);
    });

    it('throws MissingCredentialError when no credential is configured', async () => {
      const envVar = {
        airbnb: 'AIRBNB_API_TOKEN',
        booking_com: 'BOOKING_COM_API_TOKEN',
        vrbo: 'VRBO_API_TOKEN',
        homeexchange: 'HOMEEXCHANGE_API_TOKEN',
      }[channel];
      const saved = process.env[envVar];
      delete process.env[envVar];
      try {
        await assert.rejects(
          () => adapter.submitUnavailability(request(channel, `${prefix}-ok`, type)),
          MissingCredentialError,
        );
      } finally {
        if (saved !== undefined) process.env[envVar] = saved;
      }
    });

    it('reports an unroutable host as delayed rather than succeeded', async () => {
      const saved = process.env.CONFORMANCE_BASE_URL;
      process.env.CONFORMANCE_BASE_URL = 'http://127.0.0.1:1';
      try {
        const outcome = await adapter.submitUnavailability(request(channel, `${prefix}-ok`, type));
        assert.equal(outcome.status, 'delayed');
        assert.ok(['network_error', 'timeout'].includes(outcome.reasonCode ?? ''));
      } finally {
        if (saved !== undefined) process.env.CONFORMANCE_BASE_URL = saved;
      }
    });
  });
}

describe('credential handling', () => {
  it('requires a credential on every channel route', async () => {
    // Calls the conformance route directly with no auth header.
    const response = await fetch(`${conformance.url}/airbnb/v2/calendars/abnb-ok/availability`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operations: [] }),
    });
    assert.equal(response.status, 401);
  });

  it('redacts secret-looking env values from text', () => {
    process.env.TEST_SCRATCH_TOKEN = 'super-secret-value-123';
    try {
      const output = redact('platform echoed super-secret-value-123 back');
      assert.ok(!output.includes('super-secret-value-123'));
      assert.match(output, /redacted:TEST_SCRATCH_TOKEN/);
    } finally {
      delete process.env.TEST_SCRATCH_TOKEN;
    }
  });

  it('never places a credential in a successful outcome', async () => {
    const outcome = await airbnbAdapter.submitUnavailability(request('airbnb', 'abnb-ok', 'unavailable'));
    const serialised = JSON.stringify(outcome);
    assert.ok(!serialised.includes('test-airbnb-token'));
  });
});

describe('Booking.com XML contract', () => {
  const req = request('booking_com', 'bcom-ok', 'closed');

  it('emits one date element per night, scoped to the room', () => {
    const xml = buildAvailabilityXml(req);
    assert.match(xml, /<room id="bcom-ok">/);
    for (const night of NIGHTS) {
      assert.ok(xml.includes(`<date value="${night}" status="closed"/>`), `missing ${night}`);
    }
    assert.match(xml, /<idempotency_key>idem-key-abc<\/idempotency_key>/);
  });

  it('escapes XML metacharacters', () => {
    const xml = buildAvailabilityXml({ ...req, externalListingId: 'a&b<c>"d\'' });
    assert.ok(!/id="a&b/.test(xml));
    assert.match(xml, /a&amp;b&lt;c&gt;&quot;d&apos;/);
  });

  it('parses confirmed dates from an ok response', () => {
    assert.deepEqual(
      parseConfirmedDates('<ok><room id="x"><date value="2026-06-10"/></room></ok>'),
      ['2026-06-10'],
    );
  });

  it('returns null when there is no ok element', () => {
    assert.equal(parseConfirmedDates('<something-else/>'), null);
  });

  it('extracts a fault message', () => {
    assert.equal(parseFault('<fault><faultstring>bad room</faultstring></fault>'), 'bad room');
  });

  it('finds no fault in a clean response', () => {
    assert.equal(parseFault('<ok/>'), null);
  });

  it('treats a 200 whose body is neither <ok> nor <fault> as malformed', async () => {
    // A real platform returning HTTP 200 with an unrecognised body must never be
    // read as an accepted update.
    const rogue = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/xml' });
        response.end('<surprise>not a contract we know</surprise>');
      }),
    );
    process.env.BOOKING_COM_API_BASE_URL = rogue.url;
    try {
      const outcome = await bookingComAdapter.submitUnavailability(req);
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.reasonCode, 'malformed_response');
      assert.match(outcome.reason ?? '', /neither <ok> nor <fault>/);
    } finally {
      delete process.env.BOOKING_COM_API_BASE_URL;
      await rogue.close();
    }
  });
});

describe('sameNights', () => {
  it('ignores ordering', () => {
    assert.ok(sameNights(['a', 'b'], ['b', 'a']));
  });
  it('detects a missing night', () => {
    assert.ok(!sameNights(['a', 'b'], ['a']));
  });
  it('detects an extra night', () => {
    assert.ok(!sameNights(['a'], ['a', 'b']));
  });
});
