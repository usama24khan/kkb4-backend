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
import { parseExcelFile } from "../utils/excelParser";
import Plot from "../models/Plot";
import Payment from "../models/Payment";
import { BLOCK_PHASE_MAP, MONTHS } from "../config/constants";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const isDryRun = args.includes("--dry-run");
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
  try {
    parsedData = parseExcelFile(absPath);
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

  // ── Step 4: Upsert records ────────────────────────────────────────────────
  let plotsCreated = 0;
  let plotsUpdated = 0;
  let paymentsUpserted = 0;
  let errors = 0;
  const errorLog: string[] = [];

  for (const entry of parsedData) {
    try {
      // ── Validate required fields ──────────────────────────────────────────
      if (!entry.plotNumber || !entry.block) {
        errorLog.push(
          `Skipped (missing plotNumber or block): year=${entry.year} srNo=${entry.srNo}`,
        );
        errors++;
        continue;
      }

      // ── Upsert Plot ───────────────────────────────────────────────────────
      const phase = BLOCK_PHASE_MAP[entry.block.toUpperCase()] || "";
      const plotCode = `${entry.plotNumber}-${entry.block}`;
      const plotBlock = `${entry.plotNumber} ${entry.block}`;

      const plotData = {
        srNo: entry.srNo,
        ownerName: entry.ownerName,
        plotNumber: entry.plotNumber,
        block: entry.block.toUpperCase(),
        phase,
        plotBlock,
        plotCode,
        allotmentStatus: entry.allotmentStatus as
          | "Active"
          | "Cancelled"
          | "Unsold"
          | "Unknown",
        isActive: entry.allotmentStatus !== "Cancelled",
      };

      let plotId: mongoose.Types.ObjectId;

      const existingPlot = await Plot.findOne({
        plotNumber: entry.plotNumber,
        block: entry.block.toUpperCase(),
      }).lean();

      if (existingPlot) {
        await Plot.updateOne({ _id: existingPlot._id }, { $set: plotData });
        plotId = existingPlot._id as mongoose.Types.ObjectId;
        plotsUpdated++;
      } else {
        const newPlot = await Plot.create(plotData);
        plotId = newPlot._id as mongoose.Types.ObjectId;
        plotsCreated++;
      }

      // ── Upsert Payment ────────────────────────────────────────────────────
      const payments: Record<string, number | null> = {};
      let totalReceived = 0;

      for (const month of MONTHS) {
        const val = entry.payments[month];
        payments[month] = val ?? null;
        if (val !== null && val !== undefined && !isNaN(Number(val))) {
          totalReceived += Number(val);
        }
      }

      const totalDue = entry.mcRate * 12;
      const remaining = totalDue - totalReceived;

      await Payment.findOneAndUpdate(
        { plot: plotId, year: entry.year },
        {
          $set: {
            mcRate: entry.mcRate,
            payments,
            totalReceived,
            totalDue,
            remaining,
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
      paymentsUpserted++;
    } catch (err: any) {
      errors++;
      const msg = `Error for ${entry.plotBlock} (year=${entry.year}): ${err.message}`;
      errorLog.push(msg);
      if (errors <= 20) console.error(`  ❌ ${msg}`);
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
  console.log("=".repeat(55));

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
