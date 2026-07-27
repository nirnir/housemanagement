/**
 * Core domain types for availability propagation.
 *
 * Money is deliberately absent from this model. The spec permits keeping
 * booking amounts / revenue outside this feature entirely, and doing so avoids
 * carrying currency, null, zero, negative, refunded and reversed values through
 * a workflow that has no need for them.
 */

/** A connected destination platform. */
export type ChannelKey = 'airbnb' | 'booking_com' | 'vrbo' | 'homeexchange';

export const CHANNEL_KEYS: readonly ChannelKey[] = [
  'airbnb',
  'booking_com',
  'vrbo',
  'homeexchange',
];

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === 'string' && (CHANNEL_KEYS as readonly string[]).includes(value);
}

/**
 * Upstream booking states. Only `confirmed` is in scope for this feature.
 * The others exist so the propagation worker can explicitly recognise and
 * decline them rather than silently treating an unknown state as confirmed.
 */
export type BookingState =
  | 'confirmed'
  | 'tentative'
  | 'hold'
  | 'cancelled'
  | 'modified'
  | 'refunded';

export const BOOKING_STATES: readonly BookingState[] = [
  'confirmed',
  'tentative',
  'hold',
  'cancelled',
  'modified',
  'refunded',
];

export function isBookingState(value: unknown): value is BookingState {
  return typeof value === 'string' && (BOOKING_STATES as readonly string[]).includes(value);
}

/**
 * A calendar date in `YYYY-MM-DD` form, interpreted in the property's local
 * timezone. Availability is a calendar-date concept on every target platform,
 * so dates are never converted to instants — that is what keeps timezone
 * differences from shifting which nights get blocked.
 */
export type CalendarDate = string;

export interface Tenant {
  id: string;
  name: string;
}

export interface Property {
  id: string;
  tenantId: string;
  name: string;
  /** IANA timezone, e.g. `Europe/Amsterdam`. Documents the frame for calendar dates. */
  timezone: string;
}

export interface ChannelConnection {
  id: string;
  tenantId: string;
  propertyId: string;
  channel: ChannelKey;
  /** The listing identifier on the destination platform. */
  externalListingId: string;
  enabled: boolean;
  /**
   * When true, this channel must accept the update for the propagation to be
   * anything better than `partial`.
   */
  required: boolean;
  /** Name of the environment variable holding this connection's secret. Never the secret itself. */
  credentialRef: string;
  syncStatus?: AttemptStatus | 'stale';
  lastAttemptAt?: string | null;
  lastSuccessfulSyncAt?: string | null;
  lastSyncError?: string | null;
}

export interface Booking {
  id: string;
  tenantId: string;
  propertyId: string;
  /** Platform the booking originated on. */
  sourceChannel: ChannelKey;
  externalBookingId: string;
  state: BookingState;
  checkIn: CalendarDate;
  checkOut: CalendarDate;
  receivedAt: string;
}

/** Per-channel outcome. Each destination keeps its own independent state. */
export type AttemptStatus = 'pending' | 'succeeded' | 'delayed' | 'failed' | 'rejected';

/**
 * Aggregate outcome across all attempted channels.
 * `complete` is reserved for the case where every attempt succeeded.
 */
export type AggregateStatus =
  | 'no_targets'
  | 'in_progress'
  | 'complete'
  | 'partial'
  | 'failed';

export interface PropagationAttempt {
  id: string;
  propagationId: string;
  tenantId: string;
  propertyId: string;
  channel: ChannelKey;
  status: AttemptStatus;
  /** Human-readable reason for a delayed / failed / rejected outcome. */
  reason: string | null;
  /** Machine-readable classification, e.g. `timeout`, `rate_limited`, `rejected_unsupported`. */
  reasonCode: string | null;
  attemptCount: number;
  /** The nights actually submitted to this channel, after its date policy was applied. */
  submittedNights: CalendarDate[];
  /** Booking type this channel accepted the update as. */
  mappedBookingType: string | null;
  firstAttemptedAt: string | null;
  lastAttemptedAt: string | null;
  acceptedAt: string | null;
  latencyMs: number | null;
}

export interface Propagation {
  id: string;
  tenantId: string;
  propertyId: string;
  bookingId: string;
  /** Stable key that makes duplicate events, retries and replays converge. */
  idempotencyKey: string;
  /** Nights derived from the booking before per-channel policy is applied. */
  derivedNights: CalendarDate[];
  createdAt: string;
  updatedAt: string;
}

export type AvailabilitySource = ChannelKey | 'owner';
export type AvailabilityKind = 'booking' | 'hold' | 'owner_block';
export type AvailabilityLifecycle = 'active' | 'cancelled' | 'conflict';
export type AvailabilityOperation = 'block' | 'release';

export interface AvailabilityRecord {
  id: string;
  tenantId: string;
  propertyId: string;
  bookingId: string | null;
  source: AvailabilitySource;
  externalRecordId: string;
  recordKind: AvailabilityKind;
  lifecycleState: AvailabilityLifecycle;
  checkIn: CalendarDate;
  checkOut: CalendarDate;
  providerEventId: string;
  conflictWithId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilitySync {
  id: string;
  tenantId: string;
  propertyId: string;
  availabilityRecordId: string;
  operation: AvailabilityOperation;
  idempotencyKey: string;
  nights: CalendarDate[];
  aggregateStatus: AggregateStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilitySyncAttempt {
  id: string;
  syncId: string;
  tenantId: string;
  propertyId: string;
  channel: ChannelKey;
  status: AttemptStatus;
  reason: string | null;
  reasonCode: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  succeededAt: string | null;
}
