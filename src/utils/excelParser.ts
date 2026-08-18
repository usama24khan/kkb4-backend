/**
 * src/utils/excelParser.ts
 *
 * Reads a KKB4 maintenance workbook into plot + payment records.
 *
 * The workbooks are hand-kept spreadsheets, not exports, so almost nothing about
 * their shape is constant. What this parser therefore works out per sheet:
 *
 *  1. WHERE THE HEADER IS. Some sheets put it on row 2, others on row 3 or 1,
 *     under one or two rows of year banners.
 *
 *  2. WHICH COLUMNS ARE WHICH. Extra columns come and go — "Allotment",
 *     "Prev. Balance", "Remaining", "Received to date" — so columns are found by
 *     header name, never by position. Month headers are sometimes real dates
 *     rather than text ("42736" is January 2017), which is handled too.
 *
 *  3. HOW MANY YEARS ARE ON THE SHEET. The sheet named "M.C" carries 2017, 2016
 *     and 2015 side by side, each a full Jan-Dec run, labelled by a banner above
 *     each block. Month columns are therefore grouped into blocks (a new block
 *     starts wherever the month sequence restarts) and each block is matched to
 *     the year banner sitting above it.
 *
 *  4. WHICH BLOCK TO BELIEVE when one year has two. The 2022 sheet has a spare
 *     Jan-Apr block holding different figures from the real one; the sheet's own
 *     "Received to date" column agrees with the full twelve-month block for all
 *     284 plots, so the longest block wins and the leftover is reported.
 *
 *  5. WHICH BLOCK A PLOT NUMBER BELONGS TO. The sheets write the block letter
 *     once and leave it out afterwards: "374 A" then "375", "376"… so the letter
 *     is carried forward down the column.
 *
 * Nothing that carries money is ever dropped in silence. Every row that cannot be
 * imported, and every choice made about an ambiguous layout, is returned in
 * `issues` for the caller to print — that is what turned a quiet ₨49,700
 * shortfall into a short list of spreadsheet corrections.
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
  /** The sheet's own "received this year" figure, when it has one. */
  statedReceived?: number | null;
  /** Where this came from, for tracing a figure back to the spreadsheet. */
  source: { sheet: string; row: number };
}

export interface ParseIssue {
  sheet: string;
  /** 1-based row number as Excel shows it, when the issue is about a row. */
  row: number | null;
  kind:
    | "unimportable-row"
    | "duplicate-month-columns"
    | "no-columns"
    | "year-conflict"
    | "total-mismatch"
    | "excluded-non-plot"
    | "duplicate-plot-row"
    | "block-mismatch";
  message: string;
  /** Money at stake, where that applies. */
  amount?: number;
}

export interface ParseResult {
  records: ParsedPlotData[];
  issues: ParseIssue[];
  /** Sheets that carry no plot table at all — expense sheets and scratch tabs. */
  skippedSheets: string[];
}

// ── Month headers ─────────────────────────────────────────────────────────────

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_ALIASES: Record<string, string> = {};
for (const [key, idx] of Object.entries(MONTH_INDEX)) {
  const long = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ][idx];
  MONTH_ALIASES[key] = key;
  MONTH_ALIASES[long] = key;
  MONTH_ALIASES[`${key}.`] = key;
}
MONTH_ALIASES.sept = "sep";

/**
 * The month a header cell names, or null.
 *
 * Handles a plain name, and the case where the header is a real date — a January
 * heading typed as a date arrives as the serial 42736.
 */
function headerMonth(cell: any): string | null {
  if (cell === null || cell === undefined || cell === "") return null;

  if (cell instanceof Date) return Object.keys(MONTH_INDEX)[cell.getMonth()] ?? null;

  if (typeof cell === "number") {
    // Excel day numbers for 1990-2050 or so; anything smaller is a quantity.
    if (cell > 20000 && cell < 60000) {
      const parsed: any = (XLSX as any).SSF?.parse_date_code?.(cell);
      if (parsed?.m) return Object.keys(MONTH_INDEX)[parsed.m - 1] ?? null;
    }
    return null;
  }

  const text = String(cell).trim().toLowerCase();
  return MONTH_ALIASES[text] ?? null;
}

