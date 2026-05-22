/**
 * src/utils/excelParser.ts
 *
 * Parses KKB4 maintenance Excel file.
 * Each sheet corresponds to a year (derived from sheet name).
 * Each row represents a plot's payment data for that year.
 *
 * Block tracking convention:
 *   - First/last plot of each block: "374 A" (number + space + letter)
 *   - Middle plots of a block: plain number "375"
 *   - Block letter is carried forward row-by-row via createBlockTracker()
 */

import * as XLSX from "xlsx";
import {
  createBlockTracker,
  isBlockHeaderRow,
  extractBlockFromPlotStr,
} from "./blockHelpers";
import { MC_RATE_BY_YEAR, MONTHS, DEFAULT_MC_RATE } from "../config/constants";

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

// ── Sheet → Year mapping ──────────────────────────────────────────────────────

const SHEET_YEAR_MAP: Record<string, number> = {
  "M.C2012": 2012,
  "M.C 2013": 2013,
  "M.C2014": 2014,
  "M.c2018": 2018,
  "M.c2019": 2019,
  "M.c2020": 2020,
  "M.c2021": 2021,
  "M.C 2022": 2022,
  "M.C 2023": 2023,
  "M.C 2024": 2024,
  "Maintanance Expense 2025": 2025,
  "Maintanance Expense 2026": 2026,
};

// ── Month aliases ─────────────────────────────────────────────────────────────

const MONTH_ALIASES: Record<string, string> = {
  january: "jan",
  jan: "jan",
  "jan.": "jan",
  february: "feb",
  feb: "feb",
  "feb.": "feb",
  march: "mar",
  mar: "mar",
  "mar.": "mar",
  april: "apr",
  apr: "apr",
  "apr.": "apr",
  may: "may",
  june: "jun",
  jun: "jun",
  "jun.": "jun",
  july: "jul",
  jul: "jul",
  "jul.": "jul",
  august: "aug",
  aug: "aug",
  "aug.": "aug",
  september: "sep",
  sep: "sep",
  "sep.": "sep",
  sept: "sep",
  october: "oct",
  oct: "oct",
  "oct.": "oct",
  november: "nov",
  nov: "nov",
  "nov.": "nov",
  december: "dec",
  dec: "dec",
  "dec.": "dec",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function findYearFromSheetName(sheetName: string): number | null {
  if (SHEET_YEAR_MAP[sheetName]) return SHEET_YEAR_MAP[sheetName];
  const m = sheetName.match(/(\d{4})/);
  return m ? parseInt(m[1]) : null;
}

function normalizeHeader(header: string): string {
  return (
    header
      ?.toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || ""
  );
}

function findColumnMapping(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};

  headers.forEach((header, idx) => {
    const n = normalizeHeader(header);
    if (!n) return;

    // Sr No
    if (
      mapping.srNo === undefined &&
      (n === "sr" || n === "srno" || n === "sr#" || n.startsWith("sr"))
    )
      mapping.srNo = idx;

    // Owner name
    if (
      mapping.ownerName === undefined &&
      (n.includes("name") || n.includes("owner") || n.includes("allottee"))
    )
      mapping.ownerName = idx;

    // Plot/Block column — must include "plot" or "block" but NOT be a month
    if (mapping.plotBlock === undefined) {
      const isMonth = !!MONTH_ALIASES[header?.toString().trim().toLowerCase()];
      if (!isMonth && (n.includes("plot") || n.includes("block"))) {
        mapping.plotBlock = idx;
      }
    }

    // MC Rate
    if (
      mapping.mcRate === undefined &&
      (n === "mc" ||
        n.includes("maintenance") ||
        n.includes("charge") ||
        n.includes("rate"))
    )
      mapping.mcRate = idx;

    // Allotment status
    if (
      mapping.allotmentStatus === undefined &&
      (n.includes("allotment") || n.includes("status"))
    )
      mapping.allotmentStatus = idx;

    // Total received
    if (
      mapping.totalReceived === undefined &&
      n.includes("total") &&
      (n.includes("received") || n.includes("recv"))
    )
      mapping.totalReceived = idx;

    // Remaining / balance
    if (
      mapping.remaining === undefined &&
      (n.includes("remaining") || n.includes("balance"))
    )
      mapping.remaining = idx;

    // Month columns
    const monthKey = MONTH_ALIASES[header?.toString().trim().toLowerCase()];
    if (monthKey && mapping[`month_${monthKey}`] === undefined)
      mapping[`month_${monthKey}`] = idx;
  });

  return mapping;
}

/**
 * Determines whether a row should be skipped entirely.
 * Skips: empty rows, summary rows (total/balance), and pure "Block X" headers
 * that have NO numeric plot number — those still update the blockTracker
 * but should not produce a data record.
 *
 * NOTE: We do NOT skip on the word "block" alone here because "374 A" style
 * rows are handled by blockTracker.resolve() which reads the block letter inline.
 */
