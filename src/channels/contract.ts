/**
 * The channel adapter contract.
 *
 * One shape for every destination platform. Each adapter is responsible for
 * translating a derived night set into its own platform's wire format and for
 * classifying the platform's response into an honest outcome — an adapter may
 * never report `succeeded` unless the platform's response positively confirms
 * the requested nights were accepted.
 */

import type { AvailabilityOperation, CalendarDate, ChannelKey } from '../domain/types.ts';

export interface AvailabilityRequest {
  tenantId: string;
  propertyId: string;
  channel: ChannelKey;
  /** The listing identifier on the destination platform. */
  externalListingId: string;
  /** Nights to mark unavailable, already adjusted for this channel's date policy. */
  nights: CalendarDate[];
  /** What this platform calls a confirmed host-side block. */
  bookingType: string;
  /** Source booking identity, for the platform's own de-duplication. */
  sourceBookingRef: string;
  /** Propagation idempotency key, sent so the platform can collapse retries. */
  idempotencyKey: string;
  /** Defaults to block for compatibility with the original propagation path. */
  operation?: AvailabilityOperation;
}

export type OutcomeStatus = 'succeeded' | 'delayed' | 'failed' | 'rejected';

export interface AvailabilityOutcome {
  status: OutcomeStatus;
  /** Operator-readable explanation. Never contains credentials. */
  reason: string | null;
  /** Stable machine classification, e.g. `timeout`, `rate_limited`, `rejected_invalid_range`. */
  reasonCode: string | null;
  /** Booking type the platform confirmed the block as. */
  mappedBookingType: string | null;
  /** Nights the platform confirmed. */
  confirmedNights: CalendarDate[];
  latencyMs: number;
  /** Whether another attempt could plausibly succeed. */
  retryable: boolean;
}

export interface ChannelAdapter {
  readonly channel: ChannelKey;
  /** Human-readable description of the endpoint being called, for the status UI. */
  describeTarget(externalListingId: string): string;
  submitUnavailability(request: AvailabilityRequest): Promise<AvailabilityOutcome>;
}

export function succeeded(
  latencyMs: number,
  mappedBookingType: string,
  confirmedNights: CalendarDate[],
): AvailabilityOutcome {
  return {
    status: 'succeeded',
    reason: null,
    reasonCode: null,
    mappedBookingType,
    confirmedNights,
    latencyMs,
    retryable: false,
  };
}

export function problem(
  status: Exclude<OutcomeStatus, 'succeeded'>,
  reasonCode: string,
  reason: string,
  latencyMs: number,
  retryable: boolean,
): AvailabilityOutcome {
  return {
    status,
    reason,
    reasonCode,
    mappedBookingType: null,
    confirmedNights: [],
    latencyMs,
    retryable,
  };
}
