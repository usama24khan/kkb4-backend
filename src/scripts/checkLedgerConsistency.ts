/**
 * Reconcile recorded payments against owners' dues.
 *
 * Every live cash-book entry names the months it cleared. Those months should
 * still show at least that much in the owner's record. If one shows less, the
 * dues were taken off after the money was banked — the income stands, the
 * receipt stands, and the owner's record no longer agrees with either. That is
 * the state the guards now prevent; this script finds any left from before, and
 * with --fix restores the months to what the ledger says was paid.
 *
 *   npm run check:ledger              # report only
 *   npm run check:ledger -- --fix     # restore the months
 *   npm run check:ledger:prod         # against production
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Collection from '../models/Collection';
import Payment from '../models/Payment';
import Plot from '../models/Plot';
import Receipt from '../models/Receipt';

const FIX = process.argv.includes('--fix');

type Gap = {
  plotId: string;
  plotLabel: string;
  year: number;
  month: string;
  allocated: number;
  recorded: number;
  receipts: string[];
};

async function main() {
  await connectDB();
  console.log(`env: ${process.env.NODE_ENV || 'development'} · db: ${mongoose.connection.name}`);
  console.log(FIX ? 'mode: FIX — months will be restored\n' : 'mode: report only (pass --fix to repair)\n');

  const live = await Collection.find({ isVoided: false, countInCashBook: true })
    .select('plot amount allocations receiptRef')
    .lean();

  // What the cash book says was paid, per plot-year-month.
  const allocated = new Map<string, { amount: number; receipts: Set<string> }>();
  const receiptNumbers = new Map<string, string>();
  const receipts = await Receipt.find({ isVoided: { $ne: true } }).select('receiptNumber').lean();
  for (const r of receipts as any[]) receiptNumbers.set(String(r._id), r.receiptNumber);

  for (const entry of live as any[]) {
    for (const alloc of entry.allocations || []) {
      const key = `${entry.plot}|${alloc.year}|${String(alloc.month).toLowerCase()}`;
      const slot = allocated.get(key) || { amount: 0, receipts: new Set<string>() };
      slot.amount += Number(alloc.amount) || 0;
      const num = entry.receiptRef ? receiptNumbers.get(String(entry.receiptRef)) : undefined;
      if (num) slot.receipts.add(num);
      allocated.set(key, slot);
    }
  }

  const plotLabels = new Map<string, string>();
  for (const p of (await Plot.find().select('plotBlock ownerName').lean()) as any[]) {
    plotLabels.set(String(p._id), `${p.plotBlock}${p.ownerName ? ` (${p.ownerName})` : ''}`);
  }

  const gaps: Gap[] = [];
  for (const [key, slot] of allocated) {
    const [plotId, yearStr, month] = key.split('|');
    const year = Number(yearStr);
    const payment = await Payment.findOne({ plot: plotId, year }).select('payments').lean();
    const recorded = Number((payment as any)?.payments?.[month]) || 0;
    if (recorded >= slot.amount) continue;
    gaps.push({
      plotId,
      plotLabel: plotLabels.get(plotId) || plotId,
      year,
      month,
      allocated: slot.amount,
      recorded,
      receipts: [...slot.receipts],
    });
  }

  if (gaps.length === 0) {
    console.log(`${allocated.size} paid months checked across ${live.length} recorded payments.`);
    console.log('Every recorded payment still shows in the owner\'s record. Nothing to repair.');
  } else {
    console.log(`${gaps.length} month(s) where the owner's record shows less than was banked:\n`);
    for (const g of gaps.sort((a, b) => a.plotLabel.localeCompare(b.plotLabel))) {
      console.log(
        `  ${g.plotLabel} · ${g.month} ${g.year} · banked PKR ${g.allocated}, record shows ${g.recorded}` +
          (g.receipts.length ? ` · receipt ${g.receipts.join(', ')}` : ' · no receipt'),
      );
    }
    if (FIX) {
      console.log('');
      for (const g of gaps) {
        await Payment.findOneAndUpdate(
          { plot: g.plotId, year: g.year },
          { $set: { [`payments.${g.month}`]: g.allocated } },
          { upsert: true },
        );
        console.log(`  restored ${g.plotLabel} ${g.month} ${g.year} → PKR ${g.allocated}`);
      }
      console.log(`\n${gaps.length} month(s) restored. Income and receipts were untouched — they were already correct.`);
    } else {
      console.log('\nRe-run with --fix to restore these months to the banked amount.');
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
