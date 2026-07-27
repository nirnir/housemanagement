/**
 * HTTP application: the confirmed-booking webhook and the propagation status UI.
 *
 * Every route resolves a tenant from a credential before touching data. No route
 * accepts a tenant id as input, so a caller cannot choose the scope it operates
 * in — the webhook explicitly rejects an event whose `tenantId` disagrees with
 * the authenticated one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from '../db/index.ts';
import * as calendarRepo from '../db/calendar-repo.ts';
import { CrossTenantError, NotFoundError } from '../db/repo.ts';
import { InvalidDateError, InvalidStayError } from '../domain/dates.ts';
import { InvalidEventError, ingestBookingEvent, parseBookingEvent } from '../worker/ingest.ts';
import {
  InvalidCalendarEventError,
  ingestCalendarEvent,
  parseCalendarEvent,
} from '../worker/calendar-ingest.ts';
import { buildCalendarView } from '../worker/calendar-view.ts';
import { syncAvailabilityChange } from '../worker/calendar-sync.ts';
import type { PropagateOptions } from '../worker/propagate.ts';
import { buildPropagationView, listPropagationViews } from '../worker/view.ts';
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  parseCookies,
  sessionCookie,
  tenantForKey,
} from './auth.ts';
import {
  renderCalendar,
  renderChannels,
  renderDetail,
  renderError,
  renderList,
  renderSignIn,
} from './render.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(HERE, '..', 'ui', 'design-system.css');

export interface AppOptions {
  db: Db;
  /** api key → tenant id. Sourced from the environment, never from code. */
  tenantKeys: Map<string, string>;
  /** Forwarded to the propagation worker; lets tests shorten retry delays. */
  propagateOptions?: PropagateOptions;
  /** Configured single-property v1 calendar; falls back to the first scoped property. */
  defaultPropertyId?: string;
}

