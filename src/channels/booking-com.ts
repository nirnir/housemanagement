/**
 * Booking.com adapter.
 *
 * Wire model: XML over HTTP, per-date `status` elements scoped to a room id —
 * deliberately different from the JSON channels, because the aggregate result
 * has to hold up across genuinely different platform contracts.
 *
 * The response parsing here is intentionally narrow (a fixed, known element
 * shape) rather than a general XML parser: it accepts only what it recognises
 * and treats anything else as a malformed response rather than a success.
 */

import { channelConfig, resolveBaseUrl, resolveTimeoutMs } from '../config/channels.ts';
import { resolveCredential } from './credentials.ts';
import { classifyTransport, malformed, sameNights, sendRequest } from './transport.ts';
import { problem, succeeded, type AvailabilityOutcome, type AvailabilityRequest, type ChannelAdapter } from './contract.ts';

const CONFIG = channelConfig('booking_com');

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildAvailabilityXml(request: AvailabilityRequest): string {
  const dates = request.nights
    .map(
      (date) =>
        `    <date value="${escapeXml(date)}" status="${escapeXml(request.bookingType)}"/>`,
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<request>',
    `  <idempotency_key>${escapeXml(request.idempotencyKey)}</idempotency_key>`,
    `  <source_ref>${escapeXml(request.sourceBookingRef)}</source_ref>`,
    `  <operation>${request.operation ?? 'block'}</operation>`,
    `  <room id="${escapeXml(request.externalListingId)}">`,
    dates,
    '  </room>',
    '</request>',
  ].join('\n');
}

/** Extracts `<date value="..."/>` values from an `<ok>` response. */
export function parseConfirmedDates(xml: string): string[] | null {
  if (!/<ok\b/.test(xml)) return null;
  const dates: string[] = [];
  const pattern = /<date\s+value="([^"]+)"/g;
  let match = pattern.exec(xml);
  while (match !== null) {
    if (match[1] !== undefined) dates.push(match[1]);
    match = pattern.exec(xml);
  }
  return dates;
}

/** Extracts a `<fault>` message, when present. */
export function parseFault(xml: string): string | null {
  const match = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(xml);
  if (match?.[1] !== undefined) return match[1].trim();
  return /<fault\b/.test(xml) ? 'unspecified fault' : null;
}

export const bookingComAdapter: ChannelAdapter = {
  channel: 'booking_com',

  describeTarget(externalListingId) {
    return `${resolveBaseUrl(CONFIG)}${CONFIG.availabilityPath.replace('{listingId}', externalListingId)}`;
  },

  async submitUnavailability(request: AvailabilityRequest): Promise<AvailabilityOutcome> {
    const url = this.describeTarget(request.externalListingId);
    const token = resolveCredential(CONFIG.credentialEnv);

    const result = await sendRequest({
      url,
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(token).toString('base64')}`,
        'content-type': 'application/xml',
        'x-request-id': request.idempotencyKey,
      },
      body: buildAvailabilityXml(request),
      timeoutMs: resolveTimeoutMs(CONFIG),
    });

    const classified = classifyTransport(result, {
      timeoutMs: resolveTimeoutMs(CONFIG),
      channelLabel: CONFIG.label,
    });
    if (classified) return classified;

    // Booking.com signals application-level rejection inside a 200 response.
    const fault = parseFault(result.bodyText);
    if (fault !== null) {
      return problem(
        'rejected',
        'rejected_by_platform',
        `${CONFIG.label} returned a fault: ${fault}`,
        result.latencyMs,
        false,
      );
    }

    const confirmed = parseConfirmedDates(result.bodyText);
    if (confirmed === null) {
      return malformed(CONFIG.label, 'response contained neither <ok> nor <fault>', result.latencyMs);
    }

    if (!sameNights(request.nights, confirmed)) {
      return problem(
        'failed',
        'partial_confirmation',
        `${CONFIG.label} confirmed ${confirmed.length} of ${request.nights.length} requested nights.`,
        result.latencyMs,
        true,
      );
    }

    return succeeded(result.latencyMs, request.bookingType, confirmed);
  },
};
