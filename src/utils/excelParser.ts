/**
 * src/utils/excelParser.ts
 *
 * Parses KKB4 maintenance Excel file.
 *
 * Two problems solved together:
 *
 * 1. BLOCK TRACKER (from original blockHelpers logic, inlined here):
 *    The Excel uses a carry-forward convention:
 *      - First plot of a block:  "374 A"  (number + letter → sets current block)
 *      - Middle plots:           "375"    (plain number   → inherits current block)
 *      - Last plot of block:     "396 A"  (also sets block)
 *    Without this tracker, every middle-block row gets skipped.
 *
 * 2. DYNAMIC COLUMN DETECTION:
 *    Every sheet has a different layout — extra columns before months, 2023 has
 *    a blank col[0] shifting everything right, 2022 has duplicate month headers.
 *    We detect column positions by header name, not by hardcoded index.
 *    For duplicate month headers (2022) we take the LAST occurrence.
 */

import * as XLSX from "xlsx";
import { MC_RATE_BY_YEAR, MONTHS, DEFAULT_MC_RATE } from "../config/constants";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedPlotData {
  srNo: number;
  ownerName: string;
  plotNumber: string;
  block: string;
  plotBlock: string;
  allotmentStatus: string;
  mcRate: number;
  payments: Record<string, number | null>;
  year: number;
}

// ── Month header aliases ──────────────────────────────────────────────────────

const MONTH_ALIASES: Record<string, string> = {
  jan: "jan",
  january: "jan",
  "jan.": "jan",
  feb: "feb",
  february: "feb",
  "feb.": "feb",
  mar: "mar",
  march: "mar",
  "mar.": "mar",
  apr: "apr",
  april: "apr",
  "apr.": "apr",
  may: "may",
  jun: "jun",
  june: "jun",
  "jun.": "jun",
  jul: "jul",
  july: "jul",
  "jul.": "jul",
  aug: "aug",
  august: "aug",
  "aug.": "aug",
  sep: "sep",
  september: "sep",
  "sep.": "sep",
  sept: "sep",
  oct: "oct",
  october: "oct",
  "oct.": "oct",
  nov: "nov",
  november: "nov",
  "nov.": "nov",
  dec: "dec",
  december: "dec",
  "dec.": "dec",
};

// ── Column detection (dynamic, by header name) ────────────────────────────────

interface ColMap {
  srNo: number;
  name: number;
  plotBlock: number;
  mc: number;
  allotment: number | null;
  months: Record<string, number>; // month key → col index (last occurrence wins)
}

function normalizeHeader(h: any): string {
  if (h === null || h === undefined) return "";
  // Strip whitespace, newlines, dots, hashes, backslashes
  return String(h)
    .replace(/[\s\n\r\\.#\\\\]+/g, "")
    .toLowerCase()
    .trim();
}

function detectColumns(headerRow: any[]): ColMap | null {
  const normalized = headerRow.map(normalizeHeader);

  // srNo: matches "srno", "sr#", "sr", anything starting with "srn"
  const srNoIdx = normalized.findIndex(
    (h) => h === "srno" || h === "sr#" || h === "sr" || h.startsWith("srn"),
  );

  // name: exact "name"
  const nameIdx = normalized.findIndex((h) => h === "name");

  // plotBlock: contains both "plot" and "block"
  const plotBlockIdx = normalized.findIndex(
    (h) => h.includes("plot") && h.includes("block"),
  );

  // mc: exact "mc"
  const mcIdx = normalized.findIndex((h) => h === "mc");

  if (srNoIdx === -1 || nameIdx === -1 || plotBlockIdx === -1 || mcIdx === -1) {
    return null;
  }

  // allotment: optional — not present in sheets 2021+
  const allotmentIdx = normalized.findIndex((h) => h === "allotment");

  // Months: find ALL occurrences per month, take the LAST one.
  // This fixes 2022 which has Jan–Jun duplicated (we want the second set).
  const monthOccurrences: Record<string, number[]> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const raw = headerRow[i]?.toString().trim().toLowerCase() ?? "";
    const monthKey = MONTH_ALIASES[raw];
    if (monthKey) {
      if (!monthOccurrences[monthKey]) monthOccurrences[monthKey] = [];
      monthOccurrences[monthKey].push(i);
    }
  }

  const months: Record<string, number> = {};
  for (const [key, occurrences] of Object.entries(monthOccurrences)) {
    months[key] = occurrences[occurrences.length - 1]; // last occurrence wins
  }

  return {
    srNo: srNoIdx,
    name: nameIdx,
    plotBlock: plotBlockIdx,
    mc: mcIdx,
    allotment: allotmentIdx !== -1 ? allotmentIdx : null,
    months,
  };
}

// ── Block tracker (inlined from blockHelpers) ─────────────────────────────────

const VALID_BLOCK_LETTERS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));