function readBody(request: IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('Request body too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

export function createApp(options: AppOptions): Server {
  const { db, tenantKeys } = options;
  const propagateOptions = options.propagateOptions ?? {};

  const html = (r: ServerResponse, s: number, b: string, h?: Record<string, string>) =>
    send(r, s, 'text/html; charset=utf-8', b, h);
  const json = (r: ServerResponse, s: number, value: unknown) =>
    send(r, s, 'application/json; charset=utf-8', JSON.stringify(value, null, 2));

  /** Tenant from the `x-api-key` header (machines) or the session cookie (UI). */
  const resolveTenant = (request: IncomingMessage): string | null => {
    const header = request.headers['x-api-key'];
    const presented =
      typeof header === 'string' ? header : parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return tenantForKey(presented, tenantKeys);
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/(.)\/+$/, '$1');
    const method = request.method ?? 'GET';

    if (path === '/healthz') return json(response, 200, { ok: true });

    if (path === '/assets/design-system.css' && method === 'GET') {
      return send(response, 200, 'text/css; charset=utf-8', readFileSync(CSS_PATH, 'utf8'));
    }

    /* ----------------------------------------------------------- session */

    if (path === '/signin' && method === 'GET') {
      return html(response, 200, renderSignIn());
    }

    if (path === '/signin' && method === 'POST') {
      const form = new URLSearchParams(await readBody(request));
      const key = form.get('apiKey') ?? '';
      if (!tenantForKey(key, tenantKeys)) {
        return html(response, 401, renderSignIn('That API key is not recognised.'));
      }
      return html(response, 303, '', { location: '/', 'set-cookie': sessionCookie(key) });
    }

    if (path === '/signout' && method === 'POST') {
      return html(response, 303, '', { location: '/signin', 'set-cookie': clearedSessionCookie() });
    }

    /* ----------------------------------------------------------- webhook */

    if (path === '/webhooks/bookings' && method === 'POST') {
      const tenantId = resolveTenant(request);
      if (!tenantId) return json(response, 401, { error: 'Unrecognised or missing API key.' });

      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        return json(response, 400, { error: 'Request body was not valid JSON.' });
      }

      try {
        const event = parseBookingEvent(payload);

        // The event may not nominate a tenant other than the authenticated one.
        if (event.tenantId !== tenantId) {
          return json(response, 403, {
            error: 'Event tenant does not match the authenticated tenant; refusing to propagate.',
          });
        }

        const result = await ingestBookingEvent(db, event, propagateOptions);
        return json(response, result.propagation.kind === 'processed' ? 200 : 202, {
          eventId: result.eventId,
          duplicateDelivery: result.duplicateDelivery,
          payloadChanged: result.payloadChanged,
          bookingId: result.bookingId,
          kind: result.propagation.kind,
          aggregateStatus: result.propagation.aggregateStatus,
          propagationId: result.propagation.propagationId,
          reason: result.propagation.reason,
          replay: result.propagation.replay,
          convergedChannels: result.propagation.convergedChannels,
          attempts: result.propagation.attempts.map((a) => ({
            channel: a.channel,
            status: a.status,
            reasonCode: a.reasonCode,
            reason: a.reason,
            nights: a.submittedNights.length,
            attemptCount: a.attemptCount,
          })),
        });
      } catch (error) {
        if (error instanceof InvalidEventError) return json(response, 400, { error: error.message });
        if (error instanceof CrossTenantError) return json(response, 403, { error: error.message });
        if (error instanceof NotFoundError) return json(response, 404, { error: error.message });
        // Defence in depth: a malformed date or stay is caller error, not a fault.
        if (error instanceof InvalidDateError || error instanceof InvalidStayError) {
          return json(response, 400, { error: error.message });
        }
        throw error;
      }
    }

    if (path === '/webhooks/calendar' && method === 'POST') {
      const tenantId = resolveTenant(request);
      if (!tenantId) return json(response, 401, { error: 'Unrecognised or missing API key.' });

      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        return json(response, 400, { error: 'Request body was not valid JSON.' });
      }

      try {
        const event = parseCalendarEvent(payload);
        if (event.tenantId !== tenantId) {
          return json(response, 403, {
            error: 'Event tenant does not match the authenticated tenant.',
          });
        }
        const result = await ingestCalendarEvent(db, event, propagateOptions);
        return json(response, result.outcome === 'conflict' ? 409 : 200, {
          eventId: result.eventId,
          duplicateDelivery: result.duplicateDelivery,
          payloadChanged: result.payloadChanged,
          outcome: result.outcome,
          recordId: result.record.id,
          lifecycleState: result.record.lifecycleState,
          conflictWithId: result.conflict?.id ?? null,
          releaseSync: result.releaseSync,
          blockSync: result.blockSync,
        });
      } catch (error) {
        if (error instanceof InvalidCalendarEventError) {
          return json(response, 400, { error: error.message });
        }
        if (error instanceof CrossTenantError) return json(response, 403, { error: error.message });
        if (error instanceof NotFoundError) return json(response, 404, { error: error.message });
        throw error;
      }
    }

    /* ---------------------------------------------------------------- UI */

    const tenantId = resolveTenant(request);
    if (!tenantId) {
      if (path.startsWith('/api/')) {
        return json(response, 401, { error: 'Unrecognised or missing API key.' });
      }
      return html(response, 303, '', { location: '/signin' });
    }

    if (path === '/' && method === 'GET') {
      const properties = calendarRepo.listProperties(db, tenantId);
      const property =
        properties.find((candidate) => candidate.id === options.defaultPropertyId) ?? properties[0];
      if (!property) return html(response, 404, renderError(404, 'No configured property.'));
      return html(response, 200, renderCalendar(buildCalendarView(db, tenantId, property.id)));
    }

    if (path === '/propagations' && method === 'GET') {
      return html(response, 200, renderList(listPropagationViews(db, tenantId, { limit: 50 })));
    }

    if (path === '/channels' && method === 'GET') {
      return html(response, 200, renderChannels());
    }

    const retryCalendar = /^\/calendar\/([\w-]+)\/records\/([\w-]+)\/retry$/.exec(path);
    if (retryCalendar?.[1] !== undefined && retryCalendar[2] !== undefined && method === 'POST') {
      try {
        const record = calendarRepo.requireAvailabilityRecord(
          db,
          tenantId,
          retryCalendar[1],
          retryCalendar[2],
        );
        const latest = calendarRepo.latestSyncForRecord(
          db,
          tenantId,
          retryCalendar[1],
          retryCalendar[2],
        );
        if (!latest) {
          return html(response, 409, renderError(409, 'This record has no sync operation to retry.'));
        }
        await syncAvailabilityChange(
          db,
          record,
          latest.sync.operation,
          latest.sync.nights,
          propagateOptions,
        );
        return html(response, 303, '', {
          location: `/calendar/${encodeURIComponent(record.propertyId)}`,
        });
      } catch (error) {
        if (error instanceof CrossTenantError || error instanceof NotFoundError) {
          return html(response, 404, renderError(404, 'No such calendar record.'));
        }
        if (error instanceof Error && /another tenant|not found/.test(error.message)) {
          return html(response, 404, renderError(404, 'No such calendar record.'));
        }
        throw error;
      }
    }

    const detail = /^\/propagations\/([\w-]+)$/.exec(path);
    if (detail?.[1] !== undefined && method === 'GET') {
      const view = buildPropagationView(db, tenantId, detail[1]);
      if (!view) {
        return html(response, 404, renderError(404, 'No such propagation for this tenant.'));
      }
      return html(response, 200, renderDetail(view));
    }

    const calendar = /^\/calendar\/([\w-]+)$/.exec(path);
    if (calendar?.[1] !== undefined && method === 'GET') {
      try {
        return html(response, 200, renderCalendar(buildCalendarView(db, tenantId, calendar[1])));
      } catch (error) {
        if (error instanceof CrossTenantError) {
          return html(response, 403, renderError(403, 'That property belongs to another tenant.'));
        }
        if (error instanceof NotFoundError) {
          return html(response, 404, renderError(404, 'No such property for this tenant.'));
        }
        throw error;
      }
    }

    const apiCalendar = /^\/api\/calendar\/([\w-]+)$/.exec(path);
    if (apiCalendar?.[1] !== undefined && method === 'GET') {
      try {
        return json(response, 200, buildCalendarView(db, tenantId, apiCalendar[1]));
      } catch (error) {
        if (error instanceof CrossTenantError || error instanceof NotFoundError) {
          return json(response, 404, { error: 'No such property for this tenant.' });
        }
        throw error;
      }
    }

    const apiDetail = /^\/api\/propagations\/([\w-]+)$/.exec(path);
    if (apiDetail?.[1] !== undefined && method === 'GET') {
      const view = buildPropagationView(db, tenantId, apiDetail[1]);
      if (!view) return json(response, 404, { error: 'No such propagation for this tenant.' });
      return json(response, 200, view);
    }

    if (path === '/api/propagations' && method === 'GET') {
      return json(response, 200, listPropagationViews(db, tenantId, { limit: 50 }));
    }

    return path.startsWith('/api/')
      ? json(response, 404, { error: 'Not found.' })
      : html(response, 404, renderError(404, 'Not found.'));
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error('[server] unhandled error', error);
      if (!response.headersSent) {
        send(response, 500, 'application/json', JSON.stringify({ error: 'Internal error.' }));
      } else {
        response.end();
      }
    });
  });
}
