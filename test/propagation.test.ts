/**
 * Idempotency identity, the confirmed-only guard, and the aggregate roll-up.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregateStatus,
  claimsSuccess,
  declineReason,
  isPropagatable,
  nightsFingerprint,
  nightsForChannel,
  propagationIdempotencyKey,
} from '../src/domain/propagation.ts';
import { evaluateSyncWindow } from '../src/domain/sync-window.ts';
import { BOOKING_STATES } from '../src/domain/types.ts';
import type { AttemptStatus, Booking, PropagationAttempt } from '../src/domain/types.ts';

const BASE = {
  tenantId: 'tenant-a',
  propertyId: 'prop-a',
  sourceChannel: 'airbnb' as const,
  externalBookingId: 'HMABC123',
  checkIn: '2026-06-10',
  checkOut: '2026-06-13',
};

function attempt(status: AttemptStatus, overrides: Partial<PropagationAttempt> = {}): PropagationAttempt {
  return {
    id: `attempt-${status}-${Math.random().toString(36).slice(2)}`,
    propagationId: 'prop-1',
    tenantId: 'tenant-a',
    propertyId: 'prop-a',
    channel: 'airbnb',
    status,
    reason: null,
    reasonCode: null,
    attemptCount: 1,
    submittedNights: ['2026-06-10'],
    mappedBookingType: 'unavailable',
    firstAttemptedAt: '2026-06-01T00:00:00.000Z',
    lastAttemptedAt: '2026-06-01T00:00:00.000Z',
    acceptedAt: status === 'succeeded' ? '2026-06-01T00:00:30.000Z' : null,
    latencyMs: 20,
    ...overrides,
  };
}

describe('propagationIdempotencyKey', () => {
  it('is stable for identical input', () => {
    assert.equal(propagationIdempotencyKey(BASE), propagationIdempotencyKey(BASE));
  });

  it('differs across tenants for an otherwise identical booking', () => {
    assert.notEqual(
      propagationIdempotencyKey(BASE),
      propagationIdempotencyKey({ ...BASE, tenantId: 'tenant-b' }),
    );
  });

  it('differs across properties', () => {
    assert.notEqual(
      propagationIdempotencyKey(BASE),
      propagationIdempotencyKey({ ...BASE, propertyId: 'prop-b' }),
    );
  });

  it('differs when the stay changes', () => {
    assert.notEqual(
      propagationIdempotencyKey(BASE),
      propagationIdempotencyKey({ ...BASE, checkOut: '2026-06-14' }),
    );
  });

  it('differs when the source platform changes', () => {
    assert.notEqual(
      propagationIdempotencyKey(BASE),
      propagationIdempotencyKey({ ...BASE, sourceChannel: 'vrbo' }),
    );
  });
});

describe('nightsFingerprint', () => {
  it('ignores order and duplicates', () => {
    assert.equal(
      nightsFingerprint(['2026-06-10', '2026-06-11']),
      nightsFingerprint(['2026-06-11', '2026-06-10', '2026-06-10']),
    );
  });

  it('changes when the night set changes', () => {
    assert.notEqual(nightsFingerprint(['2026-06-10']), nightsFingerprint(['2026-06-11']));
  });
});

describe('confirmed-only guard', () => {
  it('accepts a confirmed booking', () => {
    assert.ok(isPropagatable({ state: 'confirmed' }));
  });

  for (const state of BOOKING_STATES.filter((s) => s !== 'confirmed')) {
    it(`declines "${state}" with a named reason`, () => {
      assert.ok(!isPropagatable({ state }));
      assert.match(declineReason(state), /\S/);
    });
  }

  it('names holds specifically', () => {
    assert.match(declineReason('hold'), /hold/i);
  });
});

describe('nightsForChannel', () => {
  const booking = { ...BASE, id: 'b1', state: 'confirmed', receivedAt: '' } as unknown as Booking;

  it('applies the channel policy for every configured channel', () => {
    for (const channel of ['airbnb', 'booking_com', 'vrbo', 'homeexchange'] as const) {
      assert.deepEqual(
        nightsForChannel(booking, channel),
        ['2026-06-10', '2026-06-11', '2026-06-12'],
        `${channel} should block three nights and leave checkout bookable`,
      );
    }
  });
});

describe('aggregateStatus', () => {
  it('is no_targets with no attempts', () => {
    assert.equal(aggregateStatus([]), 'no_targets');
  });

  it('is complete only when every attempt succeeded', () => {
    assert.equal(aggregateStatus([attempt('succeeded'), attempt('succeeded')]), 'complete');
  });

  it('is partial when one channel is delayed and another succeeded', () => {
    assert.equal(aggregateStatus([attempt('succeeded'), attempt('delayed')]), 'partial');
  });

  it('is partial when one channel was rejected and another succeeded', () => {
    assert.equal(aggregateStatus([attempt('succeeded'), attempt('rejected')]), 'partial');
  });

  it('is failed when nothing succeeded', () => {
    assert.equal(aggregateStatus([attempt('failed'), attempt('rejected')]), 'failed');
  });

  it('is in_progress while a channel is still pending', () => {
    assert.equal(aggregateStatus([attempt('succeeded'), attempt('pending')]), 'in_progress');
  });

  it('never claims success unless every channel accepted', () => {
    for (const bad of ['delayed', 'failed', 'rejected', 'pending'] as AttemptStatus[]) {
      const status = aggregateStatus([attempt('succeeded'), attempt(bad)]);
      assert.ok(
        !claimsSuccess(status),
        `aggregate must not claim success when one channel is ${bad} (got ${status})`,
      );
    }
  });
});

describe('sync window', () => {
  const received = '2026-06-01T00:00:00.000Z';

  it('reports an acceptance inside five minutes as within_window', () => {
    const evaluation = evaluateSyncWindow(
      { status: 'succeeded', acceptedAt: '2026-06-01T00:03:00.000Z' },
      received,
    );
    assert.equal(evaluation.state, 'within_window');
    assert.equal(evaluation.stale, false);
  });

  it('reports a late acceptance as exceeded_window', () => {
    const evaluation = evaluateSyncWindow(
      { status: 'succeeded', acceptedAt: '2026-06-01T00:09:00.000Z' },
      received,
    );
    assert.equal(evaluation.state, 'exceeded_window');
  });

  it('exposes stale state inside the window for an unconfirmed channel', () => {
    const evaluation = evaluateSyncWindow(
      { status: 'delayed', acceptedAt: null },
      received,
      new Date('2026-06-01T00:01:00.000Z'),
    );
    assert.equal(evaluation.state, 'stale_in_window');
    assert.equal(evaluation.stale, true);
  });

  it('marks an unconfirmed channel overdue past the window', () => {
    const evaluation = evaluateSyncWindow(
      { status: 'delayed', acceptedAt: null },
      received,
      new Date('2026-06-01T00:20:00.000Z'),
    );
    assert.equal(evaluation.state, 'stale_overdue');
    assert.equal(evaluation.stale, true);
  });

  it('treats a rejected channel as stale with the window not applicable', () => {
    const evaluation = evaluateSyncWindow({ status: 'rejected', acceptedAt: null }, received);
    assert.equal(evaluation.state, 'not_applicable');
    assert.equal(evaluation.stale, true);
  });
});
