/**
 * Airbnb adapter.
 *
 * Wire model: per-night operations against the listing calendar, JSON.
 * The request carries the propagation idempotency key so a retry collapses
 * platform-side rather than producing a second block.
 */

import { channelConfig, resolveBaseUrl, resolveTimeoutMs } from '../config/channels.ts';
import { resolveCredential } from './credentials.ts';
import { classifyTransport, malformed, sameNights, sendRequest } from './transport.ts';
import { problem, succeeded, type AvailabilityOutcome, type AvailabilityRequest, type ChannelAdapter } from './contract.ts';

const CONFIG = channelConfig('airbnb');

interface AirbnbResponse {
  calendar?: { updated_dates?: unknown };
  availability_type?: unknown;
  error?: unknown;
}

export const airbnbAdapter: ChannelAdapter = {
  channel: 'airbnb',

  describeTarget(externalListingId) {
    return `${resolveBaseUrl(CONFIG)}${CONFIG.availabilityPath.replace('{listingId}', externalListingId)}`;
  },

  async submitUnavailability(request: AvailabilityRequest): Promise<AvailabilityOutcome> {
    const url = this.describeTarget(request.externalListingId);
    const token = resolveCredential(CONFIG.credentialEnv);

    const body = JSON.stringify({
      idempotency_key: request.idempotencyKey,
      source_reservation_ref: request.sourceBookingRef,
      operations: request.nights.map((date) => ({
        date,
        available: request.operation === 'release',
        availability_type: request.bookingType,
      })),
    });

    const result = await sendRequest({
      url,
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': request.idempotencyKey,
      },
      body,
      timeoutMs: resolveTimeoutMs(CONFIG),
    });

    const classified = classifyTransport(result, {
      timeoutMs: resolveTimeoutMs(CONFIG),
      channelLabel: CONFIG.label,
    });
    if (classified) return classified;

    let payload: AirbnbResponse;
    try {
      payload = JSON.parse(result.bodyText) as AirbnbResponse;
    } catch {
      return malformed(CONFIG.label, 'response body was not valid JSON', result.latencyMs);
    }

    if (payload.error) {
      return problem(
        'rejected',
        'rejected_by_platform',
        `${CONFIG.label} rejected the update: ${String(payload.error)}`,
        result.latencyMs,
        false,
      );
    }

    const updated = payload.calendar?.updated_dates;
    if (!Array.isArray(updated) || !updated.every((d): d is string => typeof d === 'string')) {
      return malformed(CONFIG.label, 'no `calendar.updated_dates` array present', result.latencyMs);
    }

    // A success status is not accepted unless the confirmed nights match exactly.
    if (!sameNights(request.nights, updated)) {
      return problem(
        'failed',
        'partial_confirmation',
        `${CONFIG.label} confirmed ${updated.length} of ${request.nights.length} requested nights.`,
        result.latencyMs,
        true,
      );
    }

    const confirmedType =
      typeof payload.availability_type === 'string' ? payload.availability_type : request.bookingType;
    return succeeded(result.latencyMs, confirmedType, updated);
  },
};
