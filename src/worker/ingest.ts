/**
 * Confirmed-booking ingestion.
 *
 * The entry point for booking events. Validates the payload, records the
 * delivery in a ledger so replays are observable, persists the booking on its
 * natural key, then hands off to the idempotent propagation worker.
 *
 * A replayed delivery is *not* short-circuited — it is re-processed through the
 * same idempotent path so convergence is demonstrated rather than assumed.
 */

import { createHash } from 'node:crypto';

import { parseCalendarDate } from '../domain/dates.ts';
import { isBookingState, isChannelKey } from '../domain/types.ts';
import type { BookingState, CalendarDate, ChannelKey } from '../domain/types.ts';
import type { Db } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import { propagateBooking, type PropagateOptions, type PropagateResult } from './propagate.ts';

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

export interface BookingEvent {
  /** Delivery identifier. Repeated deliveries share it. */
  eventId: string;
  tenantId: string;
  propertyId: string;
  sourceChannel: ChannelKey;
  externalBookingId: string;
  state: BookingState;
  checkIn: CalendarDate;
  checkOut: CalendarDate;
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEventError(`Field "${field}" is required and must be a non-empty string.`);
  }
  return value;
}

/** Wraps date-shape failures so the whole payload boundary raises one error type. */
function requireDate(source: Record<string, unknown>, field: string): CalendarDate {
  try {
    return parseCalendarDate(source[field]);
  } catch (error) {
    throw new InvalidEventError(
      `Field "${field}" is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseBookingEvent(raw: unknown): BookingEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidEventError('Event payload must be a JSON object.');
  }
  const source = raw as Record<string, unknown>;

  const sourceChannel = source.sourceChannel;
  if (!isChannelKey(sourceChannel)) {
    throw new InvalidEventError(
      `Field "sourceChannel" must be one of airbnb, booking_com, vrbo, homeexchange (received ${JSON.stringify(sourceChannel)}).`,
    );
  }

  const state = source.state;
  if (!isBookingState(state)) {
    throw new InvalidEventError(
      `Field "state" must be a known booking state (received ${JSON.stringify(state)}). Unknown states are never treated as confirmed.`,
    );
  }

  return {
    eventId: requireString(source, 'eventId'),
    tenantId: requireString(source, 'tenantId'),
    propertyId: requireString(source, 'propertyId'),
    sourceChannel,
    externalBookingId: requireString(source, 'externalBookingId'),
    state,
    checkIn: requireDate(source, 'checkIn'),
    checkOut: requireDate(source, 'checkOut'),
  };
}

export function payloadHash(event: BookingEvent): string {
  const canonical = [
    event.tenantId,
    event.propertyId,
    event.sourceChannel,
    event.externalBookingId,
    event.state,
    event.checkIn,
    event.checkOut,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export interface IngestResult {
  eventId: string;
  /** True when this event id has been delivered before. */
  duplicateDelivery: boolean;
  /** True when a prior delivery of this id carried different booking data. */
  payloadChanged: boolean;
  bookingId: string;
  propagation: PropagateResult;
}

export async function ingestBookingEvent(
  db: Db,
  event: BookingEvent,
  options: PropagateOptions = {},
): Promise<IngestResult> {
  // Scoping is proven before the booking is written, not after.
  repo.requireProperty(db, event.tenantId, event.propertyId);

  const hash = payloadHash(event);
  const prior = repo.findIngestEvent(db, event.eventId);

  if (prior && prior.tenantId !== event.tenantId) {
    throw new repo.CrossTenantError(
      `Event ${event.eventId} was already delivered for another tenant.`,
    );
  }

  const booking = repo.upsertBooking(db, {
    tenantId: event.tenantId,
    propertyId: event.propertyId,
    sourceChannel: event.sourceChannel,
    externalBookingId: event.externalBookingId,
    state: event.state,
    checkIn: event.checkIn,
    checkOut: event.checkOut,
  });

  const propagation = await propagateBooking(db, event.tenantId, booking.id, options);

  repo.recordIngestEvent(db, {
    eventId: event.eventId,
    tenantId: event.tenantId,
    payloadHash: hash,
    bookingId: booking.id,
    outcome: propagation.kind,
  });

  return {
    eventId: event.eventId,
    duplicateDelivery: prior !== null,
    payloadChanged: prior !== null && prior.payloadHash !== hash,
    bookingId: booking.id,
    propagation,
  };
}
