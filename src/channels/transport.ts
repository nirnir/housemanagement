/**
 * Shared HTTP transport and response classification for channel adapters.
 *
 * Real `fetch`, real timeouts, real status-code handling. The classification
 * table is the single place that decides whether a platform response means
 * delayed, failed or rejected — so every channel reports failure in the same
 * vocabulary while keeping its own reason.
 */

import { problem, type AvailabilityOutcome } from './contract.ts';
import { redact } from './credentials.ts';

export interface TransportResult {
  httpStatus: number | null;
  bodyText: string;
  latencyMs: number;
  timedOut: boolean;
  networkError: string | null;
  /** `Retry-After` in seconds, when the platform supplied one. */
  retryAfterSeconds: number | null;
}

export async function sendRequest(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): Promise<TransportResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const retryAfter = response.headers.get('retry-after');
    return {
      httpStatus: response.status,
      bodyText,
      latencyMs: Math.round(performance.now() - startedAt),
      timedOut: false,
      networkError: null,
      retryAfterSeconds: retryAfter ? Number(retryAfter) || null : null,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      httpStatus: null,
      bodyText: '',
      latencyMs,
      timedOut: aborted,
      networkError: aborted ? null : error instanceof Error ? error.message : String(error),
      retryAfterSeconds: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps a transport result to an outcome for every case except a 2xx that still
 * needs body validation. Returns `null` when the adapter must inspect the body.
 */
export function classifyTransport(
  result: TransportResult,
  context: { timeoutMs: number; channelLabel: string },
): AvailabilityOutcome | null {
  const { latencyMs } = result;

  if (result.timedOut) {
    return problem(
      'delayed',
      'timeout',
      `${context.channelLabel} did not respond within ${context.timeoutMs}ms. The update may still be applied; state is unconfirmed.`,
      latencyMs,
      true,
    );
  }

  if (result.networkError !== null) {
    return problem(
      'delayed',
      'network_error',
      `Could not reach ${context.channelLabel}: ${redact(result.networkError)}`,
      latencyMs,
      true,
    );
  }

  const status = result.httpStatus;
  if (status === null) {
    return problem('failed', 'no_response', `${context.channelLabel} returned no response.`, latencyMs, true);
  }

  // Accepted for asynchronous processing — real, but not yet confirmed.
  if (status === 202) {
    return problem(
      'delayed',
      'queued',
      `${context.channelLabel} queued the update (HTTP 202) but has not confirmed it.`,
      latencyMs,
      true,
    );
  }

  if (status === 429) {
    const wait = result.retryAfterSeconds;
    return problem(
      'delayed',
      'rate_limited',
      `${context.channelLabel} rate-limited the request${wait ? `; retry after ${wait}s` : ''}.`,
      latencyMs,
      true,
    );
  }

  if (status === 401 || status === 403) {
    return problem(
      'failed',
      'unauthorized',
      `${context.channelLabel} rejected the credential (HTTP ${status}). Check the configured API token.`,
      latencyMs,
      false,
    );
  }

  if (status === 404) {
    return problem(
      'rejected',
      'listing_not_found',
      `${context.channelLabel} does not recognise this listing (HTTP 404).`,
      latencyMs,
      false,
    );
  }

  if (status === 409) {
    return problem(
      'rejected',
      'conflict',
      `${context.channelLabel} reports a conflicting reservation on these dates (HTTP 409). Surfaced for the conflict-safety workflow.`,
      latencyMs,
      false,
    );
  }

  if (status === 422 || status === 400) {
    return problem(
      'rejected',
      'rejected_invalid_request',
      `${context.channelLabel} rejected the mapped update as invalid (HTTP ${status}): ${redact(result.bodyText.slice(0, 300))}`,
      latencyMs,
      false,
    );
  }

  if (status === 501) {
    return problem(
      'rejected',
      'unsupported_operation',
      `${context.channelLabel} does not support host-side availability writes (HTTP 501).`,
      latencyMs,
      false,
    );
  }

  if (status >= 500) {
    return problem(
      'delayed',
      'upstream_error',
      `${context.channelLabel} returned HTTP ${status}; the update is unconfirmed.`,
      latencyMs,
      true,
    );
  }

  if (status >= 300) {
    return problem(
      'failed',
      'unexpected_status',
      `${context.channelLabel} returned unexpected HTTP ${status}.`,
      latencyMs,
      false,
    );
  }

  return null; // 2xx — the adapter validates the body.
}

/** Outcome for a 2xx whose body did not positively confirm the requested nights. */
export function malformed(
  channelLabel: string,
  detail: string,
  latencyMs: number,
): AvailabilityOutcome {
  return problem(
    'failed',
    'malformed_response',
    `${channelLabel} returned a success status but the response did not confirm the update: ${detail}`,
    latencyMs,
    true,
  );
}

/** Set equality on night lists, ignoring order. */
export function sameNights(requested: readonly string[], confirmed: readonly string[]): boolean {
  if (requested.length !== confirmed.length) return false;
  const left = [...requested].sort();
  const right = [...confirmed].sort();
  return left.every((night, index) => night === right[index]);
}
