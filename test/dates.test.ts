/**
 * Date derivation — the boundary behaviour the whole feature depends on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InvalidDateError,
  InvalidStayError,
  addDays,
  compareDates,
  deriveNights,
  isSameDayTurnover,
  normalizeNights,
  parseCalendarDate,
} from '../src/domain/dates.ts';
import { toContiguousRanges, expandRanges } from '../src/channels/vrbo.ts';

describe('deriveNights — approved nights model', () => {
  it('blocks check-in through the night before checkout', () => {
    assert.deepEqual(deriveNights('2026-06-10', '2026-06-13'), [
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
    ]);
  });

  it('leaves the checkout date bookable, permitting same-day turnover', () => {
    const nights = deriveNights('2026-06-10', '2026-06-13');
    assert.ok(!nights.includes('2026-06-13'), 'checkout date must stay available');
  });

  it('produces a single night for a one-night stay', () => {
    assert.deepEqual(deriveNights('2026-06-10', '2026-06-11'), ['2026-06-10']);
  });

  it('blocks the checkout date under the checkout_blocked policy', () => {
    assert.deepEqual(deriveNights('2026-06-10', '2026-06-12', 'checkout_blocked'), [
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
    ]);
  });

  it('spans month boundaries', () => {
    assert.deepEqual(deriveNights('2026-01-30', '2026-02-02'), [
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
    ]);
  });

  it('handles a leap day', () => {
    assert.deepEqual(deriveNights('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29']);
  });

  it('spans a year boundary', () => {
    assert.deepEqual(deriveNights('2026-12-31', '2027-01-02'), ['2026-12-31', '2027-01-01']);
  });

  it('rejects a zero-night stay', () => {
    assert.throws(() => deriveNights('2026-06-10', '2026-06-10'), InvalidStayError);
  });

  it('rejects an inverted stay', () => {
    assert.throws(() => deriveNights('2026-06-13', '2026-06-10'), InvalidStayError);
  });

  it('is independent of the host process timezone', () => {
    // Calendar dates are never converted to instants, so the same stay yields
    // the same nights regardless of where the property or the process sits.
    const original = process.env.TZ;
    const results: string[][] = [];
    for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      process.env.TZ = tz;
      results.push(deriveNights('2026-06-10', '2026-06-13'));
    }
    process.env.TZ = original;
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
  });
});

describe('same-day turnover', () => {
  it('recognises a departure and arrival sharing a date', () => {
    assert.ok(isSameDayTurnover({ checkOut: '2026-06-13' }, { checkIn: '2026-06-13' }));
  });

  it('two back-to-back stays never claim the same night', () => {
    const first = deriveNights('2026-06-10', '2026-06-13');
    const second = deriveNights('2026-06-13', '2026-06-15');
    const overlap = first.filter((night) => second.includes(night));
    assert.deepEqual(overlap, [], 'turnover must not double-block the shared date');
  });
});

describe('parseCalendarDate', () => {
  it('accepts a well-formed date', () => {
    assert.equal(parseCalendarDate('2026-06-10'), '2026-06-10');
  });

  for (const bad of ['2026-6-10', '10-06-2026', '2026-13-01', '2026-02-30', '2025-02-29', '', 'today']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseCalendarDate(bad), InvalidDateError);
    });
  }

  it('rejects a non-string', () => {
    assert.throws(() => parseCalendarDate(20260610), InvalidDateError);
  });
});

describe('date arithmetic', () => {
  it('adds across a month boundary', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  });

  it('subtracts across a year boundary', () => {
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  });

  it('orders dates', () => {
    assert.ok(compareDates('2026-06-10', '2026-06-11') < 0);
    assert.equal(compareDates('2026-06-10', '2026-06-10'), 0);
  });

  it('normalises to a sorted, de-duplicated list', () => {
    assert.deepEqual(normalizeNights(['2026-06-12', '2026-06-10', '2026-06-12']), [
      '2026-06-10',
      '2026-06-12',
    ]);
  });
});

describe('Vrbo range mapping', () => {
  it('collapses contiguous nights into one inclusive range', () => {
    assert.deepEqual(toContiguousRanges(['2026-06-10', '2026-06-11', '2026-06-12']), [
      { startDate: '2026-06-10', endDate: '2026-06-12' },
    ]);
  });

  it('splits a gap into separate ranges', () => {
    assert.deepEqual(toContiguousRanges(['2026-06-10', '2026-06-11', '2026-06-20']), [
      { startDate: '2026-06-10', endDate: '2026-06-11' },
      { startDate: '2026-06-20', endDate: '2026-06-20' },
    ]);
  });

  it('de-duplicates repeated nights', () => {
    assert.deepEqual(toContiguousRanges(['2026-06-10', '2026-06-10']), [
      { startDate: '2026-06-10', endDate: '2026-06-10' },
    ]);
  });

  it('round-trips through expansion', () => {
    const nights = deriveNights('2026-06-10', '2026-06-14');
    assert.deepEqual(expandRanges(toContiguousRanges(nights)), nights);
  });
});
