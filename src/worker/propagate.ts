/**
 * The propagation worker.
 *
 * One confirmed booking in, one idempotent property-scoped propagation out,
 * with an independent recorded outcome per connected channel.
 *
 * Ordering matters here and is deliberate:
 *   1. tenant/property scoping is proven before anything is read,
 *   2. non-confirmed states are declined before a propagation record exists,
 *   3. the idempotency key is computed before any channel is contacted,
 *   4. an already-succeeded channel with an unchanged night set is never
 *      re-submitted, which is what makes a replay converge instead of applying
 *      a second effective availability change.
 */

import { channelConfig, resolveMaxAttempts } from '../config/channels.ts';
import { normalizeNights } from '../domain/dates.ts';
import {
  aggregateStatus,
  declineReason,
  isPropagatable,
  nightsFingerprint,
  nightsForChannel,
  propagationIdempotencyKey,
} from '../domain/propagation.ts';
import type {
  AggregateStatus,
  Booking,
  ChannelConnection,
  ChannelKey,
  PropagationAttempt,
} from '../domain/types.ts';
import { deriveNights } from '../domain/dates.ts';
import { MissingCredentialError, redact } from '../channels/credentials.ts';
import { resolveAdapter, type AdapterMap } from '../channels/registry.ts';
import type { AvailabilityOutcome } from '../channels/contract.ts';
import type { Db } from '../db/index.ts';
import * as repo from '../db/repo.ts';

export type PropagateOutcomeKind =
  | 'processed'
  | 'declined_not_confirmed'
  | 'no_targets'
  | 'invalid_stay';

export interface PropagateResult {
  kind: PropagateOutcomeKind;
  /** Null when no propagation record was created (declined / invalid). */
  propagationId: string | null;
  aggregateStatus: AggregateStatus;
  attempts: PropagationAttempt[];
  /** Present when the booking was declined or the stay was unusable. */
  reason: string | null;
  /** True when this run found an existing propagation for the same key. */
  replay: boolean;
  /** Channels skipped because they had already accepted an identical night set. */
  convergedChannels: ChannelKey[];
}

