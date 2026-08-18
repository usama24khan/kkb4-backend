/**
 * KKB4 Maintenance System — Constants & Configuration
 *
 * Phase Logic (derive `phase` from block):
 *   Phase 1: Blocks A, B, H, I, J, K
 *   Phase 2: Blocks C, D, E, F, G
 *   Phase 3: Block  L
 *   Phase P: Block  P   (legacy / standalone — not part of the main 1-3 split)
 *
 * NOTE: This mapping was changed from the original 6-phase scheme. Existing
 * Plot records still carry their old `phase` value until the migration
 * script runs (`npm run migrate:phases`).
 */

// ── Phase Configuration ──────────────────────────────────────────────────────

export const PHASE_BLOCK_MAP: Record<string, string[]> = {
  "Phase 1": ["A", "B", "H", "I", "J", "K"],
  "Phase 2": ["C", "D", "E", "F", "G"],
  "Phase 3": ["L"],
  "Phase P": ["P"],
};

export const BLOCK_PHASE_MAP: Record<string, string> = {
  A: "Phase 1",
  B: "Phase 1",
  H: "Phase 1",
  I: "Phase 1",
  J: "Phase 1",
  K: "Phase 1",
  C: "Phase 2",
  D: "Phase 2",
  E: "Phase 2",
  F: "Phase 2",
  G: "Phase 2",
  L: "Phase 3",
  P: "Phase P",
};

export const ALL_BLOCKS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "P",
];

export const ALL_PHASES = [
  "Phase 1", "Phase 2", "Phase 3", "Phase P",
];

// ── Month Configuration ──────────────────────────────────────────────────────

export const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

export const MONTH_NAMES: Record<string, string> = {
  jan: "January",
  feb: "February",
  mar: "March",
  apr: "April",
  may: "May",
  jun: "June",
  jul: "July",
  aug: "August",
  sep: "September",
  oct: "October",
  nov: "November",
  dec: "December",
};

export const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// ── Year & Rate Configuration ────────────────────────────────────────────────

export const YEARS_WITH_DATA = [
  2012, 2013, 2014, 2015, 2016, 2017,
  2018, 2019, 2020, 2021, 2022, 2023,
  2024, 2025, 2026,
];

export const DEFAULT_MC_RATE = 200; // PKR per month (up to April 2022)
export const NEWER_MC_RATE = 400;   // PKR per month (from May 2022 onwards)

/**
 * When the monthly charge changed, and to what.
 *
 * The rise to PKR 400 took effect in **May 2022**, part-way through the year, so
 * a rate cannot be answered by year alone: January to April 2022 are still 200.
 * Entries are effective-from and must stay sorted oldest first.
 */
export const RATE_CHANGES: Array<{ year: number; month: number; rate: number }> = [
  { year: 2012, month: 1, rate: DEFAULT_MC_RATE },
  { year: 2022, month: 5, rate: NEWER_MC_RATE },
];

/**
 * The monthly charge for one specific month — the only rate function that is
 * correct for every month, and what all dues and receipt maths should use.
 */
export function getMcRateForMonth(year: number, month: number): number {
  let rate = RATE_CHANGES[0].rate;
  for (const change of RATE_CHANGES) {
    if (year > change.year || (year === change.year && month >= change.month)) rate = change.rate;
    else break;
  }
  return rate;
}

/**
 * A year's prevailing charge — its December rate.
 *
 * Kept for the places that can only show one number per year (the dues letter's
 * rate column, a plot's "rate" line). In a year the rate changed this is the
 * later figure, so use `getMcRateForMonth` wherever a month is known.
 */
export function getMcRateForYear(year: number): number {
  return getMcRateForMonth(year, 12);
}

/**
 * Total charge for a run of months in one year, inclusive.
 *
 * Months are added at their own rate rather than multiplied by a single figure,
 * which is what makes 2022 come out right: 200 for January to April and 400 from
 * May, so the year totals 4,000 and not 2,400 or 4,800.
 */
export function getChargeForMonths(year: number, fromMonth = 1, toMonth = 12): number {
  let total = 0;
  for (let m = Math.max(1, fromMonth); m <= Math.min(12, toMonth); m++) {
    total += getMcRateForMonth(year, m);
  }
  return total;
}

/** What a full year of maintenance costs. */
export function getChargeForYear(year: number): number {
  return getChargeForMonths(year, 1, 12);
}

export const MC_RATE_BY_YEAR: Record<number, number> = {};
for (const y of YEARS_WITH_DATA) {
  MC_RATE_BY_YEAR[y] = getMcRateForYear(y);
}

/**
 * Rate schedule for the GET /config/rates endpoint.
 */
export const RATE_SCHEDULE = [
  { from_year: 2012, from_month: 1, to_year: 2022, to_month: 4, monthly_rate: DEFAULT_MC_RATE },
  { from_year: 2022, from_month: 5, to_year: null, to_month: null, monthly_rate: NEWER_MC_RATE },
];

// ── Allotment Status ─────────────────────────────────────────────────────────

export const ALLOTMENT_STATUSES = [
  "Active",
  "Cancelled",
  "Unsold",
  "Unknown",
] as const;