/**
 * Extracts the block letter explicitly stated in a cell value, or null if none.
 *   "374 A"  → "A"
 *   "374A"   → "A"
 *   "Block A"→ "A"
 *   "374"    → null  (plain number — block must be inherited)
 */
function extractBlock(raw: string): string | null {
  const s = raw.trim();

  // "374 A" or "374A" — number then optional space then single letter
  const m1 = s.match(/^(\d+)\s*([A-Za-z])$/);
  if (m1) {
    const b = m1[2].toUpperCase();
    return VALID_BLOCK_LETTERS.has(b) ? b : null;
  }

  // "Block A" section header
  const m2 = s.match(/^[Bb]lock\s+([A-Za-z])$/);
  if (m2) {
    const b = m2[1].toUpperCase();
    return VALID_BLOCK_LETTERS.has(b) ? b : null;
  }

  return null;
}

/** Extracts the numeric plot number from "374 A", "374", "374A" → "374" */
function extractPlotNumber(raw: string): string | null {
  const m = raw.trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

/** True for pure section header rows like "Block A" — not a data row */
function isBlockHeaderRow(raw: string): boolean {
  return /^[Bb]lock\s+[A-Za-z]+$/.test(raw.trim());
}

/** Creates a stateful block tracker. Call resolve() for every data row. */
function createBlockTracker() {
  let currentBlock = "";
  return {
    resolve(raw: string): { plotNumber: string | null; block: string } {
      const block = extractBlock(raw);
      if (block) currentBlock = block;
      return { plotNumber: extractPlotNumber(raw), block: currentBlock };
    },
    reset() {
      currentBlock = "";
    },
  };
}

// ── Allotment status ──────────────────────────────────────────────────────────

function parseAllotmentStatus(
  raw: any,
): "Active" | "Cancelled" | "Unsold" | "Unknown" {
  if (raw === null || raw === undefined || raw === "") return "Active";
  const s = String(raw).trim().toLowerCase();
  if (s === "yes" || s === "active") return "Active";
  if (s.includes("cancel")) return "Cancelled";
  if (s.includes("unsold")) return "Unsold";
  if (!isNaN(Number(s))) return "Active"; // numeric carry-over values
  return "Unknown";
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseExcelFile(filePath: string): ParsedPlotData[] {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const allParsedData: ParsedPlotData[] = [];

  for (const sheetName of workbook.SheetNames) {
    // Derive year from sheet name (handles "2012", "M.C2013", "Maintanance Expense 2025", etc.)
    const yearMatch = sheetName.match(/(\d{4})/);
    if (!yearMatch) {
      console.log(`⚠️  Skipping sheet "${sheetName}" — no 4-digit year found`);
      continue;
    }
    const year = parseInt(yearMatch[1], 10);
    const defaultMcRate = MC_RATE_BY_YEAR?.[year] ?? DEFAULT_MC_RATE;

    console.log(`\n📄 Parsing sheet "${sheetName}" → year ${year}...`);

    const sheet = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
      raw: true,
    });

    if (rows.length < 2) {
      console.warn(`   ⚠️  Sheet "${sheetName}" has too few rows, skipping.`);
      continue;
    }

    // Header row is always index 1 (row 0 = title like "KKB4 MAINTENANCE - 2012")
    const colMap = detectColumns(rows[1]);
    if (!colMap) {
      console.warn(
        `   ⚠️  Could not detect required columns in "${sheetName}". Headers: ${JSON.stringify(rows[1])}`,
      );
      continue;
    }

    console.log(
      `   📌 Columns → srNo:${colMap.srNo} name:${colMap.name} plotBlock:${colMap.plotBlock} mc:${colMap.mc} allotment:${colMap.allotment}`,
    );
    console.log(`   📌 Months  → ${JSON.stringify(colMap.months)}`);

    // Fresh block tracker per sheet
    const blockTracker = createBlockTracker();
    let parsedCount = 0;
    let skippedCount = 0;

    // Data rows start at index 2
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every((c) => c === null || c === "")) continue;

      const rawPB = String(row[colMap.plotBlock] ?? "").trim();

      // Always feed into the tracker to keep block carry-forward alive
      // (even for rows we will skip for data output)
      blockTracker.resolve(rawPB);

      // Skip blank plotBlock
      if (!rawPB) {
        skippedCount++;
        continue;
      }

      // Skip "Block A" section header rows (they only update the tracker)
      if (isBlockHeaderRow(rawPB)) {
        skippedCount++;
        continue;
      }

      // Must start with a digit to be a valid plot row
      if (!/^\d/.test(rawPB)) {
        skippedCount++;
        continue;
      }

      // srNo must be a positive integer
      const rawSr = row[colMap.srNo];
      if (rawSr === null || rawSr === undefined) {
        skippedCount++;
        continue;
      }
      const srNo = parseInt(String(rawSr), 10);
      if (isNaN(srNo) || srNo <= 0) {
        skippedCount++;
        continue;
      }

      // Resolve plot number + block.
      // blockTracker.resolve() was already called above to keep carry-forward
      // state alive — calling it again here is safe because it is idempotent
      // (same input → same block state update).
      const { plotNumber: resolvedPlotNumber, block: resolvedBlock } =
        blockTracker.resolve(rawPB);

      if (!resolvedPlotNumber || !resolvedBlock) {
        skippedCount++;
        continue;
      }

      // Owner name
      const ownerName = String(row[colMap.name] ?? "").trim() || "Unknown";

      // MC rate
      let mcRate = defaultMcRate;
      const rawMc = row[colMap.mc];
      if (rawMc !== null && rawMc !== undefined) {
        const parsedMc = parseInt(String(rawMc), 10);
        if (!isNaN(parsedMc) && parsedMc > 0) mcRate = parsedMc;
      }

      // Allotment status
      const rawAllotment =
        colMap.allotment !== null ? row[colMap.allotment] : null;
      const allotmentStatus = parseAllotmentStatus(rawAllotment);

      // Monthly payments
      const payments: Record<string, number | null> = {};
      for (const month of MONTHS) {
        const colIdx = colMap.months[month];
        if (colIdx !== undefined) {
          const val = row[colIdx];
          const n =
            val !== null && val !== undefined && val !== "" ? Number(val) : NaN;
          payments[month] = isNaN(n) ? null : n;
        } else {
          payments[month] = null;
        }
      }

      allParsedData.push({
        srNo,
        ownerName,
        plotNumber: resolvedPlotNumber,
        block: resolvedBlock,
        plotBlock: `${resolvedPlotNumber} ${resolvedBlock}`,
        allotmentStatus,
        mcRate,
        payments,
        year,
      });
      parsedCount++;
    }

    console.log(
      `   ✅ Parsed ${parsedCount} rows | Skipped ${skippedCount} rows`,
    );
  }

  console.log(`\n📊 Grand total parsed: ${allParsedData.length} records`);
  return allParsedData;
}
