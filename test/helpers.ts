/** Shared test fixtures: in-memory databases and real listening servers. */

import type { AddressInfo, Server } from 'node:net';

import { createConformanceServer } from '../src/conformance/app.ts';
import { openTestDatabase, type Db } from '../src/db/index.ts';
import * as repo from '../src/db/repo.ts';
import type { ChannelKey } from '../src/domain/types.ts';
import type { AvailabilityOutcome, ChannelAdapter } from '../src/channels/contract.ts';

export interface Listening {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function listen(server: Server): Promise<Listening> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Starts the conformance server and points every channel at it by setting
 * CONFORMANCE_BASE_URL, so adapters make real HTTP calls during the test.
 */
export async function startConformance(): Promise<Listening> {
  const handle = await listen(createConformanceServer());
  process.env.CONFORMANCE_BASE_URL = handle.url;
  return handle;
}

/** Development credentials so adapters have something real to present. */
export function setTestCredentials(): void {
  process.env.AIRBNB_API_TOKEN = 'test-airbnb-token';
  process.env.BOOKING_COM_API_TOKEN = 'test-booking-token';
  process.env.VRBO_API_TOKEN = 'test-vrbo-token';
  process.env.HOMEEXCHANGE_API_TOKEN = 'test-homeexchange-token';
}

export interface ConnectionSpec {
  channel: ChannelKey;
  listingId: string;
  required?: boolean;
  enabled?: boolean;
}

export interface Fixture {
  db: Db;
  tenantId: string;
  propertyId: string;
}

export function seedFixture(
  options: {
    db?: Db;
    tenantId?: string;
    propertyId?: string;
    propertyName?: string;
    timezone?: string;
    connections?: ConnectionSpec[];
  } = {},
): Fixture {
  const db = options.db ?? openTestDatabase();
  const tenantId = options.tenantId ?? 'tenant-a';
  const propertyId = options.propertyId ?? 'prop-a';

  repo.createTenant(db, `Tenant ${tenantId}`, tenantId);
  repo.createProperty(db, {
    id: propertyId,
    tenantId,
    name: options.propertyName ?? 'Harbour Cottage',
    timezone: options.timezone ?? 'Europe/Amsterdam',
  });

  for (const spec of options.connections ?? []) {
    repo.createConnection(db, {
      tenantId,
      propertyId,
      channel: spec.channel,
      externalListingId: spec.listingId,
      required: spec.required ?? true,
      enabled: spec.enabled ?? true,
    });
  }

  return { db, tenantId, propertyId };
}

/** Adds a second tenant with its own property, for isolation checks. */
export function addTenant(db: Db, tenantId: string, propertyId: string): void {
  repo.createTenant(db, `Tenant ${tenantId}`, tenantId);
  repo.createProperty(db, { id: propertyId, tenantId, name: 'Other Property', timezone: 'UTC' });
}

export interface StubAdapter extends ChannelAdapter {
  /** Every request the worker made, in order. */
  calls: {
    nights: string[];
    idempotencyKey: string;
    bookingType: string;
    operation: 'block' | 'release';
  }[];
}

/** An adapter that returns a fixed outcome and records what it was asked to do. */
export function stubAdapter(
  channel: ChannelKey,
  outcome: Partial<AvailabilityOutcome> & Pick<AvailabilityOutcome, 'status'>,
): StubAdapter {
  const calls: StubAdapter['calls'] = [];
  return {
    channel,
    calls,
    describeTarget: (listingId) => `stub://${channel}/${listingId}`,
    submitUnavailability: (request) => {
      calls.push({
        nights: request.nights,
        idempotencyKey: request.idempotencyKey,
        bookingType: request.bookingType,
        operation: request.operation ?? 'block',
      });
      return Promise.resolve({
        reason: null,
        reasonCode: null,
        mappedBookingType: outcome.status === 'succeeded' ? request.bookingType : null,
        confirmedNights: outcome.status === 'succeeded' ? request.nights : [],
        latencyMs: 5,
        retryable: false,
        ...outcome,
      });
    },
  };
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}
