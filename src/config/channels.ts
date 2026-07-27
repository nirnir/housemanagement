/**
 * Per-channel configuration: display identity, date semantics, booking-type
 * mapping and credential/endpoint wiring.
 *
 * This registry is the single place where platform-specific semantics live.
 * Two of its fields encode prerequisites the product could not resolve at spec
 * time and are therefore marked as approved assumptions:
 *
 *   - `checkoutNightPolicy` — approved as `checkout_available` for all four
 *     platforms (nights model: check-in through the night before checkout).
 *   - `confirmedBookingType` — the value each platform is expected to accept a
 *     confirmed, host-side unavailability block as.
 *
 * Both must be re-validated against each platform's published API contract
 * before this is pointed at production endpoints. Correcting either is a
 * one-line change here, with no effect on derivation or worker logic.
 */

import type { CheckoutNightPolicy } from '../domain/dates.ts';
import type { ChannelKey } from '../domain/types.ts';

export interface ChannelConfig {
  key: ChannelKey;
  /** Operator-facing name. */
  label: string;
  /** CSS custom property from the design system used to tint this channel. */
  colorToken: string;
  checkoutNightPolicy: CheckoutNightPolicy;
  /** What this platform calls a confirmed, host-blocked unavailability. */
  confirmedBookingType: string;
  /** What this platform calls a released/bookable date. */
  availableBookingType: string;
  /**
   * Environment variable naming the base URL for this channel's API.
   * Unset in development, where the conformance server is used instead.
   */
  baseUrlEnv: string;
  /** Environment variable holding the API credential. Never a literal secret. */
  credentialEnv: string;
  /** Path template for the availability write, relative to the base URL. */
  availabilityPath: string;
  /** Per-request timeout before the attempt is recorded as `delayed`. */
  timeoutMs: number;
  /** Maximum attempts, inclusive of the first. */
  maxAttempts: number;
  /**
   * Whether the platform supports host-side availability writes at all.
   * A `false` here produces an honest `rejected` / unsupported outcome rather
   * than a silent success.
   */
  supportsAvailabilityWrite: boolean;
}

export const CHANNEL_CONFIG: Readonly<Record<ChannelKey, ChannelConfig>> = Object.freeze({
  airbnb: {
    key: 'airbnb',
    label: 'Airbnb',
    colorToken: '--ch-airbnb',
    checkoutNightPolicy: 'checkout_available',
    confirmedBookingType: 'unavailable',
    availableBookingType: 'available',
    baseUrlEnv: 'AIRBNB_API_BASE_URL',
    credentialEnv: 'AIRBNB_API_TOKEN',
    availabilityPath: '/v2/calendars/{listingId}/availability',
    timeoutMs: 8_000,
    maxAttempts: 3,
    supportsAvailabilityWrite: true,
  },
  booking_com: {
    key: 'booking_com',
    label: 'Booking.com',
    colorToken: '--ch-booking',
    checkoutNightPolicy: 'checkout_available',
    confirmedBookingType: 'closed',
    availableBookingType: 'open',
    baseUrlEnv: 'BOOKING_COM_API_BASE_URL',
    credentialEnv: 'BOOKING_COM_API_TOKEN',
    availabilityPath: '/xml/availability/{listingId}',
    timeoutMs: 10_000,
    maxAttempts: 3,
    supportsAvailabilityWrite: true,
  },
  vrbo: {
    key: 'vrbo',
    label: 'Vrbo',
    colorToken: '--ch-vrbo',
    checkoutNightPolicy: 'checkout_available',
    confirmedBookingType: 'RESERVED',
    availableBookingType: 'AVAILABLE',
    baseUrlEnv: 'VRBO_API_BASE_URL',
    credentialEnv: 'VRBO_API_TOKEN',
    availabilityPath: '/v1/listings/{listingId}/calendar',
    timeoutMs: 8_000,
    maxAttempts: 3,
    supportsAvailabilityWrite: true,
  },
  homeexchange: {
    key: 'homeexchange',
    label: 'HomeExchange',
    colorToken: '--ch-exchange',
    checkoutNightPolicy: 'checkout_available',
    confirmedBookingType: 'blocked',
    availableBookingType: 'available',
    baseUrlEnv: 'HOMEEXCHANGE_API_BASE_URL',
    credentialEnv: 'HOMEEXCHANGE_API_TOKEN',
    availabilityPath: '/api/v1/homes/{listingId}/availability',
    timeoutMs: 8_000,
    maxAttempts: 3,
    supportsAvailabilityWrite: true,
  },
});

export function channelConfig(channel: ChannelKey): ChannelConfig {
  const config = CHANNEL_CONFIG[channel];
  if (!config) {
    throw new Error(`No configuration registered for channel ${channel}`);
  }
  return config;
}

/**
 * Resolves a channel's base URL. Falls back to the local conformance server so
 * the full request/response path is exercised end to end in development.
 * Production closure requires the real per-channel base URL to be set.
 */
export function resolveBaseUrl(config: ChannelConfig, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[config.baseUrlEnv];
  if (configured && configured.trim() !== '') return configured.replace(/\/+$/, '');
  const conformance = env.CONFORMANCE_BASE_URL ?? 'http://127.0.0.1:4599';
  return `${conformance.replace(/\/+$/, '')}/${config.key}`;
}

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Per-request timeout, overridable per channel (`AIRBNB_TIMEOUT_MS`) or globally
 * (`CHANNEL_TIMEOUT_MS`). Real platforms differ in latency and rate policy, so
 * this is tunable per environment without a code change.
 */
export function resolveTimeoutMs(
  config: ChannelConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    positiveNumber(env[`${config.key.toUpperCase()}_TIMEOUT_MS`]) ??
    positiveNumber(env.CHANNEL_TIMEOUT_MS) ??
    config.timeoutMs
  );
}

/** Attempt budget, overridable the same way. */
export function resolveMaxAttempts(
  config: ChannelConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    positiveNumber(env[`${config.key.toUpperCase()}_MAX_ATTEMPTS`]) ??
    positiveNumber(env.CHANNEL_MAX_ATTEMPTS) ??
    config.maxAttempts
  );
}

/** True when a real (non-conformance) base URL is configured for this channel. */
export function isLiveEndpoint(config: ChannelConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env[config.baseUrlEnv];
  return typeof configured === 'string' && configured.trim() !== '';
}