function normalizeHeader(cell: any): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).replace(/[\s\n\r\\.#]+/g, "").toLowerCase().trim();
}

// ── Column map ────────────────────────────────────────────────────────────────

interface MonthBlock {
  /** Month key → column index, for one year's run of months. */
  columns: Record<string, number>;
  firstCol: number;
  lastCol: number;
}

interface ColMap {
  name: number;
  plotBlock: number;
  mc: number;
  srNo: number | null;
  allotment: number | null;
  /** "Total Received" / "Received to up Date" — the sheet's own year total. */
  statedReceived: number | null;
  blocks: MonthBlock[];
}

/**
 * Read the header row. Returns null when this row is not a header, which is how
 * the header row is located and how non-plot sheets are recognised.
 */
function detectColumns(headerRow: any[]): ColMap | null {
  if (!headerRow) return null;
  const normalized = headerRow.map(normalizeHeader);

  const nameIdx = normalized.findIndex((h) => h === "name");
  const plotBlockIdx = normalized.findIndex((h) => h.includes("plot"));
  const mcIdx = normalized.findIndex((h) => h === "mc");
  if (nameIdx === -1 || plotBlockIdx === -1 || mcIdx === -1) return null;

  const srNoIdx = normalized.findIndex(
    (h) => h === "srno" || h === "sr" || h.startsWith("srn") || h === "sr#",
  );
  const allotmentIdx = normalized.findIndex((h) => h === "allotment");
  const statedIdx = normalized.findIndex(
    (h) => h.startsWith("totalreceived") || h === "total" || h.startsWith("recevied") || h.startsWith("received"),
  );

  // Group month columns into runs. A run ends where the month sequence restarts,
  // which is what separates one year's block from the next.
  const blocks: MonthBlock[] = [];
  let current: MonthBlock | null = null;
  let previousMonth = -1;

  for (let col = 0; col < headerRow.length; col++) {
    const month = headerMonth(headerRow[col]);
    if (!month) continue;

    const idx = MONTH_INDEX[month];
    if (!current || idx <= previousMonth) {
      current = { columns: {}, firstCol: col, lastCol: col };
      blocks.push(current);
    }
    current.columns[month] = col;
    current.lastCol = col;
    previousMonth = idx;
  }

  if (blocks.length === 0) return null;

  return {
    name: nameIdx,
    plotBlock: plotBlockIdx,
    mc: mcIdx,
    srNo: srNoIdx === -1 ? null : srNoIdx,
    allotment: allotmentIdx === -1 ? null : allotmentIdx,
    statedReceived: statedIdx === -1 ? null : statedIdx,
    blocks,
  };
}

/** Year banners above the header, with the column they sit over. */
function findYearLabels(rows: any[][], headerRow: number): { col: number; year: number }[] {
  const labels: { col: number; year: number }[] = [];
  for (let r = 0; r < headerRow; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const value = row[c];
      if (value === null || value === undefined || value === "") continue;
      const year = parseInt(String(value).trim(), 10);
      if (year >= 2000 && year <= 2100 && String(value).trim().length === 4) {
        labels.push({ col: c, year });
      }
    }
  }
  return labels;
}

/**
 * People who appear in the maintenance sheets but hold no KKB4 plot.
 *
 * They sit at the foot of the 2021 sheet with no plot number, and again from 2022
 * under a "Gilani" plot cell — a neighbouring scheme, not this society. The
 * committee confirmed they are not KKB4 plots, so their rows are excluded on
 * purpose and reported as such: a permanent warning about rows nobody intends to
 * fix would only teach people to ignore the report.
 *
 * Matched on the tidied name, and only for rows that carry no usable plot number —
 * so if one of them is ever allotted a plot, it imports normally.
 */
const NON_KKB_ENTRIES = new Set(["saith manna tanveer", "saith tanveer", "m hanif"]);

/** Lower-cased, punctuation-free form of a name, for matching. */
function canonicalName(raw: string): string {
  return raw.replace(/[().,]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// ── Block letter carry-forward ────────────────────────────────────────────────

const VALID_BLOCK_LETTERS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));

function extractBlock(raw: string): string | null {
  const s = raw.trim();
  const withLetter = s.match(/^(\d+)\s*([A-Za-z])$/);
  if (withLetter) {
    const letter = withLetter[2].toUpperCase();
    return VALID_BLOCK_LETTERS.has(letter) ? letter : null;
  }
  const section = s.match(/^[Bb]lock\s+([A-Za-z])$/);
  if (section) {
    const letter = section[1].toUpperCase();
    return VALID_BLOCK_LETTERS.has(letter) ? letter : null;
  }
  return null;
}

