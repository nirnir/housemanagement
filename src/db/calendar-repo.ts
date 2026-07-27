/**
 * Persistence for the canonical unified calendar.
 *
 * Every operation carries tenant and property scope into SQL. The caller must
 * resolve the property through `requireProperty` before entering this module.
 */

import { randomUUID } from 'node:crypto';

import type { Db } from './index.ts';
import type {
  AggregateStatus,
  AttemptStatus,
  AvailabilityKind,
  AvailabilityLifecycle,
  AvailabilityOperation,
  AvailabilityRecord,
  AvailabilitySource,
  AvailabilitySync,
  AvailabilitySyncAttempt,
  CalendarDate,
  ChannelKey,
  Property,
} from '../domain/types.ts';

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullable(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function mapRecord(row: Record<string, unknown>): AvailabilityRecord {
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    propertyId: text(row.property_id),
    bookingId: nullable(row.booking_id),
    source: text(row.source) as AvailabilitySource,
    externalRecordId: text(row.external_record_id),
    recordKind: text(row.record_kind) as AvailabilityKind,
    lifecycleState: text(row.lifecycle_state) as AvailabilityLifecycle,
    checkIn: text(row.check_in),
    checkOut: text(row.check_out),
    providerEventId: text(row.provider_event_id),
    conflictWithId: nullable(row.conflict_with_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export interface CalendarEventRow {
  eventId: string;
  tenantId: string;
  propertyId: string;
  payloadHash: string;
  availabilityRecordId: string | null;
  outcome: string;
  receivedAt: string;
}

export function findCalendarEvent(db: Db, eventId: string): CalendarEventRow | null {
  const row = db.prepare('SELECT * FROM calendar_event WHERE event_id = ?').get(eventId) as
    | Record<string, unknown>
    | undefined;
  return row
    ? {
        eventId: text(row.event_id),
        tenantId: text(row.tenant_id),
        propertyId: text(row.property_id),
        payloadHash: text(row.payload_hash),
        availabilityRecordId: nullable(row.availability_record_id),
        outcome: text(row.outcome),
        receivedAt: text(row.received_at),
      }
    : null;
}

export function recordCalendarEvent(
  db: Db,
  input: Omit<CalendarEventRow, 'receivedAt'>,
): void {
  db.prepare(
    `INSERT INTO calendar_event
       (event_id, tenant_id, property_id, payload_hash, availability_record_id, outcome, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       payload_hash = excluded.payload_hash,
       availability_record_id = excluded.availability_record_id,
       outcome = excluded.outcome`,
  ).run(
    input.eventId,
    input.tenantId,
    input.propertyId,
    input.payloadHash,
    input.availabilityRecordId,
    input.outcome,
    nowIso(),
  );
}

export function findAvailabilityByIdentity(
  db: Db,
  tenantId: string,
  propertyId: string,
  source: AvailabilitySource,
  externalRecordId: string,
): AvailabilityRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM availability_record
       WHERE tenant_id = ? AND property_id = ? AND source = ? AND external_record_id = ?`,
    )
    .get(tenantId, propertyId, source, externalRecordId) as Record<string, unknown> | undefined;
  return row ? mapRecord(row) : null;
}

export function findOverlap(
  db: Db,
  input: {
    tenantId: string;
    propertyId: string;
    checkIn: CalendarDate;
    checkOut: CalendarDate;
    excludeRecordId?: string;
  },
): AvailabilityRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM availability_record
       WHERE tenant_id = ? AND property_id = ?
         AND lifecycle_state = 'active'
         AND check_in < ? AND ? < check_out
         AND (? IS NULL OR id <> ?)
       ORDER BY check_in, created_at
       LIMIT 1`,
    )
    .get(
      input.tenantId,
      input.propertyId,
      input.checkOut,
      input.checkIn,
      input.excludeRecordId ?? null,
      input.excludeRecordId ?? null,
    ) as Record<string, unknown> | undefined;
  return row ? mapRecord(row) : null;
}

export function upsertAvailabilityRecord(
  db: Db,
  input: {
    tenantId: string;
    propertyId: string;
    bookingId?: string | null;
    source: AvailabilitySource;
    externalRecordId: string;
    recordKind: AvailabilityKind;
    lifecycleState: AvailabilityLifecycle;
    checkIn: CalendarDate;
    checkOut: CalendarDate;
    providerEventId: string;
    conflictWithId?: string | null;
  },
): AvailabilityRecord {
  const existing = findAvailabilityByIdentity(
    db,
    input.tenantId,
    input.propertyId,
    input.source,
    input.externalRecordId,
  );
  const timestamp = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE availability_record SET
         booking_id = ?, record_kind = ?, lifecycle_state = ?, check_in = ?, check_out = ?,
         provider_event_id = ?, conflict_with_id = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND property_id = ?`,
    ).run(
      input.bookingId ?? existing.bookingId,
      input.recordKind,
      input.lifecycleState,
      input.checkIn,
      input.checkOut,
      input.providerEventId,
      input.conflictWithId ?? null,
      timestamp,
      existing.id,
      input.tenantId,
      input.propertyId,
    );
    return {
      ...existing,
      bookingId: input.bookingId ?? existing.bookingId,
      recordKind: input.recordKind,
      lifecycleState: input.lifecycleState,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      providerEventId: input.providerEventId,
      conflictWithId: input.conflictWithId ?? null,
      updatedAt: timestamp,
    };
  }

  const record: AvailabilityRecord = {
    id: randomUUID(),
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    bookingId: input.bookingId ?? null,
    source: input.source,
    externalRecordId: input.externalRecordId,
    recordKind: input.recordKind,
    lifecycleState: input.lifecycleState,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    providerEventId: input.providerEventId,
    conflictWithId: input.conflictWithId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.prepare(
    `INSERT INTO availability_record
       (id, tenant_id, property_id, booking_id, source, external_record_id, record_kind,
        lifecycle_state, check_in, check_out, provider_event_id, conflict_with_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.tenantId,
    record.propertyId,
    record.bookingId,
    record.source,
    record.externalRecordId,
    record.recordKind,
    record.lifecycleState,
    record.checkIn,
    record.checkOut,
    record.providerEventId,
    record.conflictWithId,
    record.createdAt,
    record.updatedAt,
  );
  return record;
}

export function listAvailabilityRecords(
  db: Db,
  tenantId: string,
  propertyId: string,
): AvailabilityRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM availability_record
       WHERE tenant_id = ? AND property_id = ?
       ORDER BY check_in, check_out, source, external_record_id`,
    )
    .all(tenantId, propertyId) as Record<string, unknown>[];
  return rows.map(mapRecord);
}

export function requireAvailabilityRecord(
  db: Db,
  tenantId: string,
  propertyId: string,
  recordId: string,
): AvailabilityRecord {
  const row = db
    .prepare(
      `SELECT * FROM availability_record
       WHERE id = ? AND tenant_id = ? AND property_id = ?`,
    )
    .get(recordId, tenantId, propertyId) as Record<string, unknown> | undefined;
  if (row) return mapRecord(row);

  const foreign = db
    .prepare('SELECT tenant_id, property_id FROM availability_record WHERE id = ?')
    .get(recordId) as Record<string, unknown> | undefined;
  if (foreign) {
    throw new Error('Availability record belongs to another tenant or property.');
  }
  throw new Error('Availability record not found.');
}

export function listProperties(db: Db, tenantId: string): Property[] {
  const rows = db
    .prepare('SELECT id, tenant_id, name, timezone FROM property WHERE tenant_id = ? ORDER BY id')
    .all(tenantId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: text(row.id),
    tenantId: text(row.tenant_id),
    name: text(row.name),
    timezone: text(row.timezone),
  }));
}

function parseNights(value: unknown): CalendarDate[] {
  if (typeof value !== 'string') return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function mapSync(row: Record<string, unknown>): AvailabilitySync {
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    propertyId: text(row.property_id),
    availabilityRecordId: text(row.availability_record_id),
    operation: text(row.operation) as AvailabilityOperation,
    idempotencyKey: text(row.idempotency_key),
    nights: parseNights(row.nights),
    aggregateStatus: text(row.aggregate_status) as AggregateStatus,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export function upsertAvailabilitySync(
  db: Db,
  input: {
    tenantId: string;
    propertyId: string;
    availabilityRecordId: string;
    operation: AvailabilityOperation;
    idempotencyKey: string;
    nights: CalendarDate[];
  },
): { sync: AvailabilitySync; created: boolean } {
  const existing = db
    .prepare('SELECT * FROM availability_sync WHERE idempotency_key = ? AND tenant_id = ?')
    .get(input.idempotencyKey, input.tenantId) as Record<string, unknown> | undefined;
  if (existing) return { sync: mapSync(existing), created: false };

  const timestamp = nowIso();
  const sync: AvailabilitySync = {
    id: randomUUID(),
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    availabilityRecordId: input.availabilityRecordId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    nights: input.nights,
    aggregateStatus: 'in_progress',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.prepare(
    `INSERT INTO availability_sync
       (id, tenant_id, property_id, availability_record_id, operation, idempotency_key,
        nights, aggregate_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sync.id,
    sync.tenantId,
    sync.propertyId,
    sync.availabilityRecordId,
    sync.operation,
    sync.idempotencyKey,
    JSON.stringify(sync.nights),
    sync.aggregateStatus,
    sync.createdAt,
    sync.updatedAt,
  );
  return { sync, created: true };
}

