/**
 * Channel conformance server.
 *
 * Speaks each destination platform's request/response contract as this
 * repository models it — per-night JSON for Airbnb, ranges for Vrbo, XML for
 * Booking.com, a flat date list for HomeExchange — including credential
 * checking, rejections, rate limiting and timeouts.
 *
 * WHY THIS EXISTS: live availability-write access for Airbnb, Booking.com and
 * Vrbo is gated behind partner-programme approval that this repository cannot
 * create. This server lets the entire propagation path be exercised for real
 * against the modelled contracts. It is NOT a mock inside the test process —
 * it is a separate process reached over real HTTP with real credentials, so
 * only the remote hostname is substituted. Pointing a channel at production
 * means setting its `*_API_BASE_URL` variable; nothing else changes.
 *
 * Behaviour is selected by a suffix on the listing id, so a scenario can be set
 * up purely through connection data:
 *   `-timeout`   never responds in time
 *   `-ratelimit` HTTP 429 with Retry-After
 *   `-reject`    platform-level rejection in that platform's own idiom
 *   `-partial`   success status confirming fewer nights than requested
 *   `-conflict`  HTTP 409, an overlapping reservation
 *   `-unsupported` HTTP 501
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { expandRanges, type DateRange } from '../channels/vrbo.ts';

type Behaviour =
  | 'ok'
  | 'timeout'
  | 'ratelimit'
  | 'reject'
  | 'partial'
  | 'conflict'
  | 'unsupported';

function behaviourFor(listingId: string): Behaviour {
  if (listingId.endsWith('-timeout')) return 'timeout';
  if (listingId.endsWith('-ratelimit')) return 'ratelimit';
  if (listingId.endsWith('-reject')) return 'reject';
  if (listingId.endsWith('-partial')) return 'partial';
  if (listingId.endsWith('-conflict')) return 'conflict';
  if (listingId.endsWith('-unsupported')) return 'unsupported';
  return 'ok';
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function reply(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': contentType, ...headers });
  response.end(body);
}

/** Shared non-success handling. Returns true when the request was answered. */
function handleCommonBehaviour(
  behaviour: Behaviour,
  response: ServerResponse,
  contentType: string,
  bodies: { conflict: string; unsupported: string; ratelimit: string },
): boolean {
  switch (behaviour) {
    case 'timeout':
      // Deliberately never respond; the adapter's AbortController fires.
      return true;
    case 'ratelimit':
      reply(response, 429, contentType, bodies.ratelimit, { 'retry-after': '30' });
      return true;
    case 'conflict':
      reply(response, 409, contentType, bodies.conflict);
      return true;
    case 'unsupported':
      reply(response, 501, contentType, bodies.unsupported);
      return true;
    default:
      return false;
  }
}

function requireAuth(request: IncomingMessage, response: ServerResponse, contentType: string): boolean {
  const authorized =
    typeof request.headers.authorization === 'string' ||
    typeof request.headers['x-api-key'] === 'string';
  if (!authorized) {
    reply(response, 401, contentType, '{"error":"missing credential"}');
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ Airbnb */

async function airbnb(
  request: IncomingMessage,
  response: ServerResponse,
  listingId: string,
): Promise<void> {
  const ct = 'application/json';
  if (!requireAuth(request, response, ct)) return;

  const behaviour = behaviourFor(listingId);
  if (
    handleCommonBehaviour(behaviour, response, ct, {
      conflict: '{"error":"overlapping reservation"}',
      unsupported: '{"error":"availability writes not enabled for this listing"}',
      ratelimit: '{"error":"rate limited"}',
    })
  ) {
    return;
  }

  const body = JSON.parse(await readBody(request)) as {
    operations?: { date?: string; availability_type?: string }[];
  };
  const dates = (body.operations ?? [])
    .map((op) => op.date)
    .filter((d): d is string => typeof d === 'string');
  const type = body.operations?.[0]?.availability_type ?? 'unavailable';

  if (behaviour === 'reject') {
    return reply(response, 422, ct, JSON.stringify({ error: 'date range not permitted for this listing' }));
  }

  const confirmed = behaviour === 'partial' ? dates.slice(0, Math.max(0, dates.length - 1)) : dates;
  reply(
    response,
    200,
    ct,
    JSON.stringify({ calendar: { updated_dates: confirmed }, availability_type: type }),
  );
}

/* ------------------------------------------------------------- Booking.com */

async function bookingCom(
  request: IncomingMessage,
  response: ServerResponse,
  listingId: string,
): Promise<void> {
  const ct = 'application/xml';
  if (!requireAuth(request, response, ct)) return;

  const behaviour = behaviourFor(listingId);
  if (
    handleCommonBehaviour(behaviour, response, ct, {
      conflict: '<fault><faultstring>overlapping reservation</faultstring></fault>',
      unsupported: '<fault><faultstring>availability writes not enabled</faultstring></fault>',
      ratelimit: '<fault><faultstring>rate limited</faultstring></fault>',
    })
  ) {
    return;
  }

  const xml = await readBody(request);
  const dates: string[] = [];
  const pattern = /<date\s+value="([^"]+)"/g;
  let match = pattern.exec(xml);
  while (match !== null) {
    if (match[1] !== undefined) dates.push(match[1]);
    match = pattern.exec(xml);
  }

  if (behaviour === 'reject') {
    // Booking.com reports application-level rejection inside a 200 response.
    return reply(
      response,
      200,
      ct,
      '<fault><faultstring>room closed period conflicts with an existing restriction</faultstring><code>1004</code></fault>',
    );
  }

  const confirmed = behaviour === 'partial' ? dates.slice(0, Math.max(0, dates.length - 1)) : dates;
  reply(
    response,
    200,
    ct,
    `<ok><room id="${listingId}">${confirmed
      .map((d) => `<date value="${d}"/>`)
      .join('')}</room></ok>`,
  );
}