function extractPlotNumber(raw: string): string | null {
  const m = raw.trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

function isBlockHeaderRow(raw: string): boolean {
  return /^[Bb]lock\s+[A-Za-z]+$/.test(raw.trim());
}

function createBlockTracker() {
  let currentBlock = "";
  return {
    resolve(raw: string): { plotNumber: string | null; block: string } {
      const block = extractBlock(raw);
      if (block) currentBlock = block;
      return { plotNumber: extractPlotNumber(raw), block: currentBlock };
    },
  };
}

// ── Allotment status ──────────────────────────────────────────────────────────

function parseAllotmentStatus(raw: any): "Active" | "Cancelled" | "Unsold" | "Unknown" {
  if (raw === null || raw === undefined || raw === "") return "Active";
  const s = String(raw).trim().toLowerCase();
  if (s === "yes" || s === "active") return "Active";
  if (s.includes("cancel")) return "Cancelled";
  if (s.includes("unsold")) return "Unsold";
  if (!isNaN(Number(s))) return "Active"; // carried-over numeric values
  return "Unknown";
}

// ── Numbers ───────────────────────────────────────────────────────────────────

function money(cell: any): number {
  if (cell === null || cell === undefined || cell === "") return 0;
  const n = Number(String(cell).replace(/[, ]/g, ""));
  return isNaN(n) ? 0 : n;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Blocks the committee confirmed by hand, for plots no sheet ever spells out.
 *
 * 338 and 370 open and close the block B list the committee supplied, but neither
 * row carries the letter in any sheet, so nothing in the files can place them.
 * Reading the letter down the column puts 338 in block A, which is wrong.
 */
/** The prime series, and where plots outside every confirmed block list go. */
const PRIME_BLOCK = "P";

const CONFIRMED_BLOCKS: Record<string, string> = {
  "338": "B",
  "370": "B",
};

/**
 * Reads plot number → block from every cell in a workbook that states both.
 *
 * The sheets write a block letter once and leave it off the rows beneath, so a
 * section that opens with a bare number takes its letter from whatever came
 * before. In the 2018 and 2019 sheets block B opens on "345" with the "B" not
 * appearing until a later row, which quietly filed Rasheeda Bibi and M.Farooq
 * under block A and split them off as separate plots.
 *
 * A workbook that spells the block out on every row — the reconciled
 * KKB4_Maintenance sheet does — therefore makes a better authority than reading
 * down the column and hoping. Pass the result to {@link parseWorkbook}.
 */
export function buildBlockMap(filePath: string): Map<string, string> {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const map = new Map<string, string>();

  for (const sheetName of workbook.SheetNames) {
    const rows: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: null,
      blankrows: false,
      raw: true,
    });

    let headerRow = -1;
    let colMap: ColMap | null = null;
    for (let r = 0; r < Math.min(10, rows.length); r++) {
      const candidate = detectColumns(rows[r]);
      if (candidate) { headerRow = r; colMap = candidate; break; }
    }
    if (!colMap) continue;

    for (let r = headerRow + 1; r < rows.length; r++) {
      const raw = String((rows[r] || [])[colMap.plotBlock] ?? "").trim();
      const block = extractBlock(raw);
      const plotNumber = extractPlotNumber(raw);
      if (block && plotNumber && Number(plotNumber) > 0) map.set(plotNumber, block);
    }
  }

  for (const [plotNumber, block] of Object.entries(CONFIRMED_BLOCKS)) map.set(plotNumber, block);

  return map;
}

/** Back-compatible wrapper: records only. Prefer {@link parseWorkbook}. */
export function parseExcelFile(filePath: string): ParsedPlotData[] {
  return parseWorkbook(filePath).records;
}

