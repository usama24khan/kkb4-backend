/**
 * Bring stored rates in line with the real schedule.
 *
 * Three things are wrong in a database seeded before the charge became
 * month-aware:
 *
 *  1. `monthlyrates` has one row per year, so 2022 reads as a flat 400 and
 *     January to April of that year are overpriced.
 *  2. Every payment record imported from the maintenance sheets carries
 *     `mcRate: 200`, including years since 2022. That figure is shown to owners
 *     and residents, and used to be what dues maths trusted — which is why
 *     receipts after May 2022 were charging 200 a month instead of 400.
 *  3. `totalDue` was stored as `mcRate × 12`, so it inherited the same error.
 *
 * The rate a month is charged at now comes from the schedule, so this script is
 * about the stored figures that get displayed and totalled.
 *
 *   npm run migrate:rates:dry     # report
 *   npm run migrate:rates         # apply
 *   npm run migrate:rates:prod    # production
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import MonthlyRate from '../models/MonthlyRate';
import Payment from '../models/Payment';
import {
  YEARS_WITH_DATA,
  RATE_CHANGES,
  getMcRateForMonth,
  getMcRateForYear,
  getChargeForYear,
  MONTHS,
} from '../config/constants';

const DRY = process.argv.includes('--dry');

async function main() {
  await connectDB();
  console.log(`env: ${process.env.NODE_ENV || 'development'} · db: ${mongoose.connection.name}`);
  console.log(DRY ? 'mode: dry run\n' : 'mode: applying\n');

  // ── 1. Rate documents ──────────────────────────────────────────────────────
  // The unique index on `year` alone has to go before a year can hold two rows.
  const indexes = await MonthlyRate.collection.indexes();
  const legacy = indexes.find((i) => i.name === 'year_1' && i.unique);
  if (legacy) {
    console.log('dropping the unique index on year alone (a year now holds one row per rate period)');
    if (!DRY) await MonthlyRate.collection.dropIndex('year_1');
  }

  // Rows written before `fromMonth` existed do not match a query for it, so an
  // upsert would sit alongside them rather than replacing them. Clear them first.
  const legacyRows = await MonthlyRate.countDocuments({ fromMonth: { $exists: false } });
  if (legacyRows) {
    console.log(`removing ${legacyRows} rate row(s) from before rates were month-aware`);
    if (!DRY) await MonthlyRate.deleteMany({ fromMonth: { $exists: false } });
  }

  const wanted: Array<{ year: number; fromMonth: number; rate: number }> = [];
  for (const year of YEARS_WITH_DATA) {
    wanted.push({ year, fromMonth: 1, rate: getMcRateForMonth(year, 1) });
    for (const change of RATE_CHANGES) {
      if (change.year === year && change.month > 1) {
        wanted.push({ year, fromMonth: change.month, rate: change.rate });
      }
    }
  }

  let rateWrites = 0;
  for (const w of wanted) {
    const existing: any = await MonthlyRate.findOne({ year: w.year, fromMonth: w.fromMonth }).lean();
    if (existing && existing.rate === w.rate) continue;
    console.log(
      `  rate ${w.year}-${String(w.fromMonth).padStart(2, '0')} → PKR ${w.rate}` +
        (existing ? ` (was ${existing.rate})` : ' (new)'),
    );
    rateWrites += 1;
    if (!DRY) {
      await MonthlyRate.findOneAndUpdate(
        { year: w.year, fromMonth: w.fromMonth },
        { rate: w.rate },
        { upsert: true },
      );
    }
  }

  // A pre-existing 2022 row keyed only by year would still read 400 for January.
  const strays = (await MonthlyRate.find().select('year fromMonth rate').lean()) as any[];
  for (const doc of strays) {
    const isWanted = wanted.some((w) => w.year === doc.year && w.fromMonth === (Number(doc.fromMonth) || 1));
    if (!isWanted) {
      console.log(`  removing stray rate row ${doc.year}-${doc.fromMonth ?? 1} (PKR ${doc.rate})`);
      if (!DRY) await MonthlyRate.deleteOne({ _id: doc._id });
    }
  }
  console.log(`rate rows written: ${rateWrites}\n`);

  // ── 2 & 3. Stored mcRate and totalDue on payment records ───────────────────
  const records = (await Payment.find().select('plot year mcRate payments totalDue totalReceived').lean()) as any[];
  const byYear = new Map<number, { records: number; fixed: number; from: Set<number>; to: number }>();

  const ops: any[] = [];
  for (const rec of records) {
    const correctRate = getMcRateForYear(rec.year);
    const correctDue = getChargeForYear(rec.year);
    let received = 0;
    for (const m of MONTHS) received += Number((rec.payments || {})[m]) || 0;

    const needsRate = Number(rec.mcRate) !== correctRate;
    const needsDue = Number(rec.totalDue) !== correctDue;
    const needsReceived = Number(rec.totalReceived) !== received;
    if (!needsRate && !needsDue && !needsReceived) continue;

    const slot = byYear.get(rec.year) || { records: 0, fixed: 0, from: new Set<number>(), to: correctRate };
    slot.records += 1;
    slot.fixed += 1;
    slot.from.add(Number(rec.mcRate));
    byYear.set(rec.year, slot);

    ops.push({
      updateOne: {
        filter: { _id: rec._id },
        update: {
          $set: {
            mcRate: correctRate,
            totalDue: correctDue,
            totalReceived: received,
            remaining: correctDue - received,
          },
        },
      },
    });
  }

  console.log(`payment records needing correction: ${ops.length} of ${records.length}`);
  for (const [year, slot] of [...byYear].sort((a, b) => a[0] - b[0])) {
    console.log(
      `  ${year}: ${slot.fixed} record(s) · mcRate ${[...slot.from].join('/')} → ${slot.to}` +
        ` · totalDue → ${getChargeForYear(year)}`,
    );
  }

  if (!DRY && ops.length) {
    for (let i = 0; i < ops.length; i += 500) {
      await Payment.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
    console.log(`\n${ops.length} payment record(s) corrected.`);
  } else if (DRY && ops.length) {
    console.log('\nRe-run without --dry to apply.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
