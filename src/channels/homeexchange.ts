/**
 * HomeExchange adapter (the connected home-exchange platform).
 *
 * The specific home-exchange platform was not named in the spec and Prodeology
 * could not resolve it, so this adapter is registered under a neutral
 * `homeexchange` channel key. Swapping to a different exchange platform means
 * changing this file and the `homeexchange` entry in the channel registry —
 * nothing in the worker, derivation or UI depends on which one it is.
 *
 * Wire model: a flat unavailable-date list, JSON.
 */

import { channelConfig, resolveBaseUrl, resolveTimeoutMs } from '../config/channels.ts';
import { resolveCredential } from './credentials.ts';
import { classifyTransport, malformed, sameNights, sendRequest } from './transport.ts';
import { problem, succeeded, type AvailabilityOutcome, type AvailabilityRequest, type ChannelAdapter } from './contract.ts';

const CONFIG = channelConfig('homeexchange');

interface HomeExchangeResponse {
  ok?: unknown;
  unavailable?: unknown;
  reason?: unknown;
  detail?: unknown;
}

export const homeExchangeAdapter: ChannelAdapter = {
  channel: 'homeexchange',

  describeTarget(externalListingId) {
    return `${resolveBaseUrl(CONFIG)}${CONFIG.availabilityPath.replace('{listingId}', externalListingId)}`;
  },

  async submitUnavailability(request: AvailabilityRequest): Promise<AvailabilityOutcome> {
    const url = this.describeTarget(request.externalListingId);
    const token = resolveCredential(CONFIG.credentialEnv);

    const body = JSON.stringify({
      request_id: request.idempotencyKey,
      external_reference: request.sourceBookingRef,
      unavailable_dates: request.operation === 'release' ? [] : request.nights,
      available_dates: request.operation === 'release' ? request.nights : [],
      reason: request.bookingType,
    });

    const result = await sendRequest({
      url,
      method: 'POST',
      headers: {
        'x-api-key': token,
        'content-type': 'application/json',
        'x-request-id': request.idempotencyKey,
      },
      body,
      timeoutMs: resolveTimeoutMs(CONFIG),
    });

    const classified = classifyTransport(result, {
      timeoutMs: resolveTimeoutMs(CONFIG),
      channelLabel: CONFIG.label,
    });
    if (classified) return classified;

    let payload: HomeExchangeResponse;
    try {
      payload = JSON.parse(result.bodyText) as HomeExchangeResponse;
    } catch {
      return malformed(CONFIG.label, 'response body was not valid JSON', result.latencyMs);
    }

    if (payload.ok !== true) {
      const detail = payload.reason ?? payload.detail;
      return problem(
        'rejected',
        'rejected_by_platform',
        `${CONFIG.label} did not accept the update${detail ? `: ${String(detail)}` : '.'}`,
        result.latencyMs,
        false,
      );
    }

    const unavailable = payload.unavailable;
    if (!Array.isArray(unavailable) || !unavailable.every((d): d is string => typeof d === 'string')) {
      return malformed(CONFIG.label, 'no `unavailable` array present', result.latencyMs);
    }

    if (!sameNights(request.nights, unavailable)) {
      return problem(
        'failed',
        'partial_confirmation',
        `${CONFIG.label} confirmed ${unavailable.length} of ${request.nights.length} requested nights.`,
        result.latencyMs,
        true,
      );
    }

    return succeeded(result.latencyMs, request.bookingType, unavailable);
  },
};
