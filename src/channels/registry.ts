/**
 * Adapter registry. The worker resolves adapters through here so tests can
 * substitute a stub for one channel while leaving the others real.
 */

import type { ChannelKey } from '../domain/types.ts';
import { airbnbAdapter } from './airbnb.ts';
import { bookingComAdapter } from './booking-com.ts';
import { homeExchangeAdapter } from './homeexchange.ts';
import { vrboAdapter } from './vrbo.ts';
import type { ChannelAdapter } from './contract.ts';

export type AdapterMap = Partial<Record<ChannelKey, ChannelAdapter>>;

export const DEFAULT_ADAPTERS: Readonly<Record<ChannelKey, ChannelAdapter>> = Object.freeze({
  airbnb: airbnbAdapter,
  booking_com: bookingComAdapter,
  vrbo: vrboAdapter,
  homeexchange: homeExchangeAdapter,
});

export class UnknownChannelError extends Error {
  constructor(channel: string) {
    super(`No adapter registered for channel ${channel}.`);
    this.name = 'UnknownChannelError';
  }
}

export function resolveAdapter(channel: ChannelKey, overrides: AdapterMap = {}): ChannelAdapter {
  const adapter = overrides[channel] ?? DEFAULT_ADAPTERS[channel];
  if (!adapter) throw new UnknownChannelError(channel);
  return adapter;
}
