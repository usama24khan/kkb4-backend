/**
 * backfillFinanceLedger.ts
 * ========================
 * Creates archival cash-book entries for dues that were already recorded on
 * `Payment` before the ledger existed.
 *
 * Why archival, not income
 * -----------------------
 * Those months were collected — and spent — years ago. Counting them as income
 * now would invent a savings pool the society never had. So every row this
 * script writes is `entryType: 'historical'` with `countInCashBook: false`: it
 * makes each plot's payment history visible in the ledger and leaves every
 * month's income exactly as it was. The cash that genuinely carried forward is
 * entered once by the admin as the opening balance (Accounts → Opening Balance).
 *
 * Idempotent: months already covered by an existing ledger entry — including the
 * live ones written by Accounts → Record Payment — are skipped, so re-running
 * never duplicates. Run it once per environment after deploying the cash book.
 *
 * Which database it touches comes from NODE_ENV, so the npm aliases are the safe
 * way to run it:
 *   npm run backfill:finance-ledger:dry        # development, preview only
 *   npm run backfill:finance-ledger            # development, apply
 *   npm run backfill:finance-ledger:prod:dry   # production, preview only
 *   npm run backfill:finance-ledger:prod       # production, apply
 *
 * It prints the environment and database it connected to before doing anything,
 * because "did I just run that against production?" is not a question anyone
 * should have to answer from memory.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { env } from '../config/env';
import Payment from '../models/Payment';
import Collection from '../models/Collection';
import { MONTHS } from '../config/constants';
import { monthEndDate, monthNumber } from '../utils/financePeriod';

async function main() {
  const dryRun = process.argv.includes('--dry');

  await connectDB();
  console.log(`\nKKB4 — Finance ledger backfill${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log(`Database:    ${mongoose.connection.name} @ ${mongoose.connection.host}`);
  console.log('');

  const payments = await Payment.find().sort({ plot: 1, year: 1 }).lean();
  console.log(`Payment records found: ${payments.length}`);

  // Months already represented in the ledger, keyed "plotId:year:month", so a
  // payment recorded through the new flow is never archived a second time.
  const covered = new Set<string>();
  const existing = await Collection.find({ isVoided: false }).select('plot allocations').lean();
  for (const entry of existing) {
    for (const alloc of entry.allocations || []) {
      covered.add(`${entry.plot}:${alloc.year}:${String(alloc.month).toLowerCase()}`);
    }
  }
  console.log(`Months already in the ledger: ${covered.size}\n`);

  let created = 0;
  let archivedAmount = 0;
  let skippedRecords = 0;

  for (const payment of payments) {
    const plotId = String(payment.plot);
    const allocations: Array<{ year: number; month: string; amount: number }> = [];

    for (const month of MONTHS) {
      const amount = Number((payment.payments as any)?.[month]) || 0;
      if (amount <= 0) continue;
      if (covered.has(`${plotId}:${payment.year}:${month}`)) continue;
      allocations.push({ year: payment.year, month, amount });
    }

    if (allocations.length === 0) {
      skippedRecords += 1;
      continue;
    }

    const total = allocations.reduce((sum, a) => sum + a.amount, 0);
    // Date the archival entry at the end of the last month it covers: it keeps
    // the row in a sensible place in the plot's history without pretending to
    // know the day the cash actually changed hands.
    const lastMonth = monthNumber(allocations[allocations.length - 1].month);
    const receivedDate = monthEndDate(payment.year, lastMonth || 12);

    if (!dryRun) {
      await Collection.create({
        plot: payment.plot,
        amount: total,
        method: 'other',
        receivedDate,
        allocations,
        entryType: 'historical',
        countInCashBook: false,
        note: 'Archived from existing dues record',
      });
    }

    created += 1;
    archivedAmount += total;
    // Guard against two Payment records for the same plot+year (shouldn't exist,
    // the compound index forbids it) archiving the same month twice.
    for (const alloc of allocations) covered.add(`${plotId}:${alloc.year}:${alloc.month}`);
  }

  console.log(`Archival entries ${dryRun ? 'to create' : 'created'}: ${created}`);
  console.log(`Records with nothing to archive:  ${skippedRecords}`);
  console.log(`Total amount archived:            PKR ${archivedAmount.toLocaleString('en-PK')}`);
  console.log(
    '\nNone of the above counts as income in any month. Set the real carried-forward\n' +
      'cash in the admin app under Accounts → Opening Balance.\n'
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