export interface PropagateOptions {
  adapters?: AdapterMap;
  env?: NodeJS.ProcessEnv;
  /** Delay between retry attempts. Set to 0 in tests. */
  retryDelayMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submits to one channel, retrying only while the outcome is classified as
 * retryable and the channel's own attempt budget allows it.
 */
async function submitToChannel(
  connection: ChannelConnection,
  args: {
    booking: Booking;
    nights: string[];
    idempotencyKey: string;
    adapters: AdapterMap;
    retryDelayMs: number;
  },
): Promise<{ outcome: AvailabilityOutcome; attemptsMade: number }> {
  const config = channelConfig(connection.channel);

  if (!config.supportsAvailabilityWrite) {
    return {
      attemptsMade: 0,
      outcome: {
        status: 'rejected',
        reason: `${config.label} does not support host-side availability writes; this channel cannot be propagated to.`,
        reasonCode: 'unsupported_operation',
        mappedBookingType: null,
        confirmedNights: [],
        latencyMs: 0,
        retryable: false,
      },
    };
  }

  const adapter = resolveAdapter(connection.channel, args.adapters);
  const maxAttempts = resolveMaxAttempts(config);
  let attemptsMade = 0;
  let outcome: AvailabilityOutcome | null = null;

  while (attemptsMade < maxAttempts) {
    attemptsMade += 1;
    try {
      outcome = await adapter.submitUnavailability({
        tenantId: connection.tenantId,
        propertyId: connection.propertyId,
        channel: connection.channel,
        externalListingId: connection.externalListingId,
        nights: args.nights,
        bookingType: config.confirmedBookingType,
        sourceBookingRef: args.booking.externalBookingId,
        idempotencyKey: args.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof MissingCredentialError) {
        // Not retryable and not a platform failure — a configuration gap.
        return {
          attemptsMade,
          outcome: {
            status: 'failed',
            reason: `${config.label} is connected but no credential is configured (${error.envVar}).`,
            reasonCode: 'missing_credential',
            mappedBookingType: null,
            confirmedNights: [],
            latencyMs: 0,
            retryable: false,
          },
        };
      }
      outcome = {
        status: 'failed',
        reason: redact(error instanceof Error ? error.message : String(error)),
        reasonCode: 'adapter_error',
        mappedBookingType: null,
        confirmedNights: [],
        latencyMs: 0,
        retryable: true,
      };
    }

    if (outcome.status === 'succeeded' || !outcome.retryable) break;
    if (attemptsMade < maxAttempts) await sleep(args.retryDelayMs);
  }

  return {
    attemptsMade,
    outcome:
      outcome ?? {
        status: 'failed',
        reason: `${config.label} produced no outcome.`,
        reasonCode: 'no_outcome',
        mappedBookingType: null,
        confirmedNights: [],
        latencyMs: 0,
        retryable: true,
      },
  };
}

/**
 * Propagates one booking's unavailable nights to every connected channel for
 * its property. Safe to call repeatedly for the same booking.
 */
export async function propagateBooking(
  db: Db,
  tenantId: string,
  bookingId: string,
  options: PropagateOptions = {},
): Promise<PropagateResult> {
  const adapters = options.adapters ?? {};
  const retryDelayMs = options.retryDelayMs ?? 250;

  // 1. Scope first. Both calls throw CrossTenantError on a foreign id.
  const booking = repo.requireBooking(db, tenantId, bookingId);
  const property = repo.requireProperty(db, tenantId, booking.propertyId);

  // 2. Confirmed bookings only — declined before any record is written.
  if (!isPropagatable(booking)) {
    return {
      kind: 'declined_not_confirmed',
      propagationId: null,
      aggregateStatus: 'no_targets',
      attempts: [],
      reason: declineReason(booking.state),
      replay: false,
      convergedChannels: [],
    };
  }

  // 3. Canonical night set and stable identity, before contacting anything.
  let canonicalNights: string[];
  try {
    canonicalNights = normalizeNights(deriveNights(booking.checkIn, booking.checkOut));
  } catch (error) {
    return {
      kind: 'invalid_stay',
      propagationId: null,
      aggregateStatus: 'no_targets',
      attempts: [],
      reason: error instanceof Error ? error.message : String(error),
      replay: false,
      convergedChannels: [],
    };
  }

  const idempotencyKey = propagationIdempotencyKey({
    tenantId,
    propertyId: property.id,
    sourceChannel: booking.sourceChannel,
    externalBookingId: booking.externalBookingId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });

  const { propagation, created } = repo.upsertPropagation(db, {
    tenantId,
    propertyId: property.id,
    bookingId: booking.id,
    idempotencyKey,
    derivedNights: canonicalNights,
  });

  // 4. Targets: enabled connections for this property only.
  const connections = repo.listConnections(db, tenantId, property.id, { enabledOnly: true });
  if (connections.length === 0) {
    return {
      kind: 'no_targets',
      propagationId: propagation.id,
      aggregateStatus: 'no_targets',
      attempts: [],
      reason:
        'No enabled channel connections exist for this property, so no propagation was attempted. This is not a cross-channel success.',
      replay: !created,
      convergedChannels: [],
    };
  }

  const existing = new Map(
    repo.listAttempts(db, tenantId, propagation.id).map((a) => [a.channel, a]),
  );
  const converged: ChannelKey[] = [];

  // Mark every target pending up front so an interrupted run is resumable and
  // the aggregate can never look complete while work remains.
  for (const connection of connections) {
    if (!existing.has(connection.channel)) {
      repo.upsertAttempt(db, {
        propagationId: propagation.id,
        tenantId,
        propertyId: property.id,
        channel: connection.channel,
        status: 'pending',
        submittedNights: nightsForChannel(booking, connection.channel),
        incrementAttemptsBy: 0,
      });
    }
  }

  // 5. Submit per channel, independently.
  for (const connection of connections) {
    const channelNights = normalizeNights(nightsForChannel(booking, connection.channel));
    const fingerprint = nightsFingerprint(channelNights);
    const prior = existing.get(connection.channel);

    // Replay convergence: an identical, already-accepted night set is not resent.
    if (prior?.status === 'succeeded' && nightsFingerprint(prior.submittedNights) === fingerprint) {
      converged.push(connection.channel);
      continue;
    }

    const { outcome, attemptsMade } = await submitToChannel(connection, {
      booking,
      nights: channelNights,
      idempotencyKey,
      adapters,
      retryDelayMs,
    });

    repo.upsertAttempt(db, {
      propagationId: propagation.id,
      tenantId,
      propertyId: property.id,
      channel: connection.channel,
      status: outcome.status,
      reason: outcome.reason,
      reasonCode: outcome.reasonCode,
      submittedNights: channelNights,
      nightsFingerprint: fingerprint,
      mappedBookingType: outcome.mappedBookingType,
      latencyMs: outcome.latencyMs,
      incrementAttemptsBy: attemptsMade,
    });
  }

  const attempts = repo.listAttempts(db, tenantId, propagation.id);
  return {
    kind: 'processed',
    propagationId: propagation.id,
    aggregateStatus: aggregateStatus(attempts),
    attempts,
    reason: null,
    replay: !created,
    convergedChannels: converged,
  };
}
