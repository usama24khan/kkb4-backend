/**
 * src/utils/excelParser.ts
 * (drop-in replacement — only change is using createBlockTracker per sheet)
 */

import * as XLSX from "xlsx";
import { createBlockTracker } from "./blockHelpers";
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

    if (
      !mapping.srNo &&
      (n === "sr" || n === "srno" || n === "sr#" || n.startsWith("sr"))
    )
      mapping.srNo = idx;
    if (
      !mapping.ownerName &&
      (n.includes("name") || n.includes("owner") || n.includes("allottee"))
    )
      mapping.ownerName = idx;
    if (!mapping.plotBlock && (n.includes("plot") || n.includes("block")))
      mapping.plotBlock = idx;
    if (
      !mapping.mcRate &&
      (n === "mc" ||
        n.includes("maintenance") ||
        n.includes("charge") ||
        n.includes("rate"))
    )
      mapping.mcRate = idx;
    if (
      !mapping.allotmentStatus &&
      (n.includes("allotment") || n.includes("status"))
    )
      mapping.allotmentStatus = idx;
    if (n.includes("total") && (n.includes("received") || n.includes("recv")))
      mapping.totalReceived = idx;
    if (n.includes("remaining") || n.includes("balance"))
      mapping.remaining = idx;

    const monthKey = MONTH_ALIASES[header?.toString().trim().toLowerCase()];
    if (monthKey && !(`month_${monthKey}` in mapping))
      mapping[`month_${monthKey}`] = idx;
  });

  return mapping;
}

export function parseExcelFile(filePath: string): ParsedPlotData[] {
  const workbook = XLSX.readFile(filePath);
  const allParsedData: ParsedPlotData[] = [];

  for (const sheetName of workbook.SheetNames) {
    const year = findYearFromSheetName(sheetName);
    if (!year) {
      console.log(`⚠️  Skipping sheet "${sheetName}" — no year detected`);
      continue;
    }

    console.log(`📄 Parsing sheet "${sheetName}" for year ${year}...`);

    const sheet = workbook.Sheets[sheetName];
    const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (data.length < 2) {
      console.log(`   ⚠️  Sheet is empty or has no data rows`);
      continue;
    }

    // Find header row
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(5, data.length); i++) {
      const row = data[i];
      if (
        row?.some((cell: any) => {
          const s = cell?.toString().trim().toLowerCase() || "";
          return s.includes("sr") || s.includes("name") || s.includes("plot");
        })
      ) {
        headerRowIdx = i;
        break;
      }
    }

    const headers = (data[headerRowIdx] || []).map(
      (h: any) => h?.toString() || "",
    );
    const columnMap = findColumnMapping(headers);
    const defaultMcRate = MC_RATE_BY_YEAR[year] || DEFAULT_MC_RATE;

    // ── One tracker per sheet — carries block letter forward row by row ──────
    const blockTracker = createBlockTracker();

    let parsedCount = 0;

    for (let i = headerRowIdx + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length === 0) continue;

      const plotBlockRaw =
        columnMap.plotBlock !== undefined
          ? row[columnMap.plotBlock]?.toString().trim()
          : "";
      if (!plotBlockRaw) continue;

      // Skip sub-header / summary rows
      const lower = plotBlockRaw.toLowerCase();
      if (
        lower.includes("plot") ||
        lower.includes("total") ||
        lower.includes("block") ||
        lower === ""
      )
        continue;

      // resolve() updates the tracked block when a letter is present,
      // otherwise inherits the last known block
      const { plotNumber, block } = blockTracker.resolve(plotBlockRaw);
      if (!plotNumber) continue;

      const ownerName =
        columnMap.ownerName !== undefined
          ? row[columnMap.ownerName]?.toString().trim() || "Unknown"
          : "Unknown";
      const srNo =
        columnMap.srNo !== undefined ? parseInt(row[columnMap.srNo]) || 0 : i;

      let mcRate = defaultMcRate;
      if (columnMap.mcRate !== undefined) {
        const rateVal = parseInt(row[columnMap.mcRate]);
        if (!isNaN(rateVal) && rateVal > 0) mcRate = rateVal;
      }

      let allotmentStatus = "Active";
      if (columnMap.allotmentStatus !== undefined) {
        const statusVal =
          row[columnMap.allotmentStatus]?.toString().trim().toLowerCase() || "";
        if (statusVal.includes("cancel")) allotmentStatus = "Cancelled";
        else if (statusVal === "yes" || statusVal === "active")
          allotmentStatus = "Active";
      }

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

    console.log(`   ✅ Parsed ${parsedCount} rows from year ${year}`);
  }

  return allParsedData;
}
