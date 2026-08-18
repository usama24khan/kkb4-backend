/**
 * checkExcelImport.ts
 * ===================
 * Reads the maintenance workbook and reports everything that would not import
 * cleanly — without writing anything, and without needing a database.
 *
 * This exists because the importer used to say "Skipped 12 rows" and move on. The
 * skipped rows were real payments, so the totals looked plausible while ₨49,700
 * quietly failed to arrive. Every problem row is now printed with its sheet, its
 * Excel row number, the owner's name and the amount at stake, which turns a silent
 * shortfall into a short list of spreadsheet corrections.
 *
 * Run this, fix the sheet, run it again. Import only once it comes back clean.
 *
 * Usage:
 *   npm run check:excel                       # the default uploads/ workbook
 *   npm run check:excel -- path/to/file.xlsx
 */
import path from 'path';
import { parseWorkbook, buildBlockMap } from '../utils/excelParser';
import { MONTHS } from '../config/constants';

const DEFAULT_FILE = 'uploads/KKB4_Maintenance_Updated.xlsx';

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--block-map');
  const file = path.resolve(positional[0] || DEFAULT_FILE);
  const mapFlag = args.indexOf('--block-map');
  const mapFile = mapFlag >= 0 ? args[mapFlag + 1] : undefined;

  const log = console.log;
  console.log = () => {};              // the parser narrates; we want the report
  const blockMap = mapFile ? buildBlockMap(path.resolve(mapFile)) : undefined;
  const { records, issues, skippedSheets } = parseWorkbook(file, { blockMap });
  console.log = log;

  console.log(`\nKKB4 — workbook check`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`File: ${file}`);
  if (blockMap) console.log(`Plot register: ${mapFile} (${blockMap.size} plot numbers)`);
  console.log('');

  // What did import cleanly, per year.
  const byYear = new Map<number, { rows: number; money: number }>();
  for (const r of records) {
    const money = MONTHS.reduce((t, m) => t + (Number(r.payments[m]) || 0), 0);
    const cur = byYear.get(r.year) || { rows: 0, money: 0 };
    cur.rows += 1;
    cur.money += money;
    byYear.set(r.year, cur);
  }

  console.log('year    plots   payments recorded');
  let totalMoney = 0;
  for (const year of [...byYear.keys()].sort()) {
    const v = byYear.get(year)!;
    totalMoney += v.money;
    console.log(`${year}  ${String(v.rows).padStart(7)}   ₨${v.money.toLocaleString().padStart(12)}`);
  }
  console.log(`${''.padEnd(6)}  ${String(records.length).padStart(7)}   ₨${totalMoney.toLocaleString().padStart(12)}  total\n`);

  if (skippedSheets.length) {
    console.log(`Sheets with no plot table (ignored): ${skippedSheets.join(', ')}\n`);
  }

  const rowIssues = issues.filter((i) => i.kind === 'unimportable-row');
  const mismatches = issues.filter((i) => i.kind === 'total-mismatch');
  const conflicts = issues.filter((i) => i.kind === 'year-conflict');
  const excluded = issues.filter((i) => i.kind === 'excluded-non-plot');
  const duplicates = issues.filter((i) => i.kind === 'duplicate-plot-row');
  const blockIssues = issues.filter((i) => i.kind === 'block-mismatch');
  const dupIssues = issues.filter((i) => i.kind === 'duplicate-month-columns');
  const fatal = issues.filter((i) => i.kind === 'no-columns');

  if (fatal.length) {
    console.log('SHEETS SKIPPED ENTIRELY');
    fatal.forEach((i) => console.log(`  ${i.sheet}: ${i.message}`));
    console.log('');
  }

  if (rowIssues.length) {
    const lost = rowIssues.reduce((s, i) => s + (i.amount || 0), 0);
    console.log(`ROWS NOT IMPORTED — ₨${lost.toLocaleString()} across ${rowIssues.length} row(s)`);
    console.log('Fix these in the sheet (usually: fill in the plot number), then re-run.\n');
    for (const i of rowIssues) {
      console.log(`  ${i.sheet} row ${i.row}`);
      console.log(`    ${i.message}`);
    }
    console.log('');
  }

  if (conflicts.length) {
    console.log('YEAR CONFLICTS');
    conflicts.forEach((i) => console.log(`  ${i.sheet}: ${i.message}`));
    console.log('');
  }

  if (mismatches.length) {
    const off = mismatches.reduce((s, i) => s + (i.amount || 0), 0);
    console.log(`ROWS THAT DISAGREE WITH THE SHEET'S OWN TOTAL — ${mismatches.length} row(s), ₨${off.toLocaleString()} apart`);
    console.log("The month cells and the sheet's own total column do not match. Usually a stale total.\n");
    mismatches.slice(0, 15).forEach((i) => console.log(`  ${i.sheet} row ${i.row}: ${i.message}`));
    if (mismatches.length > 15) console.log(`  …and ${mismatches.length - 15} more`);
    console.log('');
  }

  if (dupIssues.length) {
    console.log('AMBIGUOUS COLUMNS');
    console.log('The same month appears in more than one column, so only one could be used.\n');
    for (const i of dupIssues) {
      console.log(`  ${i.sheet}: ${i.message}`);
    }
    console.log('');
  }

  if (blockIssues.length) {
    console.log(`BLOCKS TAKEN FROM THE REGISTER — ${blockIssues.length}`);
    console.log('Where the maintenance sheet and the plot register disagree, or a plot is not in the register.\n');
    blockIssues.slice(0, 12).forEach((i) => console.log(`  ${i.sheet} row ${i.row}: ${i.message}`));
    if (blockIssues.length > 12) console.log(`  …and ${blockIssues.length - 12} more`);
    console.log('');
  }

  if (duplicates.length) {
    console.log(`THE SAME PLOT LISTED TWICE IN A YEAR — ${duplicates.length}`);
    console.log('Resolved by keeping the row that carries payments. Tidy the sheet when convenient.\n');
    duplicates.forEach((i) => console.log(`  ${i.sheet} row ${i.row}: ${i.message}`));
    console.log('');
  }

  if (excluded.length) {
    const total = excluded.reduce((sum, i) => sum + (i.amount || 0), 0);
    console.log(`EXCLUDED ON PURPOSE — ${excluded.length} row(s), ₨${total.toLocaleString()}`);
    console.log('Confirmed as not being KKB4 plots. Listed so nothing is invisible.\n');
    excluded.forEach((i) => console.log(`  ${i.sheet} row ${i.row}: ${i.message}`));
    console.log('');
  }

  // Only rows carrying money that nobody has accounted for actually block an
  // import. Everything else is a note: resolved automatically, or agreed.
  const blocking = rowIssues.length + fatal.length;
  if (blocking === 0) {
    console.log('Nothing is blocking an import — every row with money is either imported or agreed as excluded.');
    const notes = issues.length - blocking;
    if (notes > 0) console.log(`${notes} note(s) above are for information only.`);
    console.log('');
  } else {
    console.log(`${blocking} row(s) need attention before importing.\n`);
  }
}

main();
