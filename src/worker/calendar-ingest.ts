/**
 * Idempotent lifecycle ingestion for bookings, holds, cancellations and owner
 * blocks. Overlap detection and the canonical write are one IMMEDIATE
 * transaction so near-simultaneous occupied intervals cannot both win.
 */

import { createHash } from 'node:crypto';

import * as calendarRepo from '../db/calendar-repo.ts';
import type { Db } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import { compareDates, deriveNights, parseCalendarDate } from '../domain/dates.ts';
import { isChannelKey } from '../domain/types.ts';
import type {
  AvailabilityKind,
  AvailabilityRecord,
  AvailabilitySource,
  BookingState,
  CalendarDate,
} from '../domain/types.ts';
import {
  syncAvailabilityChange,
  type CalendarSyncOptions,
  type CalendarSyncResult,
} from './calendar-sync.ts';

export type CalendarEventState =
  | 'confirmed'
  | 'hold'
  | 'tentative'
  | 'cancelled'
  | 'owner_block';

export interface CalendarEvent {
  eventId: string;
  tenantId: string;
  propertyId: string;
  source: AvailabilitySource;
  externalRecordId: string;
  state: CalendarEventState;
  checkIn: CalendarDate;
  checkOut: CalendarDate;
}

export class InvalidCalendarEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCalendarEventError';
  }
}

function required(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidCalendarEventError(`Field "${key}" is required.`);
  }
  return value;
}

export function parseCalendarEvent(raw: unknown): CalendarEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidCalendarEventError('Calendar event must be a JSON object.');
  }
  const value = raw as Record<string, unknown>;
  const source = value.source;
  if (source !== 'owner' && !isChannelKey(source)) {
    throw new InvalidCalendarEventError(
      'Field "source" must be airbnb, booking_com, vrbo, homeexchange, or owner.',
    );
  }
  const state = value.state;
  if (
    state !== 'confirmed' &&
    state !== 'hold' &&
    state !== 'tentative' &&
    state !== 'cancelled' &&
    state !== 'owner_block'
  ) {
    throw new InvalidCalendarEventError('Field "state" is not a supported lifecycle state.');
  }
  if (source === 'owner' && state !== 'owner_block' && state !== 'cancelled') {
    throw new InvalidCalendarEventError('Owner events must be owner_block or cancelled.');
  }
  try {
    const checkIn = parseCalendarDate(value.checkIn);
    const checkOut = parseCalendarDate(value.checkOut);
    if (compareDates(checkIn, checkOut) >= 0) {
      throw new InvalidCalendarEventError('checkOut must be after checkIn.');
    }
    return {
      eventId: required(value, 'eventId'),
      tenantId: required(value, 'tenantId'),
      propertyId: required(value, 'propertyId'),
      source,
      externalRecordId: required(value, 'externalRecordId'),
      state,
      checkIn,
      checkOut,
    };
  } catch (error) {
    if (error instanceof InvalidCalendarEventError) throw error;
    throw new InvalidCalendarEventError(
      error instanceof Error ? error.message : 'Calendar dates are invalid.',
    );
  }
}

