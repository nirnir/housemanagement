/**
 * Calendar-date arithmetic and unavailable-night derivation.
 *
 * Availability is modelled purely as calendar dates in the property's local
 * timezone. Dates are never converted to instants, so a property in
 * `Pacific/Auckland` and one in `America/Los_Angeles` derive the same nights
 * from the same check-in/check-out pair. This is what prevents timezone
 * differences from shifting the blocked range by a day.
 */

import type { CalendarDate } from './types.ts';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class InvalidDateError extends Error {}
export class InvalidStayError extends Error {}

/** Validates `YYYY-MM-DD` and rejects non-existent dates such as `2026-02-30`. */
export function parseCalendarDate(value: unknown): CalendarDate {
  if (typeof value !== 'string') {
    throw new InvalidDateError(`Expected a YYYY-MM-DD string, received ${typeof value}`);
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new InvalidDateError(`Malformed calendar date: ${JSON.stringify(value)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    throw new InvalidDateError(`Month out of range in ${value}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new InvalidDateError(`Day out of range in ${value}`);
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 1970-01-01, computed via UTC purely as a stable integer index. */
export function toDayNumber(date: CalendarDate): number {
  const match = DATE_PATTERN.exec(parseCalendarDate(date));
  // parseCalendarDate guarantees a match; the assertion keeps strict indexing happy.
  if (!match) throw new InvalidDateError(date);
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round(ms / 86_400_000);
}

export function fromDayNumber(dayNumber: number): CalendarDate {
  const date = new Date(dayNumber * 86_400_000);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromDayNumber(toDayNumber(date) + days);
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return toDayNumber(a) - toDayNumber(b);
}

/**
 * How a destination platform treats the checkout date.
 *
 * `checkout_available` is the operator-approved default: a stay blocks each
 * night from the check-in date through the night before checkout, leaving the
 * checkout date itself bookable so a same-day arrival can take it.
 *
 * NOTE: this default is an approved assumption pending validation against each
 * platform's published API contract. It is expressed per channel precisely so a
 * platform that turns out to differ can be corrected in one place without
 * touching the derivation logic.
 */
export type CheckoutNightPolicy = 'checkout_available' | 'checkout_blocked';

/**
 * Inclusive nights blocked by a stay, before any per-channel policy is applied.
 * A night is identified by the date it begins.
 *
 * `2026-06-10` → `2026-06-13` yields `[2026-06-10, 2026-06-11, 2026-06-12]`.
 */
export function deriveNights(
  checkIn: CalendarDate,
  checkOut: CalendarDate,
  policy: CheckoutNightPolicy = 'checkout_available',
): CalendarDate[] {
  const start = toDayNumber(parseCalendarDate(checkIn));
  const end = toDayNumber(parseCalendarDate(checkOut));

  if (end < start) {
    throw new InvalidStayError(`Check-out ${checkOut} precedes check-in ${checkIn}`);
  }
  if (end === start) {
    throw new InvalidStayError(
      `Zero-night stay: check-in and check-out are both ${checkIn}. A confirmed booking must span at least one night.`,
    );
  }

  // `checkout_available` stops the night before checkout; `checkout_blocked`
  // includes the checkout date itself, preventing same-day turnover.
  const lastNight = policy === 'checkout_blocked' ? end : end - 1;

  const nights: CalendarDate[] = [];
  for (let day = start; day <= lastNight; day += 1) {
    nights.push(fromDayNumber(day));
  }
  return nights;
}

/** True when one stay's checkout is another's check-in — a legitimate same-day turnover. */
export function isSameDayTurnover(
  departing: { checkOut: CalendarDate },
  arriving: { checkIn: CalendarDate },
): boolean {
  return compareDates(departing.checkOut, arriving.checkIn) === 0;
}

/** Sorted, de-duplicated night list — used to build stable idempotency fingerprints. */
export function normalizeNights(nights: readonly CalendarDate[]): CalendarDate[] {
  return [...new Set(nights.map(parseCalendarDate))].sort(compareDates);
}
