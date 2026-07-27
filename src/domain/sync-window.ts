/**
 * The 2–5 minute synchronization expectation.
 *
 * Rather than assert that propagation is fast, this measures each accepted
 * channel update against the expectation and names the state when it is not
 * met — including the "still stale, not yet confirmed" case that exists during
 * the window itself.
 */

import type { PropagationAttempt } from './types.ts';

export const SYNC_WINDOW_MIN_MS = 2 * 60_000;
export const SYNC_WINDOW_MAX_MS = 5 * 60_000;

export type SyncWindowState =
  /** Accepted inside the expected window. */
  | 'within_window'
  /** Accepted, but later than the expectation. */
  | 'exceeded_window'
  /** Not yet accepted and still inside the window — availability is stale. */
  | 'stale_in_window'
  /** Not yet accepted and past the window — availability is stale and overdue. */
  | 'stale_overdue'
  /** Terminally failed or rejected; the window no longer applies. */
  | 'not_applicable';

export interface SyncWindowEvaluation {
  state: SyncWindowState;
  /** Milliseconds from booking receipt to acceptance, or to now if unaccepted. */
  elapsedMs: number;
  /** True whenever the channel's availability is known not to reflect the booking yet. */
  stale: boolean;
  description: string;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function evaluateSyncWindow(
  attempt: Pick<PropagationAttempt, 'status' | 'acceptedAt'>,
  bookingReceivedAt: string,
  now: Date = new Date(),
): SyncWindowEvaluation {
  const receivedMs = Date.parse(bookingReceivedAt);
  const reference =
    attempt.status === 'succeeded' && attempt.acceptedAt
      ? Date.parse(attempt.acceptedAt)
      : now.getTime();
  const elapsedMs = Math.max(0, reference - (Number.isNaN(receivedMs) ? reference : receivedMs));

  if (attempt.status === 'succeeded') {
    const within = elapsedMs <= SYNC_WINDOW_MAX_MS;
    return {
      state: within ? 'within_window' : 'exceeded_window',
      elapsedMs,
      stale: false,
      description: within
        ? `Accepted in ${formatDuration(elapsedMs)}, inside the 2–5 minute expectation.`
        : `Accepted after ${formatDuration(elapsedMs)}, beyond the 5 minute expectation.`,
    };
  }

  if (attempt.status === 'failed' || attempt.status === 'rejected') {
    return {
      state: 'not_applicable',
      elapsedMs,
      stale: true,
      description: 'Terminal outcome — this channel does not reflect the booking.',
    };
  }

  // pending or delayed: the channel is knowingly stale.
  const overdue = elapsedMs > SYNC_WINDOW_MAX_MS;
  return {
    state: overdue ? 'stale_overdue' : 'stale_in_window',
    elapsedMs,
    stale: true,
    description: overdue
      ? `Unconfirmed after ${formatDuration(elapsedMs)} — past the 5 minute expectation. Availability on this channel is stale.`
      : `Unconfirmed after ${formatDuration(elapsedMs)} — still inside the 2–5 minute window. Availability on this channel is stale.`,
  };
}
