export const PHASE_BLOCK_MAP: Record<number, string[]> = {
  1: ["A", "B", "K", "J", "I", "H"],
  2: ["C", "D", "E", "F", "G"],
  3: ["L"],
};

export const BLOCK_PHASE_MAP: Record<string, number> = {
  A: 1,
  B: 1,
  K: 1,
  J: 1,
  I: 1,
  H: 1,
  C: 2,
  D: 2,
  E: 2,
  F: 2,
  G: 2,
  L: 3,
};

export const ALL_BLOCKS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
];

export const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
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

export const YEARS_WITH_DATA = [
  2012, 2013, 2014, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
];

export const DEFAULT_MC_RATE = 200; // PKR per month (older years)
export const NEWER_MC_RATE = 400; // PKR per month (recent years)

export const MC_RATE_BY_YEAR: Record<number, number> = {
  2012: 200,
  2013: 200,
  2014: 200,
  2018: 200,
  2019: 200,
  2020: 200,
  2021: 200,
  2022: 200,
  2023: 400,
  2024: 400,
  2025: 400,
  2026: 400,
};

export const ALLOTMENT_STATUSES = [
  "Active",
  "Cancelled",
  "Unsold",
  "Unknown",
] as const;