function mapAttempt(row: Record<string, unknown>): AvailabilitySyncAttempt {
  return {
    id: text(row.id),
    syncId: text(row.sync_id),
    tenantId: text(row.tenant_id),
    propertyId: text(row.property_id),
    channel: text(row.channel) as ChannelKey,
    status: text(row.status) as AttemptStatus,
    reason: nullable(row.reason),
    reasonCode: nullable(row.reason_code),
    attemptCount: Number(row.attempt_count ?? 0),
    lastAttemptAt: nullable(row.last_attempt_at),
    succeededAt: nullable(row.succeeded_at),
  };
}

export function upsertSyncAttempt(
  db: Db,
  input: {
    syncId: string;
    tenantId: string;
    propertyId: string;
    channel: ChannelKey;
    status: AttemptStatus;
    reason?: string | null;
    reasonCode?: string | null;
    incrementAttemptsBy?: number;
  },
): AvailabilitySyncAttempt {
  const existing = db
    .prepare(
      'SELECT * FROM availability_sync_attempt WHERE sync_id = ? AND channel = ? AND tenant_id = ?',
    )
    .get(input.syncId, input.channel, input.tenantId) as Record<string, unknown> | undefined;
  const timestamp = nowIso();
  const succeededAt =
    input.status === 'succeeded' ? nullable(existing?.succeeded_at) ?? timestamp : null;
  if (existing) {
    db.prepare(
      `UPDATE availability_sync_attempt SET
         status = ?, reason = ?, reason_code = ?,
         attempt_count = attempt_count + ?, last_attempt_at = ?, succeeded_at = ?
       WHERE id = ? AND tenant_id = ? AND property_id = ?`,
    ).run(
      input.status,
      input.reason ?? null,
      input.reasonCode ?? null,
      input.incrementAttemptsBy ?? 0,
      timestamp,
      succeededAt,
      text(existing.id),
      input.tenantId,
      input.propertyId,
    );
    return mapAttempt({
      ...existing,
      status: input.status,
      reason: input.reason ?? null,
      reason_code: input.reasonCode ?? null,
      attempt_count: Number(existing.attempt_count ?? 0) + (input.incrementAttemptsBy ?? 0),
      last_attempt_at: timestamp,
      succeeded_at: succeededAt,
    });
  }

  const row = {
    id: randomUUID(),
    sync_id: input.syncId,
    tenant_id: input.tenantId,
    property_id: input.propertyId,
    channel: input.channel,
    status: input.status,
    reason: input.reason ?? null,
    reason_code: input.reasonCode ?? null,
    attempt_count: input.incrementAttemptsBy ?? 0,
    last_attempt_at: timestamp,
    succeeded_at: succeededAt,
  };
  db.prepare(
    `INSERT INTO availability_sync_attempt
       (id, sync_id, tenant_id, property_id, channel, status, reason, reason_code,
        attempt_count, last_attempt_at, succeeded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...Object.values(row));
  return mapAttempt(row);
}

export function listSyncAttempts(
  db: Db,
  tenantId: string,
  syncId: string,
): AvailabilitySyncAttempt[] {
  const rows = db
    .prepare(
      `SELECT * FROM availability_sync_attempt
       WHERE tenant_id = ? AND sync_id = ? ORDER BY channel`,
    )
    .all(tenantId, syncId) as Record<string, unknown>[];
  return rows.map(mapAttempt);
}

export function updateSyncAggregate(
  db: Db,
  tenantId: string,
  syncId: string,
  status: AggregateStatus,
): void {
  db.prepare(
    'UPDATE availability_sync SET aggregate_status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
  ).run(status, nowIso(), syncId, tenantId);
}

export function latestSyncForRecord(
  db: Db,
  tenantId: string,
  propertyId: string,
  recordId: string,
): { sync: AvailabilitySync; attempts: AvailabilitySyncAttempt[] } | null {
  const row = db
    .prepare(
      `SELECT * FROM availability_sync
       WHERE tenant_id = ? AND property_id = ? AND availability_record_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(tenantId, propertyId, recordId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const sync = mapSync(row);
  return { sync, attempts: listSyncAttempts(db, tenantId, sync.id) };
}

export function updateConnectionSyncState(
  db: Db,
  input: {
    tenantId: string;
    propertyId: string;
    channel: ChannelKey;
    status: AttemptStatus;
    error?: string | null;
  },
): void {
  const timestamp = nowIso();
  db.prepare(
    `UPDATE channel_connection SET
       sync_status = ?, last_attempt_at = ?,
       last_successful_sync_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_successful_sync_at END,
       last_sync_error = ?
     WHERE tenant_id = ? AND property_id = ? AND channel = ?`,
  ).run(
    input.status,
    timestamp,
    input.status,
    timestamp,
    input.status === 'succeeded' ? null : input.error ?? 'Channel update did not succeed.',
    input.tenantId,
    input.propertyId,
    input.channel,
  );
}
