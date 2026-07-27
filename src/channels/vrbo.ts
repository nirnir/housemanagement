/**
 * Vrbo adapter.
 *
 * Wire model: contiguous date *ranges* rather than individual nights, JSON.
 * Nights are collapsed into inclusive ranges before submission, which is the
 * clearest example of why derivation and submission are separate steps — the
 * derived night set is canonical, each platform reshapes it.
 */

import { channelConfig, resolveBaseUrl, resolveTimeoutMs } from '../config/channels.ts';
import { addDays, compareDates, toDayNumber } from '../domain/dates.ts';
import type { CalendarDate } from '../domain/types.ts';
import { resolveCredential } from './credentials.ts';
import { classifyTransport, malformed, sameNights, sendRequest } from './transport.ts';
import { problem, succeeded, type AvailabilityOutcome, type AvailabilityRequest, type ChannelAdapter } from './contract.ts';

const CONFIG = channelConfig('vrbo');

export interface DateRange {
  /** First blocked night. */
  startDate: CalendarDate;
  /** Last blocked night, inclusive. */
  endDate: CalendarDate;
}

/**
 * Collapses a night list into inclusive contiguous ranges.
 * `[06-10, 06-11, 06-12, 06-20]` → `[{06-10 → 06-12}, {06-20 → 06-20}]`
 */
export function toContiguousRanges(nights: readonly CalendarDate[]): DateRange[] {
  const sorted = [...nights].sort(compareDates);
  const ranges: DateRange[] = [];

  for (const night of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && toDayNumber(night) === toDayNumber(last.endDate) + 1) {
      last.endDate = night;
    } else if (!last || toDayNumber(night) !== toDayNumber(last.endDate)) {
      ranges.push({ startDate: night, endDate: night });
    }
  }
  return ranges;
}

/** Expands inclusive ranges back into a night list, for confirmation checking. */
export function expandRanges(ranges: readonly DateRange[]): CalendarDate[] {
  const nights: CalendarDate[] = [];
  for (const range of ranges) {
    let cursor = range.startDate;
    while (compareDates(cursor, range.endDate) <= 0) {
      nights.push(cursor);
      cursor = addDays(cursor, 1);
    }
  }
  return nights;
}

interface VrboResponse {
  status?: unknown;
  blockedDates?: unknown;
  bookingType?: unknown;
  message?: unknown;
}

export const vrboAdapter: ChannelAdapter = {
  channel: 'vrbo',

  describeTarget(externalListingId) {
    return `${resolveBaseUrl(CONFIG)}${CONFIG.availabilityPath.replace('{listingId}', externalListingId)}`;
  },

  async submitUnavailability(request: AvailabilityRequest): Promise<AvailabilityOutcome> {
    const url = this.describeTarget(request.externalListingId);
    const token = resolveCredential(CONFIG.credentialEnv);

    const body = JSON.stringify({
      externalRef: request.sourceBookingRef,
      idempotencyKey: request.idempotencyKey,
      operation: request.operation ?? 'block',
      blocks: toContiguousRanges(request.nights).map((range) => ({
        ...range,
        type: request.bookingType,
      })),
    });

    const result = await sendRequest({
      url,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-idempotency-key': request.idempotencyKey,
      },
      body,
      timeoutMs: resolveTimeoutMs(CONFIG),
    });

    const classified = classifyTransport(result, {
      timeoutMs: resolveTimeoutMs(CONFIG),
      channelLabel: CONFIG.label,
    });
    if (classified) return classified;

    let payload: VrboResponse;
    try {
      payload = JSON.parse(result.bodyText) as VrboResponse;
    } catch {
      return malformed(CONFIG.label, 'response body was not valid JSON', result.latencyMs);
    }

    if (payload.status !== 'CONFIRMED') {
      return problem(
        'rejected',
        'not_confirmed',
        `${CONFIG.label} returned status ${String(payload.status ?? 'missing')}${
          payload.message ? `: ${String(payload.message)}` : ''
        }`,
        result.latencyMs,
        false,
      );
    }

    const blocked = payload.blockedDates;
    if (!Array.isArray(blocked) || !blocked.every((d): d is string => typeof d === 'string')) {
      return malformed(CONFIG.label, 'no `blockedDates` array present', result.latencyMs);
    }

    if (!sameNights(request.nights, blocked)) {
      return problem(
        'failed',
        'partial_confirmation',
        `${CONFIG.label} confirmed ${blocked.length} of ${request.nights.length} requested nights.`,
        result.latencyMs,
        true,
      );
    }

    const confirmedType =
      typeof payload.bookingType === 'string' ? payload.bookingType : request.bookingType;
    return succeeded(result.latencyMs, confirmedType, blocked);
  },
};
