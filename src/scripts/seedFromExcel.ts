import mongoose from 'mongoose';
import path from 'path';
import { connectDB } from '../config/db';
import { env } from '../config/env';
import { parseExcelFile } from '../utils/excelParser';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import { BLOCK_PHASE_MAP, MONTHS } from '../config/constants';

async function seed() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('Usage: npx ts-node src/scripts/seedFromExcel.ts <path-to-excel-file>');
    console.log('Example: npx ts-node src/scripts/seedFromExcel.ts ./data/kkb4.xlsx');
    process.exit(1);
  }

  const absPath = path.resolve(filePath);
  console.log(`\n🌱 KKB4 Seeder — Starting import from: ${absPath}\n`);

  await connectDB();

  const parsedData = parseExcelFile(absPath);
  console.log(`\n📊 Total parsed records: ${parsedData.length}\n`);

  let plotsCreated = 0, plotsUpdated = 0, paymentsUpserted = 0, errors = 0;

  for (const entry of parsedData) {
    try {
      // Upsert Plot
      const plotData = {
        srNo: entry.srNo,
        ownerName: entry.ownerName,
        plotNumber: entry.plotNumber,
        block: entry.block,
        phase: BLOCK_PHASE_MAP[entry.block] || 0,
        plotBlock: entry.plotBlock,
        allotmentStatus: entry.allotmentStatus,
      };

      const existingPlot = await Plot.findOne({ plotNumber: entry.plotNumber, block: entry.block });

      let plotId: string;
      if (existingPlot) {
        await Plot.updateOne({ _id: existingPlot._id }, { $set: plotData });
        plotId = existingPlot._id.toString();
        plotsUpdated++;
      } else {
        const newPlot = new Plot(plotData);
        await newPlot.save();
        plotId = newPlot._id.toString();
        plotsCreated++;
      }

      // Upsert Payment
      const payments: any = {};
      let totalReceived = 0;
      for (const month of MONTHS) {
        const val = entry.payments[month];
        payments[month] = val;
        if (val !== null && val !== undefined && !isNaN(val)) totalReceived += val;
      }

      const totalDue = entry.mcRate * 12;

      await Payment.findOneAndUpdate(
        { plot: plotId, year: entry.year },
        {
          $set: {
            mcRate: entry.mcRate,
            payments,
            totalReceived,
            totalDue,
            remaining: totalDue - totalReceived,
          },
        },
        { upsert: true, new: true }
      );

      paymentsUpserted++;
    } catch (err: any) {
      errors++;
      if (errors <= 10) console.error(`  ❌ Error for ${entry.plotBlock} (${entry.year}): ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('📋 IMPORT SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Plots created:    ${plotsCreated}`);
  console.log(`  Plots updated:    ${plotsUpdated}`);
  console.log(`  Payments upserted: ${paymentsUpserted}`);
  console.log(`  Errors:           ${errors}`);
  console.log('='.repeat(50) + '\n');

  await mongoose.disconnect();
  console.log('✅ Done. Database disconnected.\n');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Fatal seed error:', err);
  process.exit(1);
});
