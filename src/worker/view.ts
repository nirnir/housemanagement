/**
 * Read model for the propagation status surface.
 *
 * Assembles a booking's propagation, its per-channel attempts, the sync-window
 * evaluation for each, and the connected-but-unattempted / not-connected
 * channels — so the UI can present each channel's real outcome without needing
 * to know how any of it was derived.
 */

import { channelConfig } from '../config/channels.ts';
import { AGGREGATE_LABEL, ATTEMPT_LABEL, aggregateStatus, claimsSuccess } from '../domain/propagation.ts';
import { evaluateSyncWindow, type SyncWindowEvaluation } from '../domain/sync-window.ts';
import { CHANNEL_KEYS } from '../domain/types.ts';
import type {
  AggregateStatus,
  Booking,
  ChannelKey,
  Propagation,
  PropagationAttempt,
  Property,
} from '../domain/types.ts';
import type { Db } from '../db/index.ts';
import * as repo from '../db/repo.ts';

export interface AttemptView extends PropagationAttempt {
  channelLabel: string;
  colorToken: string;
  statusLabel: string;
  /** Whether this channel must accept for the aggregate to clear `partial`. */
  required: boolean;
  sync: SyncWindowEvaluation;
}

export interface UnattemptedChannel {
  channel: ChannelKey;
  channelLabel: string;
  reason: string;
}

export interface PropagationViewModel {
  propagation: Propagation;
  booking: Booking;
  property: Property;
  attempts: AttemptView[];
  aggregateStatus: AggregateStatus;
  aggregateLabel: string;
  /** True only when every attempted channel accepted the update. */
  claimsSuccess: boolean;
  /** True when at least one channel's availability is known to be stale. */
  anyStale: boolean;
  unattemptedChannels: UnattemptedChannel[];
}

export function buildPropagationView(
  db: Db,
  tenantId: string,
  propagationId: string,
  now: Date = new Date(),
): PropagationViewModel | null {
  const propagation = repo.findPropagation(db, tenantId, propagationId);
  if (!propagation) return null;

  const booking = repo.requireBooking(db, tenantId, propagation.bookingId);
  const property = repo.requireProperty(db, tenantId, propagation.propertyId);
  const connections = repo.listConnections(db, tenantId, propagation.propertyId);
  const rawAttempts = repo.listAttempts(db, tenantId, propagationId);

  const requiredByChannel = new Map(connections.map((c) => [c.channel, c.required]));

  const attempts: AttemptView[] = rawAttempts.map((attempt) => {
    const config = channelConfig(attempt.channel);
    return {
      ...attempt,
      channelLabel: config.label,
      colorToken: config.colorToken,
      statusLabel: ATTEMPT_LABEL[attempt.status],
      required: requiredByChannel.get(attempt.channel) ?? true,
      sync: evaluateSyncWindow(attempt, booking.receivedAt, now),
    };
  });

  const attemptedChannels = new Set(rawAttempts.map((a) => a.channel));
  const unattemptedChannels: UnattemptedChannel[] = [];

  for (const channel of CHANNEL_KEYS) {
    if (attemptedChannels.has(channel)) continue;
    const connection = connections.find((c) => c.channel === channel);
    const label = channelConfig(channel).label;
    if (!connection) {
      unattemptedChannels.push({
        channel,
        channelLabel: label,
        reason: 'Not connected for this property — outside the attempted propagation.',
      });
    } else if (!connection.enabled) {
      unattemptedChannels.push({
        channel,
        channelLabel: label,
        reason: 'Connection is disabled — no update was attempted.',
      });
    }
  }

  const status = aggregateStatus(rawAttempts);

  return {
    propagation,
    booking,
    property,
    attempts,
    aggregateStatus: status,
    aggregateLabel: AGGREGATE_LABEL[status],
    claimsSuccess: claimsSuccess(status),
    anyStale: attempts.some((a) => a.sync.stale),
    unattemptedChannels,
  };
}

/** Most recent propagations for a tenant, newest first, as full view models. */
export function listPropagationViews(
  db: Db,
  tenantId: string,
  options: { propertyId?: string; limit?: number; now?: Date } = {},
): PropagationViewModel[] {
  const now = options.now ?? new Date();
  const records = repo.listPropagations(db, tenantId, options.propertyId);
  const limited = options.limit ? records.slice(0, options.limit) : records;
  return limited
    .map((record) => buildPropagationView(db, tenantId, record.id, now))
    .filter((view): view is PropagationViewModel => view !== null);
}
