/**
 * src/scripts/seedFromExcel.ts
 *
 * Seeds the MongoDB database from a KKB4 Excel maintenance file.
 *
 * Usage:
 *   npx ts-node src/scripts/seedFromExcel.ts <path-to-excel>
 *   npx ts-node src/scripts/seedFromExcel.ts ./uploads/KKB4_Maintenance_Updated.xlsx
 *
 * Options:
 *   --dry-run   Parse and log without writing to DB
 *   --clear     Drop existing Plot + Payment data before seeding
 */

import mongoose from "mongoose";
import path from "path";
import { connectDB } from "../config/db";
import { parseWorkbook, buildBlockMap } from "../utils/excelParser";
import Plot from "../models/Plot";
import Payment from "../models/Payment";
import Collection from "../models/Collection";
import { BLOCK_PHASE_MAP, MONTHS } from "../config/constants";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--block-map");
const filePath = positional[0];
const isDryRun = args.includes("--dry-run");
/**
 * A workbook that states the block on every row, used as the authority for which
 * block a plot belongs to. Without it the block is read down the column, which
 * misfiles any section that opens on a bare plot number.
 */
const blockMapFlag = args.findIndex((a) => a === "--block-map");
const blockMapFile = blockMapFlag >= 0 ? args[blockMapFlag + 1] : undefined;
const shouldClear = args.includes("--clear");