export function parseWorkbook(
  filePath: string,
  options: {
    /**
     * plot number → block, taking precedence over reading the letter down the
     * column. See {@link buildBlockMap}.
     */
    blockMap?: Map<string, string>;
  } = {},
): ParseResult {
  const blockMap = options.blockMap;
  const workbook = XLSX.readFile(filePath, { raw: true, cellDates: false });
  const records: ParsedPlotData[] = [];
  const issues: ParseIssue[] = [];
  const skippedSheets: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const rows: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: null,
      blankrows: false,
      raw: true,
    });

    // Find the header row. Sheets put it anywhere in the first few rows, under
    // year banners; a sheet with no such row is not a plot table at all.
    let headerRow = -1;
    let colMap: ColMap | null = null;
    for (let r = 0; r < Math.min(10, rows.length); r++) {
      const candidate = detectColumns(rows[r]);
      if (candidate) {
        headerRow = r;
        colMap = candidate;
        break;
      }
    }

    if (!colMap || headerRow === -1) {
      skippedSheets.push(sheetName);
      continue;
    }

    // ── Which year does each month block belong to? ────────────────────────
    const labels = findYearLabels(rows, headerRow);
    const nameYear = sheetName.match(/(20\d{2})/);
    const labelYears = [...new Set(labels.map((l) => l.year))];

    const blockYears: (number | null)[] = colMap.blocks.map((block) => {
      const inside = labels.find((l) => l.col >= block.firstCol && l.col <= block.lastCol);
      if (inside) return inside.year;
      return null;
    });

    // One year for the whole sheet: keep the longest block and report the rest.
    // (The 2022 sheet's spare Jan-Apr block is the reason this exists.)
    const distinctAssigned = new Set(blockYears.filter((y) => y !== null));
    if (colMap.blocks.length > 1 && distinctAssigned.size <= 1) {
      const fallbackYear =
        [...distinctAssigned][0] ?? (labelYears.length === 1 ? labelYears[0] : null) ??
        (nameYear ? parseInt(nameYear[1], 10) : null);

      let bestIdx = 0;
      for (let b = 1; b < colMap.blocks.length; b++) {
        if (
          Object.keys(colMap.blocks[b].columns).length >=
          Object.keys(colMap.blocks[bestIdx].columns).length
        ) {
          bestIdx = b;
        }
      }

      for (let b = 0; b < colMap.blocks.length; b++) {
        blockYears[b] = b === bestIdx ? fallbackYear : null;
        if (b === bestIdx) continue;
        const spare = colMap.blocks[b];
        let spareMoney = 0;
        for (let r = headerRow + 1; r < rows.length; r++) {
          for (const col of Object.values(spare.columns)) spareMoney += money((rows[r] || [])[col]);
        }
        issues.push({
          sheet: sheetName,
          row: headerRow + 1,
          kind: "duplicate-month-columns",
          amount: spareMoney,
          message:
            `columns ${XLSX.utils.encode_col(spare.firstCol)}-${XLSX.utils.encode_col(spare.lastCol)} repeat ` +
            `${Object.keys(spare.columns).join(", ")} for the same year and were ignored ` +
            `(₨${spareMoney.toLocaleString()} in them). The ${Object.keys(colMap.blocks[bestIdx].columns).length}-month block ` +
            `${XLSX.utils.encode_col(colMap.blocks[bestIdx].firstCol)}-${XLSX.utils.encode_col(colMap.blocks[bestIdx].lastCol)} was used, ` +
            `which is the one the sheet's own "received to date" column agrees with.`,
        });
      }
    } else {
      // Several years side by side: fill any gap from the sheet name.
      for (let b = 0; b < blockYears.length; b++) {
        if (blockYears[b] === null && nameYear) blockYears[b] = parseInt(nameYear[1], 10);
      }
    }

    // A sheet whose name and banner disagree is not safe to guess at.
    if (nameYear && labelYears.length === 1 && parseInt(nameYear[1], 10) !== labelYears[0]) {
      issues.push({
        sheet: sheetName,
        row: null,
        kind: "year-conflict",
        message:
          `the tab is named ${nameYear[1]} but the banner inside says ${labelYears[0]}. ` +
          `Nothing was imported from it — rename the tab or fix the banner so they agree.`,
      });
      skippedSheets.push(sheetName);
      continue;
    }

    // ── Rows ──────────────────────────────────────────────────────────────
    const tracker = createBlockTracker();

    /**
     * Sheets from 2022 onwards carry a second table at the foot, under a header
     * whose plot column reads "PRIME\\ PLOT". Those rows are the prime plots — a
     * separate series that began in 2022 — and they live in block P.
     *
     * Their identity comes from the prime number when the sheet gives one
     * (Rana Qaisar 116, Saiban 54/56/57, Shahid 63, Faizullah 48). Six of them
     * have no number at all, so the name is the only thing identifying them and is
     * used as the plot number, which keeps them stable across years without
     * inventing a number the society has not issued.
     */
    let primeMode = false;

    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (row.every((c) => c === null || c === "")) continue;

      // The prime-plot table announces itself with its own header row.
      if (row.some((c) => normalizeHeader(c).includes("primeplot"))) {
        primeMode = true;
        continue;
      }

      const rawPlot = String(row[colMap.plotBlock] ?? "").trim();
      if (!primeMode) tracker.resolve(rawPlot); // keep carry-forward alive

      // Only count the blocks actually in use. A spare block's contents are
      // reported once, for the sheet as a whole; counting them again per row would
      // present scratch figures as lost payments.
      let rowMoney = 0;
      colMap.blocks.forEach((block, blockIdx) => {
        if (!blockYears[blockIdx]) return;
        for (const col of Object.values(block.columns)) rowMoney += money(row[col]);
      });

      const owner = String(row[colMap.name] ?? "").trim();
      const srCell = colMap.srNo !== null ? row[colMap.srNo] : null;
      const namesSomebody = !!owner || (srCell !== null && srCell !== undefined && srCell !== "");
      const isTotalsRow = !namesSomebody || row.some((c) => /total/i.test(String(c ?? "")));

      // A confirmed non-KKB4 entry is set aside, not flagged.
      if (NON_KKB_ENTRIES.has(canonicalName(owner))) {
        const plotCellUsable = /^\d/.test(rawPlot) && Number(rawPlot) !== 0;
        if (!plotCellUsable) {
          if (rowMoney > 0) {
            issues.push({
              sheet: sheetName,
              row: r + 1,
              kind: "excluded-non-plot",
              amount: rowMoney,
              message: `${owner || "(no name)"} — not a KKB4 plot, so this row is excluded by agreement.`,
            });
          }
          continue;
        }
      }

      const dropRow = (why: string) => {
        if (rowMoney > 0 && !isTotalsRow) {
          issues.push({
            sheet: sheetName,
            row: r + 1,
            kind: "unimportable-row",
            amount: rowMoney,
            message: `${owner || "(no name)"} — ${why}. ₨${rowMoney.toLocaleString()} was not imported.`,
          });
        }
      };

      let plotNumber: string | null;
      let block: string;

      if (primeMode) {
        // Blank filler rows run to the foot of every one of these tables.
        if (!owner && rowMoney === 0) continue;
        if (!owner) {
          dropRow("a prime-plot row with no name");
          continue;
        }
        const primeNumber = Number(rawPlot);
        // Where the sheet gives no prime number the name is the only identity, so
        // it is tidied first: 2022 writes "M. Rizwan" and later years "M Rizwan",
        // and taken literally that one full stop would split him into two plots.
        const canonicalName = owner.replace(/\./g, "").replace(/\s+/g, " ").trim();
        plotNumber =
          rawPlot && !isNaN(primeNumber) && primeNumber > 0 ? String(primeNumber) : canonicalName;
        block = PRIME_BLOCK;
      } else {
        if (!rawPlot) {
          dropRow("the plot/block cell is empty, so there is no plot to attach it to");
          continue;
        }
        if (isBlockHeaderRow(rawPlot)) continue;
        if (!/^\d/.test(rawPlot)) {
          dropRow(`the plot/block cell reads "${rawPlot}" instead of a plot number`);
          continue;
        }

        const resolved = tracker.resolve(rawPlot);
        plotNumber = resolved.plotNumber;
        block = resolved.block;

        // A supplied map is the authority; the letter carried down the column is
        // only a fallback, and where the two disagree the disagreement is stated
        // rather than settled quietly.
        const mapped = plotNumber ? blockMap?.get(plotNumber) : undefined;
        if (mapped) {
          const statedLetter = extractBlock(rawPlot);
          if (statedLetter && statedLetter !== mapped) {
            issues.push({
              sheet: sheetName,
              row: r + 1,
              kind: "block-mismatch",
              message:
                `plot ${plotNumber} is written as block ${statedLetter} here but the plot register says ` +
                `block ${mapped}. The register was used.`,
            });
          }
          block = mapped;
        } else if (blockMap && plotNumber) {
          // The committee's block lists (A, B, C, J, L …) are complete, so a plot
          // number outside all of them is not in a lettered block at all. Reading
          // the letter down the column would file it under whichever section it
          // happens to sit in — which is how plot 338 ended up in A. Such plots go
          // to P, the prime series, until the committee places them.
          const guessed = block || "none";
          block = PRIME_BLOCK;
          issues.push({
            sheet: sheetName,
            row: r + 1,
            kind: "block-mismatch",
            message:
              `plot ${plotNumber} (${owner || "no name"}) is in none of the confirmed block lists, ` +
              `so it was placed in block ${PRIME_BLOCK} (prime plots) rather than block ${guessed}, ` +
              `which is only where it happens to sit in the sheet.`,
          });
        }

        if (!plotNumber || !block) {
          dropRow(`no block letter could be worked out for "${rawPlot}"`);
          continue;
        }

        // A plot cell holding 0 is a placeholder, not a plot. Several rows carry
        // it at once and they would otherwise collapse onto one imaginary
        // "plot 0", the last row wiping the ones before it.
        if (Number(plotNumber) === 0) {
          dropRow("the plot number is 0, which is a placeholder rather than a plot");
          continue;
        }
      }

      // The SR number is a line number in the spreadsheet, not part of a plot's
      // identity — a blank one is no reason to throw the row away.
      const parsedSr = parseInt(String(srCell ?? ""), 10);
      const srNo = isNaN(parsedSr) || parsedSr <= 0 ? 0 : parsedSr;

      const ownerName = owner || "Unknown";
      const rawMc = money(row[colMap.mc]);
      const allotmentStatus = parseAllotmentStatus(
        colMap.allotment !== null ? row[colMap.allotment] : null,
      );
      const stated = colMap.statedReceived !== null ? money(row[colMap.statedReceived]) : null;

      // One record per year on the sheet.
      colMap.blocks.forEach((monthBlock, blockIdx) => {
        const year = blockYears[blockIdx];
        if (!year) return; // an ignored spare block

        const payments: Record<string, number | null> = {};
        let received = 0;
        for (const month of MONTHS) {
          const col = monthBlock.columns[month];
          if (col === undefined) {
            payments[month] = null;
            continue;
          }
          const value = row[col];
          if (value === null || value === undefined || value === "") {
            payments[month] = null;
            continue;
          }
          const n = money(value);
          payments[month] = n;
          received += n;
        }

        const mcRate = rawMc > 0 ? rawMc : (MC_RATE_BY_YEAR?.[year] ?? DEFAULT_MC_RATE);

        records.push({
          srNo,
          ownerName,
          plotNumber,
          block,
          plotBlock: `${plotNumber} ${block}`,
          allotmentStatus,
          mcRate,
          payments,
          year,
          // Only meaningful on single-year sheets; on a three-year sheet the
          // column refers to one of them, so it is not used for checking.
          statedReceived: colMap!.blocks.length === 1 ? stated : null,
          source: { sheet: sheetName, row: r + 1 },
        });

        // The sheet's own year total is a free second opinion on our reading.
        if (colMap!.blocks.length === 1 && stated !== null && stated !== received) {
          issues.push({
            sheet: sheetName,
            row: r + 1,
            kind: "total-mismatch",
            amount: Math.abs(stated - received),
            message:
              `${ownerName} (${plotNumber} ${block}): months add up to ₨${received.toLocaleString()} but the sheet's ` +
              `own total says ₨${stated.toLocaleString()}.`,
          });
        }
      });
    }
  }

  // Two rows for the same plot and year mean one of them is lost on import, since
  // a plot has a single record per year. Which to keep is a spreadsheet question,
  // so both are reported.
  const seenKeys = new Map<string, ParsedPlotData[]>();
  for (const record of records) {
    const key = `${record.plotBlock}|${record.year}`;
    const list = seenKeys.get(key) || [];
    list.push(record);
    seenKeys.set(key, list);
  }
  const dropped = new Set<ParsedPlotData>();
  for (const [key, list] of seenKeys) {
    if (list.length < 2) continue;
    const [plotBlock, year] = key.split('|');
    const total = (r: ParsedPlotData) => MONTHS.reduce((t, m) => t + (Number(r.payments[m]) || 0), 0);

    // A plot has one record per year, so only one of these can survive. Keeping
    // the row that carries money is what the sheets need: Rana Qaisar is listed
    // both in the main table and again in the prime table, and it is the prime row
    // that holds his payments while the other is a leftover placeholder. Letting
    // the last row win would have silently thrown the payments away.
    const winner = list.reduce((best, r) => (total(r) > total(best) ? r : best), list[0]);
    for (const record of list) if (record !== winner) dropped.add(record);

    issues.push({
      sheet: winner.source.sheet,
      row: winner.source.row,
      kind: "duplicate-plot-row",
      amount: list.filter((r) => r !== winner).reduce((sum, r) => sum + total(r), 0),
      message:
        `plot ${plotBlock} is listed ${list.length} times for ${year} — ` +
        list.map((r) => `row ${r.source.row} (${r.ownerName}, ₨${total(r).toLocaleString()})`).join(' and ') +
        `. Kept row ${winner.source.row}, the one carrying payments; give each row its own plot number to be sure.`,
    });
  }

  return {
    records: records.filter((r) => !dropped.has(r)),
    issues,
    skippedSheets,
  };
}
