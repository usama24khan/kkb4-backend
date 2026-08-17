/**
 * financePeriod.ts
 * ================
 * Accounting-period helpers for the society cash book.
 *
 * Every money movement (a collection received, an expense paid) is stamped with
 * a *book period* — the year + month it belongs to in the ledger. The period is
 * derived from the real-world date in **Asia/Karachi**, never from the server's
 * local zone: a payment taken at 11pm in Lahore must not land in the next month
 * because Vercel happens to run the function in UTC.
 *
 * Periods are compared as a single ordinal (`year * 12 + month`) so "everything
 * up to and including March 2026" is one integer comparison instead of an
 * awkward $or on two fields.
 */

import { MONTHS } from '../config/constants';

export const SOCIETY_TIMEZONE = 'Asia/Karachi';

export interface BookPeriod {
  /** Four-digit calendar year, e.g. 2026. */
  bookYear: number;
  /** 1 = January … 12 = December. */
  bookMonth: number;
}

/** Formatter reused across calls — constructing one per call is measurably slow. */
const karachiParts = new Intl.DateTimeFormat('en-US', {
  timeZone: SOCIETY_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Split a Date into its Asia/Karachi calendar year / month / day.
 */
export function karachiYmd(date: Date): { year: number; month: number; day: number } {
  const parts = karachiParts.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * The book period a real-world date falls into.
 */
export function toBookPeriod(date: Date): BookPeriod {
  const { year, month } = karachiYmd(date);
  return { bookYear: year, bookMonth: month };
}

/** The current book period (today, society time). */
export function currentBookPeriod(): BookPeriod {
  return toBookPeriod(new Date());
}

/**
 * Collapse a period into a sortable/comparable ordinal.
 * March 2026 → 2026 * 12 + 3 = 24315.
 */
export function periodOrdinal(year: number, month: number): number {
  return year * 12 + month;
}

/** Inverse of {@link periodOrdinal}. */
export function fromOrdinal(ordinal: number): BookPeriod {
  const bookMonth = ((ordinal - 1) % 12) + 1;
  const bookYear = Math.floor((ordinal - bookMonth) / 12);
  return { bookYear, bookMonth };
}

/** `'jan'`…`'dec'` for a 1-based month number. */
export function monthKey(month: number): string {
  return MONTHS[month - 1];
}

/** 1-based month number for a `'jan'`…`'dec'` key (0 when unrecognised). */
export function monthNumber(key: string): number {
  return MONTHS.indexOf(String(key).toLowerCase() as any) + 1;
}

/**
 * Parse a caller-supplied month (either `'jan'`-style key or `1`–`12`) into a
 * month number, or null when it isn't a valid month.
 */
export function parseMonthParam(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && value >= 1 && value <= 12) return Math.trunc(value);
  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= 12) return asNumber;
  const fromKey = monthNumber(String(value));
  return fromKey > 0 ? fromKey : null;
}

/**
 * A Date pinned to noon on the last day of the given month, used as the
 * stand-in "received date" for historical backfill where the real day is
 * unknown. Noon keeps the date inside the intended month in every timezone.
 */
export function monthEndDate(year: number, month: number): Date {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, month, 0, 12, 0, 0));
}