/* -------------------------------------------------------------------- Vrbo */

async function vrbo(
  request: IncomingMessage,
  response: ServerResponse,
  listingId: string,
): Promise<void> {
  const ct = 'application/json';
  if (!requireAuth(request, response, ct)) return;

  const behaviour = behaviourFor(listingId);
  if (
    handleCommonBehaviour(behaviour, response, ct, {
      conflict: '{"status":"CONFLICT","message":"overlapping reservation"}',
      unsupported: '{"status":"UNSUPPORTED"}',
      ratelimit: '{"status":"THROTTLED"}',
    })
  ) {
    return;
  }

  const body = JSON.parse(await readBody(request)) as {
    blocks?: { startDate?: string; endDate?: string; type?: string }[];
  };
  const ranges: DateRange[] = (body.blocks ?? [])
    .filter(
      (b): b is { startDate: string; endDate: string; type?: string } =>
        typeof b.startDate === 'string' && typeof b.endDate === 'string',
    )
    .map((b) => ({ startDate: b.startDate, endDate: b.endDate }));
  const nights = expandRanges(ranges);

  if (behaviour === 'reject') {
    return reply(
      response,
      200,
      ct,
      JSON.stringify({ status: 'DECLINED', message: 'block type not accepted for this listing' }),
    );
  }

  const confirmed = behaviour === 'partial' ? nights.slice(0, Math.max(0, nights.length - 1)) : nights;
  reply(
    response,
    200,
    ct,
    JSON.stringify({
      status: 'CONFIRMED',
      blockedDates: confirmed,
      bookingType: body.blocks?.[0]?.type ?? 'RESERVED',
    }),
  );
}

/* ------------------------------------------------------------ HomeExchange */

async function homeExchange(
  request: IncomingMessage,
  response: ServerResponse,
  listingId: string,
): Promise<void> {
  const ct = 'application/json';
  if (!requireAuth(request, response, ct)) return;

  const behaviour = behaviourFor(listingId);
  if (
    handleCommonBehaviour(behaviour, response, ct, {
      conflict: '{"ok":false,"reason":"overlapping exchange"}',
      unsupported: '{"ok":false,"reason":"unsupported"}',
      ratelimit: '{"ok":false,"reason":"rate limited"}',
    })
  ) {
    return;
  }

  const body = JSON.parse(await readBody(request)) as {
    unavailable_dates?: unknown;
    available_dates?: unknown;
  };
  const requested = Array.isArray(body.available_dates) && body.available_dates.length > 0
    ? body.available_dates
    : body.unavailable_dates;
  const dates = Array.isArray(requested)
    ? requested.filter((d): d is string => typeof d === 'string')
    : [];

  if (behaviour === 'reject') {
    return reply(response, 200, ct, JSON.stringify({ ok: false, reason: 'member calendar is locked' }));
  }

  const confirmed = behaviour === 'partial' ? dates.slice(0, Math.max(0, dates.length - 1)) : dates;
  reply(response, 200, ct, JSON.stringify({ ok: true, unavailable: confirmed }));
}

/* ----------------------------------------------------------------- router */

const ROUTES: { pattern: RegExp; handler: typeof airbnb }[] = [
  { pattern: /^\/airbnb\/v2\/calendars\/([^/]+)\/availability$/, handler: airbnb },
  { pattern: /^\/booking_com\/xml\/availability\/([^/]+)$/, handler: bookingCom },
  { pattern: /^\/vrbo\/v1\/listings\/([^/]+)\/calendar$/, handler: vrbo },
  { pattern: /^\/homeexchange\/api\/v1\/homes\/([^/]+)\/availability$/, handler: homeExchange },
];

export function createConformanceServer(): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (path === '/healthz') {
      return reply(response, 200, 'application/json', '{"ok":true}');
    }

    for (const { pattern, handler } of ROUTES) {
      const match = pattern.exec(path);
      const listingId = match?.[1];
      if (listingId !== undefined) {
        handler(request, response, decodeURIComponent(listingId)).catch((error: unknown) => {
          console.error('[conformance] handler error', error);
          if (!response.headersSent) reply(response, 500, 'application/json', '{"error":"internal"}');
        });
        return;
      }
    }

    reply(response, 404, 'application/json', '{"error":"no such platform route"}');
  });
}