function shouldSkipRow(plotBlockRaw: string): boolean {
  if (!plotBlockRaw) return true;

  const lower = plotBlockRaw.toLowerCase().trim();

  // Skip blank
  if (lower === "") return true;

  // Skip pure section headers like "Block A", "BLOCK B"
  // (these update the tracker in the caller but don't produce records)
  if (isBlockHeaderRow(plotBlockRaw)) return true;

  // Skip summary/footer rows
  if (
    lower.includes("total") ||
    lower.includes("balance") ||
    lower.includes("remaining") ||
    lower === "plot" ||
    lower === "plot no" ||
    lower === "plot no."
  )
    return true;

  // Row must start with a digit to be a valid plot row
  if (!/^\d/.test(lower)) return true;

  return false;
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseExcelFile(filePath: string): ParsedPlotData[] {
  const workbook = XLSX.readFile(filePath);
  const allParsedData: ParsedPlotData[] = [];

  for (const sheetName of workbook.SheetNames) {
    const year = findYearFromSheetName(sheetName);
    if (!year) {
      console.log(`⚠️  Skipping sheet "${sheetName}" — no year detected`);
      continue;
    }

    console.log(`\n📄 Parsing sheet "${sheetName}" for year ${year}...`);

    const sheet = workbook.Sheets[sheetName];
    const data: any[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
    });

    if (data.length < 2) {
      console.log(`   ⚠️  Sheet is empty or has no data rows`);
      continue;
    }

    // ── Find header row (scan first 10 rows) ──────────────────────────────
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(10, data.length); i++) {
      const row = data[i];
      if (!row) continue;
      const hasHeader = row.some((cell: any) => {
        const s = cell?.toString().trim().toLowerCase() || "";
        return (
          s === "sr" ||
          s === "sr." ||
          s === "sr no" ||
          s === "sr#" ||
          s.includes("name") ||
          s.includes("owner") ||
          s.includes("plot")
        );
      });
      if (hasHeader) {
        headerRowIdx = i;
        break;
      }
    }

    const headers = (data[headerRowIdx] || []).map(
      (h: any) => h?.toString() || "",
    );
    const columnMap = findColumnMapping(headers);
    const defaultMcRate = MC_RATE_BY_YEAR[year] || DEFAULT_MC_RATE;

    // Debug log — helps diagnose mapping issues
    console.log(`   📌 Header row index: ${headerRowIdx}`);
    console.log(`   📌 Headers: ${JSON.stringify(headers)}`);
    console.log(`   📌 Column map: ${JSON.stringify(columnMap)}`);

    if (columnMap.plotBlock === undefined) {
      console.warn(
        `   ⚠️  Could not find plot/block column in sheet "${sheetName}" — skipping`,
      );
      continue;
    }

    // ── One tracker per sheet — resets block state between sheets ─────────
    const blockTracker = createBlockTracker();

    let parsedCount = 0;
    let skippedCount = 0;

    for (let i = headerRowIdx + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.every((c: any) => c === null || c === "")) continue;

      const plotBlockRaw = row[columnMap.plotBlock]?.toString().trim() ?? "";

      // Always feed into tracker so block letter propagates — even for
      // "Block A" header rows that we skip for data output
      if (plotBlockRaw) {
        const embeddedBlock = extractBlockFromPlotStr(plotBlockRaw);
        if (embeddedBlock) {
          // Pre-update tracker for header rows before the skip check
          blockTracker.resolve(plotBlockRaw);
        }
      }

      if (shouldSkipRow(plotBlockRaw)) {
        skippedCount++;
        continue;
      }

      // Resolve plot number + block (block inherited if not in this cell)
      const { plotNumber, block } = blockTracker.resolve(plotBlockRaw);

      if (!plotNumber) {
        skippedCount++;
        continue;
      }

      // Skip rows where block is still empty (no block seen yet in sheet)
      if (!block) {
        console.warn(
          `   ⚠️  Row ${i}: plotNumber="${plotNumber}" has no block — skipping`,
        );
        skippedCount++;
        continue;
      }

      // ── Owner name ──────────────────────────────────────────────────────
      const ownerName =
        columnMap.ownerName !== undefined
          ? row[columnMap.ownerName]?.toString().trim() || "Unknown"
          : "Unknown";

      // ── Sr No ───────────────────────────────────────────────────────────
      const srNo =
        columnMap.srNo !== undefined ? parseInt(row[columnMap.srNo]) || i : i;

      // ── MC Rate ─────────────────────────────────────────────────────────
      let mcRate = defaultMcRate;
      if (columnMap.mcRate !== undefined) {
        const rateVal = parseInt(row[columnMap.mcRate]);
        if (!isNaN(rateVal) && rateVal > 0) mcRate = rateVal;
      }

      // ── Allotment status ────────────────────────────────────────────────
      let allotmentStatus = "Active";
      if (columnMap.allotmentStatus !== undefined) {
        const statusVal =
          row[columnMap.allotmentStatus]?.toString().trim().toLowerCase() || "";
        if (statusVal.includes("cancel")) allotmentStatus = "Cancelled";
        else if (statusVal.includes("unsold")) allotmentStatus = "Unsold";
        else if (statusVal === "yes" || statusVal === "active")
          allotmentStatus = "Active";
      }

      // ── Monthly payments ────────────────────────────────────────────────
      const payments: Record<string, number | null> = {};
      for (const month of MONTHS) {
        const colIdx = columnMap[`month_${month}`];
        if (colIdx !== undefined) {
          const val = row[colIdx];
          payments[month] =
            val !== undefined &&
            val !== null &&
            val !== "" &&
            !isNaN(Number(val))
              ? Number(val)
              : null;
        } else {
          payments[month] = null;
        }
      }

      allParsedData.push({
        srNo,
        ownerName,
        plotNumber,
        block,
        plotBlock: `${plotNumber} ${block}`,
        allotmentStatus,
        mcRate,
        payments,
        year,
      });

      parsedCount++;
    }

    console.log(
      `   ✅ Parsed ${parsedCount} rows | Skipped ${skippedCount} rows from year ${year}`,
    );
  }

  console.log(`\n📊 Grand total parsed records: ${allParsedData.length}`);
  return allParsedData;
}
