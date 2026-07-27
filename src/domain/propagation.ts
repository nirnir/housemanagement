/**
 * Propagation rules: idempotency identity, per-channel status, and the
 * aggregate roll-up.
 */

import { createHash } from 'node:crypto';

import { channelConfig } from '../config/channels.ts';
import { deriveNights, normalizeNights } from './dates.ts';
import type {
  AggregateStatus,
  AttemptStatus,
  Booking,
  CalendarDate,
  ChannelKey,
  PropagationAttempt,
} from './types.ts';

/**
 * Stable identity for a propagation. Duplicate webhook deliveries, worker
 * retries and replayed events all resolve to the same key, so persistence can
 * upsert instead of creating a second set of attempts.
 *
 * Tenant and property are part of the key so an identical external booking id
 * arriving for two different tenants can never collapse into one record.
 */
export function propagationIdempotencyKey(input: {
  tenantId: string;
  propertyId: string;
  sourceChannel: ChannelKey;
  externalBookingId: string;
  checkIn: CalendarDate;
  checkOut: CalendarDate;
}): string {
  const canonical = [
    input.tenantId,
    input.propertyId,
    input.sourceChannel,
    input.externalBookingId,
    input.checkIn,
    input.checkOut,
  ].join('\0');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 40);
}

/** Fingerprint of the night set actually submitted, used to detect no-op replays. */
export function nightsFingerprint(nights: readonly CalendarDate[]): string {
  return createHash('sha256').update(normalizeNights(nights).join(',')).digest('hex').slice(0, 32);
}

/** Only confirmed bookings are in scope for the legacy propagation endpoint. */
export function isPropagatable(booking: Pick<Booking, 'state'>): boolean {
  return booking.state === 'confirmed';
}

export function declineReason(state: Booking['state']): string {
  switch (state) {
    case 'confirmed':
      return '';
    case 'hold':
      return 'Arbitrary holds are outside the legacy propagation endpoint; use the unified calendar webhook.';
    case 'tentative':
      return 'Tentative reservations use the unified calendar webhook and do not propagate here.';
    case 'cancelled':
      return 'Cancellations use the unified calendar webhook; no legacy availability change is derived.';
    case 'modified':
      return 'Modifications use the unified calendar webhook; no legacy availability change is derived.';
    case 'refunded':
      return 'Refunds do not create a legacy availability change.';
    default: {
      const exhaustive: never = state;
      return `Unrecognised booking state ${String(exhaustive)}; not treated as confirmed.`;
    }
  }
}

/** Nights for one destination, applying that channel's checkout-night policy. */
export function nightsForChannel(booking: Booking, channel: ChannelKey): CalendarDate[] {
  const { checkoutNightPolicy } = channelConfig(channel);
  return deriveNights(booking.checkIn, booking.checkOut, checkoutNightPolicy);
}

const TERMINAL: readonly AttemptStatus[] = ['succeeded', 'failed', 'rejected'];

export function isTerminal(status: AttemptStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Rolls per-channel outcomes into an aggregate.
 *
 * `complete` requires every attempt to have succeeded. A single delayed,
 * failed or rejected channel caps the aggregate at `partial`, and an absence of
 * any success makes it `failed`. The aggregate therefore never claims success
 * on behalf of a channel that did not accept the update.
 */
export function aggregateStatus(attempts: readonly PropagationAttempt[]): AggregateStatus {
  if (attempts.length === 0) return 'no_targets';

  const succeeded = attempts.filter((attempt) => attempt.status === 'succeeded').length;
  const pending = attempts.filter((attempt) => attempt.status === 'pending').length;

  if (succeeded === attempts.length) return 'complete';
  if (pending > 0) return 'in_progress';
  return succeeded === 0 ? 'failed' : 'partial';
}

/** Whether the aggregate may be presented to a host as an unqualified success. */
export function claimsSuccess(status: AggregateStatus): boolean {
  return status === 'complete';
}

export const AGGREGATE_LABEL: Readonly<Record<AggregateStatus, string>> = Object.freeze({
  no_targets: 'No propagation targets',
  in_progress: 'In progress',
  complete: 'All channels updated',
  partial: 'Partially updated',
  failed: 'Not updated',
});

export const ATTEMPT_LABEL: Readonly<Record<AttemptStatus, string>> = Object.freeze({
  pending: 'Pending',
  succeeded: 'Blocked',
  delayed: 'Delayed',
  failed: 'Failed',
  rejected: 'Rejected',
});
