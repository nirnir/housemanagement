/**
 * Tenant-scoped repositories.
 *
 * Every read and write in this module takes an explicit `tenantId` and carries
 * it into the SQL predicate. Lookups by primary key additionally verify the
 * owning tenant and property and throw `CrossTenantError` on mismatch, so an
 * id guessed or leaked from another tenant is rejected before any availability
 * data is read or written.
 */

import { randomUUID } from 'node:crypto';

import type { Db } from './index.ts';
import { isChannelKey, isBookingState } from '../domain/types.ts';
import type {
  AttemptStatus,
  Booking,
  CalendarDate,
  ChannelConnection,
  ChannelKey,
  Propagation,
  PropagationAttempt,
  Property,
} from '../domain/types.ts';

export class CrossTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossTenantError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseNights(raw: unknown): CalendarDate[] {
  if (typeof raw !== 'string' || raw === '') return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function requireChannel(value: unknown): ChannelKey {
  if (!isChannelKey(value)) throw new Error(`Unknown channel persisted: ${String(value)}`);
  return value;
}

/* ------------------------------------------------------------------ tenants */

export function createTenant(
  db: Db,
  name: string,
  id: string = randomUUID(),
): { id: string; name: string } {
  db.prepare('INSERT INTO tenant (id, name) VALUES (?, ?)').run(id, name);
  return { id, name };
}

/* --------------------------------------------------------------- properties */

export function createProperty(
  db: Db,
  input: { tenantId: string; name: string; timezone?: string; id?: string },
): Property {
  const property: Property = {
    id: input.id ?? randomUUID(),
    tenantId: input.tenantId,
    name: input.name,
    timezone: input.timezone ?? 'UTC',
  };
  db.prepare(
    'INSERT INTO property (id, tenant_id, name, timezone) VALUES (?, ?, ?, ?)',
  ).run(property.id, property.tenantId, property.name, property.timezone);
  return property;
}

/** Tenant-filtered. Returns null when the property does not exist for this tenant. */
export function findProperty(db: Db, tenantId: string, propertyId: string): Property | null {
  const row = db
    .prepare('SELECT id, tenant_id, name, timezone FROM property WHERE id = ? AND tenant_id = ?')
    .get(propertyId, tenantId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: asString(row.id),
    tenantId: asString(row.tenant_id),
    name: asString(row.name),
    timezone: asString(row.timezone),
  };
}

/**
 * Resolves a property and rejects a cross-tenant reference explicitly, so the
 * caller can distinguish "no such property" from "not yours".
 */
export function requireProperty(db: Db, tenantId: string, propertyId: string): Property {
  const scoped = findProperty(db, tenantId, propertyId);
  if (scoped) return scoped;

  const exists = db
    .prepare('SELECT tenant_id FROM property WHERE id = ?')
    .get(propertyId) as Record<string, unknown> | undefined;

  if (exists) {
    throw new CrossTenantError(
      `Property ${propertyId} belongs to another tenant; refusing to read or write its availability.`,
    );
  }
  throw new NotFoundError(`Property ${propertyId} not found for tenant ${tenantId}.`);
}

/* -------------------------------------------------------------- connections */

export function createConnection(
  db: Db,
  input: {
    tenantId: string;
    propertyId: string;
    channel: ChannelKey;
    externalListingId: string;
    enabled?: boolean;
    required?: boolean;
    credentialRef?: string;
    id?: string;
  },
): ChannelConnection {
  const connection: ChannelConnection = {
    id: input.id ?? randomUUID(),
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    channel: input.channel,
    externalListingId: input.externalListingId,
    enabled: input.enabled ?? true,
    required: input.required ?? true,
    credentialRef: input.credentialRef ?? `${input.channel.toUpperCase()}_API_TOKEN`,
  };
  db.prepare(
    `INSERT INTO channel_connection
       (id, tenant_id, property_id, channel, external_listing_id, enabled, required, credential_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connection.id,
    connection.tenantId,
    connection.propertyId,
    connection.channel,
    connection.externalListingId,
    connection.enabled ? 1 : 0,
    connection.required ? 1 : 0,
    connection.credentialRef,
  );
  return connection;
}

function mapConnection(row: Record<string, unknown>): ChannelConnection {
  return {
    id: asString(row.id),
    tenantId: asString(row.tenant_id),
    propertyId: asString(row.property_id),
    channel: requireChannel(row.channel),
    externalListingId: asString(row.external_listing_id),
    enabled: asNumber(row.enabled) === 1,
    required: asNumber(row.required) === 1,
    credentialRef: asString(row.credential_ref),
    syncStatus:
      typeof row.sync_status === 'string'
        ? (row.sync_status as ChannelConnection['syncStatus'])
        : undefined,
    lastAttemptAt: asNullableString(row.last_attempt_at),
    lastSuccessfulSyncAt: asNullableString(row.last_successful_sync_at),
    lastSyncError: asNullableString(row.last_sync_error),
  };
}

export function listConnections(
  db: Db,
  tenantId: string,
  propertyId: string,
  options: { enabledOnly?: boolean } = {},
): ChannelConnection[] {
  const sql = `SELECT * FROM channel_connection
               WHERE tenant_id = ? AND property_id = ?
               ${options.enabledOnly ? 'AND enabled = 1' : ''}
               ORDER BY channel`;
  const rows = db.prepare(sql).all(tenantId, propertyId) as Record<string, unknown>[];
  return rows.map(mapConnection);
}

/* ------------------------------------------------------------------ bookings */

function mapBooking(row: Record<string, unknown>): Booking {
  const state = row.state;
  if (!isBookingState(state)) throw new Error(`Unknown booking state persisted: ${String(state)}`);
  return {
    id: asString(row.id),
    tenantId: asString(row.tenant_id),
    propertyId: asString(row.property_id),
    sourceChannel: requireChannel(row.source_channel),
    externalBookingId: asString(row.external_booking_id),
    state,
    checkIn: asString(row.check_in),
    checkOut: asString(row.check_out),
    receivedAt: asString(row.received_at),
  };
}

/**
 * Upserts on the natural key (tenant, source channel, external booking id) so a
 * redelivered booking updates the existing row instead of creating a twin.
 */
export function upsertBooking(
  db: Db,
  input: Omit<Booking, 'id' | 'receivedAt'> & { id?: string; receivedAt?: string },
): Booking {
  const existing = db
    .prepare(
      `SELECT * FROM booking
       WHERE tenant_id = ? AND source_channel = ? AND external_booking_id = ?`,
    )
    .get(input.tenantId, input.sourceChannel, input.externalBookingId) as
    | Record<string, unknown>
    | undefined;

  if (existing) {
    const id = asString(existing.id);
    db.prepare(
      `UPDATE booking SET property_id = ?, state = ?, check_in = ?, check_out = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(input.propertyId, input.state, input.checkIn, input.checkOut, id, input.tenantId);
    return mapBooking({ ...existing, property_id: input.propertyId, state: input.state, check_in: input.checkIn, check_out: input.checkOut });
  }

  const booking: Booking = {
    id: input.id ?? randomUUID(),
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    sourceChannel: input.sourceChannel,
    externalBookingId: input.externalBookingId,
    state: input.state,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    receivedAt: input.receivedAt ?? nowIso(),
  };
  db.prepare(
    `INSERT INTO booking
       (id, tenant_id, property_id, source_channel, external_booking_id, state, check_in, check_out, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    booking.id,
    booking.tenantId,
    booking.propertyId,
    booking.sourceChannel,
    booking.externalBookingId,
    booking.state,
    booking.checkIn,
    booking.checkOut,
    booking.receivedAt,
  );
  return booking;
}

export function findBooking(db: Db, tenantId: string, bookingId: string): Booking | null {
  const row = db
    .prepare('SELECT * FROM booking WHERE id = ? AND tenant_id = ?')
    .get(bookingId, tenantId) as Record<string, unknown> | undefined;
  return row ? mapBooking(row) : null;
}

export function requireBooking(db: Db, tenantId: string, bookingId: string): Booking {
  const scoped = findBooking(db, tenantId, bookingId);
  if (scoped) return scoped;
  const exists = db.prepare('SELECT tenant_id FROM booking WHERE id = ?').get(bookingId);
  if (exists) {
    throw new CrossTenantError(`Booking ${bookingId} belongs to another tenant.`);
  }
  throw new NotFoundError(`Booking ${bookingId} not found for tenant ${tenantId}.`);
}

/* -------------------------------------------------------------- propagations */

function mapPropagation(row: Record<string, unknown>): Propagation {
  return {
    id: asString(row.id),
    tenantId: asString(row.tenant_id),
    propertyId: asString(row.property_id),
    bookingId: asString(row.booking_id),
    idempotencyKey: asString(row.idempotency_key),
    derivedNights: parseNights(row.derived_nights),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

/**
 * Finds-or-creates the propagation for an idempotency key. The `created` flag
 * lets the caller tell a first run from a replay without a second query.
 */
export function upsertPropagation(
  db: Db,
  input: {
    tenantId: string;
    propertyId: string;
    bookingId: string;
    idempotencyKey: string;
    derivedNights: CalendarDate[];
  },
): { propagation: Propagation; created: boolean } {
  const existing = db
    .prepare('SELECT * FROM propagation WHERE idempotency_key = ? AND tenant_id = ?')
    .get(input.idempotencyKey, input.tenantId) as Record<string, unknown> | undefined;

  if (existing) {
    const updatedAt = nowIso();
    db.prepare(
      'UPDATE propagation SET derived_nights = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
    ).run(JSON.stringify(input.derivedNights), updatedAt, asString(existing.id), input.tenantId);
    return {
      propagation: mapPropagation({
        ...existing,
        derived_nights: JSON.stringify(input.derivedNights),
        updated_at: updatedAt,
      }),
      created: false,
    };
  }

  // A key held by another tenant must never be adopted.
  const foreign = db
    .prepare('SELECT tenant_id FROM propagation WHERE idempotency_key = ?')
    .get(input.idempotencyKey) as Record<string, unknown> | undefined;
  if (foreign) {
    throw new CrossTenantError(
      `Propagation key ${input.idempotencyKey} is owned by another tenant.`,
    );
  }

  const timestamp = nowIso();
  const propagation: Propagation = {
    id: randomUUID(),
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    bookingId: input.bookingId,
    idempotencyKey: input.idempotencyKey,
    derivedNights: input.derivedNights,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.prepare(
    `INSERT INTO propagation
       (id, tenant_id, property_id, booking_id, idempotency_key, derived_nights, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    propagation.id,
    propagation.tenantId,
    propagation.propertyId,
    propagation.bookingId,
    propagation.idempotencyKey,
    JSON.stringify(propagation.derivedNights),
    propagation.createdAt,
    propagation.updatedAt,
  );
  return { propagation, created: true };
}

export function findPropagationByKey(
  db: Db,
  tenantId: string,
  idempotencyKey: string,
): Propagation | null {
  const row = db
    .prepare('SELECT * FROM propagation WHERE idempotency_key = ? AND tenant_id = ?')
    .get(idempotencyKey, tenantId) as Record<string, unknown> | undefined;
  return row ? mapPropagation(row) : null;
}

export function findPropagation(db: Db, tenantId: string, id: string): Propagation | null {
  const row = db
    .prepare('SELECT * FROM propagation WHERE id = ? AND tenant_id = ?')
    .get(id, tenantId) as Record<string, unknown> | undefined;
  return row ? mapPropagation(row) : null;
}

export function listPropagations(db: Db, tenantId: string, propertyId?: string): Propagation[] {
  const rows = propertyId
    ? (db
        .prepare(
          'SELECT * FROM propagation WHERE tenant_id = ? AND property_id = ? ORDER BY created_at DESC',
        )
        .all(tenantId, propertyId) as Record<string, unknown>[])
    : (db
        .prepare('SELECT * FROM propagation WHERE tenant_id = ? ORDER BY created_at DESC')
        .all(tenantId) as Record<string, unknown>[]);
  return rows.map(mapPropagation);
}

/* ------------------------------------------------------------------ attempts */

function mapAttempt(row: Record<string, unknown>): PropagationAttempt {
  const status = asString(row.status) as AttemptStatus;
  return {
    id: asString(row.id),
    propagationId: asString(row.propagation_id),
    tenantId: asString(row.tenant_id),
    propertyId: asString(row.property_id),
    channel: requireChannel(row.channel),
    status,
    reason: asNullableString(row.reason),
    reasonCode: asNullableString(row.reason_code),
    attemptCount: asNumber(row.attempt_count),
    submittedNights: parseNights(row.submitted_nights),
    mappedBookingType: asNullableString(row.mapped_booking_type),
    firstAttemptedAt: asNullableString(row.first_attempted_at),
    lastAttemptedAt: asNullableString(row.last_attempted_at),
    acceptedAt: asNullableString(row.accepted_at),
    latencyMs: asNullableNumber(row.latency_ms),
  };
}

export interface AttemptUpsert {
  propagationId: string;
  tenantId: string;
  propertyId: string;
  channel: ChannelKey;
  status: AttemptStatus;
  reason?: string | null;
  reasonCode?: string | null;
  submittedNights?: CalendarDate[];
  nightsFingerprint?: string | null;
  mappedBookingType?: string | null;
  latencyMs?: number | null;
  /**
   * How many submissions this update performed, added to the running total.
   * Zero for a pure status refresh (e.g. pre-marking a target as pending).
   */
  incrementAttemptsBy?: number;
}

/**
 * Upserts the single attempt row for (propagation, channel). Retries and
 * replays update in place, which is what keeps a replayed event from producing
 * a second effective availability change.
 */
export function upsertAttempt(db: Db, input: AttemptUpsert): PropagationAttempt {
  const existing = db
    .prepare(
      'SELECT * FROM propagation_attempt WHERE propagation_id = ? AND channel = ? AND tenant_id = ?',
    )
    .get(input.propagationId, input.channel, input.tenantId) as Record<string, unknown> | undefined;

  const timestamp = nowIso();
  const accepted = input.status === 'succeeded' ? timestamp : null;

  if (existing) {
    const attemptCount = asNumber(existing.attempt_count) + (input.incrementAttemptsBy ?? 0);
    const nights = input.submittedNights ?? parseNights(existing.submitted_nights);
    db.prepare(
      `UPDATE propagation_attempt SET
         status = ?, reason = ?, reason_code = ?, attempt_count = ?,
         submitted_nights = ?, nights_fingerprint = ?, mapped_booking_type = ?,
         last_attempted_at = ?, accepted_at = COALESCE(?, accepted_at), latency_ms = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(
      input.status,
      input.reason ?? null,
      input.reasonCode ?? null,
      attemptCount,
      JSON.stringify(nights),
      input.nightsFingerprint ?? asNullableString(existing.nights_fingerprint),
      input.mappedBookingType ?? asNullableString(existing.mapped_booking_type),
      timestamp,
      accepted,
      input.latencyMs ?? null,
      asString(existing.id),
      input.tenantId,
    );
    const refreshed = db
      .prepare('SELECT * FROM propagation_attempt WHERE id = ?')
      .get(asString(existing.id)) as Record<string, unknown>;
    return mapAttempt(refreshed);
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO propagation_attempt
       (id, propagation_id, tenant_id, property_id, channel, status, reason, reason_code,
        attempt_count, submitted_nights, nights_fingerprint, mapped_booking_type,
        first_attempted_at, last_attempted_at, accepted_at, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.propagationId,
    input.tenantId,
    input.propertyId,
    input.channel,
    input.status,
    input.reason ?? null,
    input.reasonCode ?? null,
    input.incrementAttemptsBy ?? 0,
    JSON.stringify(input.submittedNights ?? []),
    input.nightsFingerprint ?? null,
    input.mappedBookingType ?? null,
    timestamp,
    timestamp,
    accepted,
    input.latencyMs ?? null,
  );
  const row = db.prepare('SELECT * FROM propagation_attempt WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return mapAttempt(row);
}

export function listAttempts(
  db: Db,
  tenantId: string,
  propagationId: string,
): PropagationAttempt[] {
  const rows = db
    .prepare(
      'SELECT * FROM propagation_attempt WHERE propagation_id = ? AND tenant_id = ? ORDER BY channel',
    )
    .all(propagationId, tenantId) as Record<string, unknown>[];
  return rows.map(mapAttempt);
}

/* ------------------------------------------------------------ ingest ledger */

export interface IngestRecord {
  eventId: string;
  tenantId: string;
  payloadHash: string;
  bookingId: string | null;
  outcome: string;
  receivedAt: string;
}

export function findIngestEvent(db: Db, eventId: string): IngestRecord | null {
  const row = db
    .prepare('SELECT * FROM ingest_event WHERE event_id = ?')
    .get(eventId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    eventId: asString(row.event_id),
    tenantId: asString(row.tenant_id),
    payloadHash: asString(row.payload_hash),
    bookingId: asNullableString(row.booking_id),
    outcome: asString(row.outcome),
    receivedAt: asString(row.received_at),
  };
}

export function recordIngestEvent(db: Db, record: Omit<IngestRecord, 'receivedAt'>): void {
  db.prepare(
    `INSERT INTO ingest_event (event_id, tenant_id, payload_hash, booking_id, outcome, received_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       outcome = excluded.outcome,
       booking_id = COALESCE(excluded.booking_id, ingest_event.booking_id)`,
  ).run(
    record.eventId,
    record.tenantId,
    record.payloadHash,
    record.bookingId,
    record.outcome,
    nowIso(),
  );
}