function hashEvent(event: CalendarEvent): string {
  return createHash('sha256')
    .update(
      [
        event.tenantId,
        event.propertyId,
        event.source,
        event.externalRecordId,
        event.state,
        event.checkIn,
        event.checkOut,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 32);
}

function kindFor(event: CalendarEvent, existing: AvailabilityRecord | null): AvailabilityKind {
  if (event.state === 'owner_block') return 'owner_block';
  if (event.state === 'hold' || event.state === 'tentative') return 'hold';
  return existing?.recordKind ?? 'booking';
}

function bookingStateFor(state: CalendarEventState): BookingState {
  if (state === 'owner_block') return 'hold';
  return state;
}

export interface CalendarIngestResult {
  eventId: string;
  duplicateDelivery: boolean;
  payloadChanged: boolean;
  outcome: 'accepted' | 'conflict' | 'cancelled';
  record: AvailabilityRecord;
  conflict: AvailabilityRecord | null;
  releaseSync: CalendarSyncResult | null;
  blockSync: CalendarSyncResult | null;
}

export async function ingestCalendarEvent(
  db: Db,
  event: CalendarEvent,
  options: CalendarSyncOptions = {},
): Promise<CalendarIngestResult> {
  repo.requireProperty(db, event.tenantId, event.propertyId);
  const hash = hashEvent(event);
  const priorEvent = calendarRepo.findCalendarEvent(db, event.eventId);
  if (
    priorEvent &&
    (priorEvent.tenantId !== event.tenantId || priorEvent.propertyId !== event.propertyId)
  ) {
    throw new repo.CrossTenantError(`Event ${event.eventId} belongs to another scope.`);
  }

  let previous: AvailabilityRecord | null = null;
  let conflict: AvailabilityRecord | null = null;
  let record!: AvailabilityRecord;
  let outcome: CalendarIngestResult['outcome'] = 'accepted';

  db.exec('BEGIN IMMEDIATE');
  try {
    previous = calendarRepo.findAvailabilityByIdentity(
      db,
      event.tenantId,
      event.propertyId,
      event.source,
      event.externalRecordId,
    );

    if (event.state !== 'cancelled') {
      conflict = calendarRepo.findOverlap(db, {
        tenantId: event.tenantId,
        propertyId: event.propertyId,
        checkIn: event.checkIn,
        checkOut: event.checkOut,
        excludeRecordId: previous?.id,
      });
    }

    let bookingId: string | null = previous?.bookingId ?? null;
    if (event.source !== 'owner') {
      bookingId = repo.upsertBooking(db, {
        tenantId: event.tenantId,
        propertyId: event.propertyId,
        sourceChannel: event.source,
        externalBookingId: event.externalRecordId,
        state: bookingStateFor(event.state),
        checkIn: event.checkIn,
        checkOut: event.checkOut,
      }).id;
    }

    outcome =
      event.state === 'cancelled' ? 'cancelled' : conflict !== null ? 'conflict' : 'accepted';
    record = calendarRepo.upsertAvailabilityRecord(db, {
      tenantId: event.tenantId,
      propertyId: event.propertyId,
      bookingId,
      source: event.source,
      externalRecordId: event.externalRecordId,
      recordKind: kindFor(event, previous),
      lifecycleState:
        event.state === 'cancelled' ? 'cancelled' : conflict !== null ? 'conflict' : 'active',
      checkIn: event.checkIn,
      checkOut: event.checkOut,
      providerEventId: event.eventId,
      conflictWithId: conflict?.id ?? null,
    });
    calendarRepo.recordCalendarEvent(db, {
      eventId: event.eventId,
      tenantId: event.tenantId,
      propertyId: event.propertyId,
      payloadHash: hash,
      availabilityRecordId: record.id,
      outcome,
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  let releaseSync: CalendarSyncResult | null = null;
  let blockSync: CalendarSyncResult | null = null;
  if (outcome === 'cancelled') {
    releaseSync = await syncAvailabilityChange(
      db,
      record,
      'release',
      deriveNights(previous?.checkIn ?? event.checkIn, previous?.checkOut ?? event.checkOut),
      options,
    );
  } else if (outcome === 'accepted') {
    if (
      previous?.lifecycleState === 'active' &&
      (previous.checkIn !== event.checkIn || previous.checkOut !== event.checkOut)
    ) {
      releaseSync = await syncAvailabilityChange(
        db,
        record,
        'release',
        deriveNights(previous.checkIn, previous.checkOut),
        options,
      );
    }
    blockSync = await syncAvailabilityChange(
      db,
      record,
      'block',
      deriveNights(event.checkIn, event.checkOut),
      options,
    );
  }

  return {
    eventId: event.eventId,
    duplicateDelivery: priorEvent !== null,
    payloadChanged: priorEvent !== null && priorEvent.payloadHash !== hash,
    outcome,
    record,
    conflict,
    releaseSync,
    blockSync,
  };
}