if (!filePath) {
  console.error("❌ No file path provided.");
  console.log(
    "Usage: npx ts-node src/scripts/seedFromExcel.ts <path-to-excel> [--dry-run] [--clear]",
  );
  console.log(
    "Example: npx ts-node src/scripts/seedFromExcel.ts ./uploads/KKB4_Maintenance_Updated.xlsx",
  );
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function seed() {
  const absPath = path.resolve(filePath!);
  console.log(`\n🌱 KKB4 Seeder — Starting import`);
  console.log(`   File:    ${absPath}`);
  console.log(`   Dry run: ${isDryRun}`);
  console.log(`   Clear:   ${shouldClear}\n`);

  // ── Step 1: Parse Excel ───────────────────────────────────────────────────
  let parsedData;
  let parseIssues: { sheet: string; row: number | null; message: string; amount?: number; kind: string }[] = [];
  try {
    let blockMap;
    if (blockMapFile) {
      blockMap = buildBlockMap(path.resolve(blockMapFile));
      console.log(`   Plot register: ${blockMapFile} — ${blockMap.size} plot numbers with a stated block`);
    }
    const result = parseWorkbook(absPath, { blockMap });
    parsedData = result.records;
    parseIssues = result.issues;
  } catch (err: any) {
    console.error(`❌ Failed to parse Excel file: ${err.message}`);
    process.exit(1);
  }

  if (parsedData.length === 0) {
    console.error(
      "❌ No records parsed from the Excel file. Check column headers and sheet names.",
    );
    process.exit(1);
  }

  console.log(`\n📊 Total parsed records: ${parsedData.length}`);

  // Anything the workbook could not give us, stated before we write a thing.
  const rowIssues = parseIssues.filter((i) => i.kind === "unimportable-row");
  if (parseIssues.length > 0) {
    const lost = rowIssues.reduce((sum, i) => sum + (i.amount || 0), 0);
    console.log(`\n⚠️  ${parseIssues.length} workbook issue(s)` + (lost > 0 ? `, ₨${lost.toLocaleString()} not imported:` : ":"));
    for (const issue of parseIssues.slice(0, 25)) {
      console.log(`   ${issue.sheet}${issue.row ? ` row ${issue.row}` : ""}: ${issue.message}`);
    }
    if (parseIssues.length > 25) console.log(`   …and ${parseIssues.length - 25} more`);
    console.log(`   Run "npm run check:excel" for the full list.`);
  }

  // ── Dry run — stop here ───────────────────────────────────────────────────
  if (isDryRun) {
    console.log("\n🔍 DRY RUN — first 10 records:");
    parsedData.slice(0, 10).forEach((r, i) => {
      console.log(
        `  [${i + 1}] Plot: ${r.plotBlock} | Block: ${r.block} | Year: ${r.year} | Owner: ${r.ownerName} | Status: ${r.allotmentStatus}`,
      );
    });

    // Show block distribution
    const blockCounts: Record<string, number> = {};
    for (const r of parsedData) {
      blockCounts[r.block] = (blockCounts[r.block] || 0) + 1;
    }
    console.log("\n📦 Block distribution:");
    Object.entries(blockCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([block, count]) => {
        console.log(`   Block ${block}: ${count} records`);
      });

    console.log("\n✅ Dry run complete. No DB writes performed.\n");
    process.exit(0);
  }

  // ── Step 2: Connect to DB ─────────────────────────────────────────────────
  await connectDB();
  console.log("🔌 Connected to MongoDB\n");

  // ── Step 3: Optionally clear existing data ────────────────────────────────
  if (shouldClear) {
    console.log("🗑️  Clearing existing Plot and Payment collections...");
    await Plot.deleteMany({});
    await Payment.deleteMany({});
    console.log("   ✅ Collections cleared\n");
  }

  // ── Step 3b: Months already backed by a recorded payment ──────────────────
  //
  // The importer replaces a year's month values wholesale. That is fine for the
  // one-time historical load, but this script will be run again — and by then some
  // months will have been paid at the counter, each with a receipt and a cash-book
  // entry behind it. Overwriting those from the spreadsheet would leave the ledger
  // holding money that the owner's record no longer shows, with a receipt in
  // somebody's hand. So they are protected: the spreadsheet cannot touch them.
  const protectedMonths = new Set<string>();
  {
    const live = await Collection.find({ isVoided: false, countInCashBook: true })
      .select("plot allocations")
      .lean();
    for (const entry of live as any[]) {
      for (const alloc of entry.allocations || []) {
        protectedMonths.add(`${entry.plot}:${alloc.year}:${String(alloc.month).toLowerCase()}`);
      }
    }
    if (protectedMonths.size > 0) {
      console.log(
        `\n🔒 ${protectedMonths.size} month(s) are backed by recorded payments and will not be overwritten.`,
      );
    }
  }

  // ── Step 4: Write in batches ──────────────────────────────────────────────
  //
  // Row-by-row writes meant four round trips per record: ~16,000 of them for this
  // workbook, which took over half an hour against Atlas and left the database
  // half-loaded if it was interrupted. Everything below is grouped into a handful
  // of bulk operations instead, so the import is quick and each collection lands
  // in one go.
  let plotsCreated = 0;
  let plotsUpdated = 0;
  let paymentsUpserted = 0;
  let monthsProtected = 0;
  let errors = 0;
  const protectedLog: string[] = [];
  const errorLog: string[] = [];

  const plotKey = (plotNumber: string, block: string) => `${plotNumber}-${block.toUpperCase()}`;

  // ── 4a. One record per plot, taking its details from the latest year present ──
  const plotByKey = new Map<string, (typeof parsedData)[number]>();
  for (const entry of parsedData) {
    if (!entry.plotNumber || !entry.block) {
      errorLog.push(`Skipped (missing plotNumber or block): year=${entry.year} srNo=${entry.srNo}`);
      errors++;
      continue;
    }
    const key = plotKey(entry.plotNumber, entry.block);
    const seen = plotByKey.get(key);
    if (!seen || entry.year > seen.year) plotByKey.set(key, entry);
  }

  // `any` because allotmentStatus arrives from the sheet as a plain string, and
  // the model's union type cannot be proven at this boundary.
  const plotOps: any[] = [...plotByKey.values()].map((entry) => {
    const block = entry.block.toUpperCase();
    return {
      updateOne: {
        filter: { plotNumber: entry.plotNumber, block },
        update: {
          $set: {
            srNo: entry.srNo,
            ownerName: entry.ownerName,
            plotNumber: entry.plotNumber,
            block,
            phase: BLOCK_PHASE_MAP[block] || "",
            plotBlock: `${entry.plotNumber} ${block}`,
            plotCode: `${entry.plotNumber}-${block}`,
            allotmentStatus: entry.allotmentStatus,
            isActive: entry.allotmentStatus !== "Cancelled",
          },
        },
        upsert: true,
      },
    };
  });

  if (plotOps.length) {
    const res = await Plot.bulkWrite(plotOps, { ordered: false });
    plotsCreated = res.upsertedCount || 0;
    plotsUpdated = res.modifiedCount || 0;
    console.log(`   ✅ Plots: ${plotsCreated} created, ${plotsUpdated} updated`);
  }

  // ── 4b. Resolve every plot id in one read ──────────────────────────────────
  const plots = await Plot.find({}).select("plotNumber block").lean();
  const idByKey = new Map<string, mongoose.Types.ObjectId>();
  for (const p of plots as any[]) {
    idByKey.set(plotKey(p.plotNumber, p.block), p._id);
  }

  // ── 4c. Existing payment records, to merge protected months into ───────────
  const existingByKey = new Map<string, any>();
  {
    const years = [...new Set(parsedData.map((e) => e.year))];
    const existing = await Payment.find({ year: { $in: years } }).select("plot year payments").lean();
    for (const doc of existing as any[]) {
      existingByKey.set(`${doc.plot}:${doc.year}`, doc.payments || {});
    }
  }

  // ── 4d. Build the payment writes ──────────────────────────────────────────
  const paymentOps: any[] = [];
  for (const entry of parsedData) {
    if (!entry.plotNumber || !entry.block) continue;
    const plotId = idByKey.get(plotKey(entry.plotNumber, entry.block));
    if (!plotId) {
      errorLog.push(`No plot id for ${entry.plotBlock} (year=${entry.year})`);
      errors++;
      continue;
    }

    const current = existingByKey.get(`${plotId}:${entry.year}`) || {};
    const payments: Record<string, number | null> = {};
    let totalReceived = 0;

    for (const month of MONTHS) {
      const sheetVal = entry.payments[month] ?? null;

      if (protectedMonths.has(`${plotId}:${entry.year}:${month}`)) {
        // Keep what the counter recorded: a receipt and a cash-book entry agree
        // with it, and the spreadsheet does not know about it.
        const kept = current[month] ?? null;
        payments[month] = kept;
        if (Number(kept || 0) !== Number(sheetVal || 0)) {
          monthsProtected++;
          if (protectedLog.length < 20) {
            protectedLog.push(
              `${entry.plotBlock} ${month} ${entry.year}: kept ₨${Number(kept || 0).toLocaleString()} (recorded payment) over ₨${Number(sheetVal || 0).toLocaleString()} from the sheet`,
            );
          }
        }
      } else {
        payments[month] = sheetVal;
      }

      const val = payments[month];
      if (val !== null && val !== undefined && !isNaN(Number(val))) totalReceived += Number(val);
    }

    const totalDue = entry.mcRate * 12;
    paymentOps.push({
      updateOne: {
        filter: { plot: plotId, year: entry.year },
        update: {
          $set: {
            mcRate: entry.mcRate,
            payments,
            totalReceived,
            totalDue,
            remaining: totalDue - totalReceived,
          },
        },
        upsert: true,
      },
    });
  }

  // Chunked so a single oversized command cannot be rejected.
  const CHUNK = 500;
  for (let i = 0; i < paymentOps.length; i += CHUNK) {
    const chunk = paymentOps.slice(i, i + CHUNK);
    try {
      await Payment.bulkWrite(chunk, { ordered: false });
      paymentsUpserted += chunk.length;
      console.log(`   ✅ Payments ${Math.min(i + CHUNK, paymentOps.length)}/${paymentOps.length}`);
    } catch (err: any) {
      errors++;
      errorLog.push(`Payment batch at ${i}: ${err.message}`);
    }
  }

  // ── Step 5: Summary ───────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(55));
  console.log("📋 IMPORT SUMMARY");
  console.log("=".repeat(55));
  console.log(`  Total records parsed:  ${parsedData.length}`);
  console.log(`  Plots created:         ${plotsCreated}`);
  console.log(`  Plots updated:         ${plotsUpdated}`);
  console.log(`  Payments upserted:     ${paymentsUpserted}`);
  console.log(`  Errors:                ${errors}`);
  console.log(`  Months protected:      ${monthsProtected}`);
  console.log("=".repeat(55));

  if (protectedLog.length > 0) {
    console.log("\n🔒 Kept over the spreadsheet (a recorded payment covers them):");
    protectedLog.forEach((e) => console.log(`   - ${e}`));
  }

  if (errorLog.length > 0) {
    console.log("\n⚠️  Error details (first 20):");
    errorLog.slice(0, 20).forEach((e) => console.log(`   - ${e}`));
  }

  await mongoose.disconnect();
  console.log("\n✅ Done. Database disconnected.\n");
  process.exit(0);
}

seed().catch((err) => {
  console.error("💥 Fatal seed error:", err);
  process.exit(1);
});
