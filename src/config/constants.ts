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

export const DEFAULT_MC_RATE = 200; // PKR per month (years ≤ 2021)
export const NEWER_MC_RATE = 400;   // PKR per month (years ≥ 2022)

/**
 * Rate rule: monthly charge is PKR 200 for years 2012–2021,
 *            PKR 400 from 2022 onwards.
 */
export function getMcRateForYear(year: number): number {
  return year >= 2022 ? NEWER_MC_RATE : DEFAULT_MC_RATE;
}

export const MC_RATE_BY_YEAR: Record<number, number> = {};
for (const y of YEARS_WITH_DATA) {
  MC_RATE_BY_YEAR[y] = getMcRateForYear(y);
}

/**
 * Rate schedule for the GET /config/rates endpoint.
 */
export const RATE_SCHEDULE = [
  { from_year: 2012, to_year: 2021, monthly_rate: 200 },
  { from_year: 2022, to_year: null, monthly_rate: 400 },
];

// ── Allotment Status ─────────────────────────────────────────────────────────

export const ALLOTMENT_STATUSES = [
  "Active",
  "Cancelled",
  "Unsold",
  "Unknown",
] as const;
