/**
 * seedDemoFinance.ts
 * ==================
 * Fills the cash book with believable demo data so the Accounts pages can be
 * tested with real content, and removes it again on demand. Development only —
 * it refuses to run against NODE_ENV=production.
 *
 * It writes through the same `recordCollection` service the admin UI uses, so
 * what you see is what the real flow produces.
 *
 * Three months of 2026 with a deliberate narrative:
 *   June    — normal month, comfortable surplus
 *   July    — normal month, pool keeps growing
 *   August  — main-gate rebuild funded from the accumulated pool, so the month
 *             runs a deficit and total savings visibly draw down
 *
 * Income mixes the three cases that matter: most owners paying the current
 * month, several clearing years of arrears, a few paying months ahead.
 *
 * Every row carries note `demo-seed` (never shown in the UI), which is also how
 * --clean finds them; cleaning reverses the dues months each demo payment
 * cleared, so the database is left as it was.
 *
 * Usage:
 *   npm run seed:demo-finance          # write demo data
 *   npm run seed:demo-finance:clean    # remove it again
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { env } from '../config/env';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import Collection from '../models/Collection';
import Expense from '../models/Expense';
import ExpenseCategory from '../models/ExpenseCategory';
import FinanceSettings from '../models/FinanceSettings';
import { MONTHS } from '../config/constants';
import { recordCollection, ensureCategories } from '../services/finance.service';

const DEMO_NOTE = 'demo-seed';
const YEAR = 2026;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (month: number, day: number) => `${YEAR}-${pad(month)}-${pad(day)}`;

interface PlannedPayment {
  plotIndex: number;
  month: number;
  day: number;
  allocations: Array<{ year: number; month: string; amount: number }>;
}

/** The month-by-month collection plan, built from the plot list. */
function buildPlan(plotCount: number): PlannedPayment[] {
  const plan: PlannedPayment[] = [];

  // Current-month dues — a different slice of owners each month, the way a real
  // ledger looks rather than the same names repeating.
  const countByMonth: Record<number, number> = { 6: 170, 7: 165, 8: 160 };
  const offsetByMonth: Record<number, number> = { 6: 0, 7: 25, 8: 50 };
  for (const month of [6, 7, 8]) {
    for (let i = 0; i < countByMonth[month]; i++) {
      plan.push({
        plotIndex: (i + offsetByMonth[month]) % plotCount,
        month,
        day: 1 + (i % 26),
        allocations: [{ year: YEAR, month: MONTHS[month - 1], amount: 400 }],
      });
    }
  }

  // Arrears settled now: the whole amount counts in the month it was received.
  const arrears: Array<[number, number, number, number, string[]]> = [
    [6, 12, 210, 2025, ['jul', 'aug', 'sep', 'oct', 'nov', 'dec']],
    [6, 19, 211, 2025, ['jan', 'feb', 'mar', 'apr', 'may', 'jun']],
    [7, 8, 212, 2024, [...MONTHS]],
    [7, 21, 213, 2025, ['aug', 'sep', 'oct', 'nov', 'dec']],
    [8, 6, 214, 2025, ['jan', 'feb', 'mar', 'apr', 'may']],
    [8, 14, 215, 2024, ['jul', 'aug', 'sep', 'oct', 'nov', 'dec']],
  ];
  for (const [month, day, plotIndex, year, months] of arrears) {
    plan.push({
      plotIndex: plotIndex % plotCount,
      month,
      day,
      allocations: months.map((m) => ({ year, month: m, amount: 400 })),
    });
  }

  // Paid ahead: likewise counted in the month the money arrived.
  const advance: Array<[number, number, number, Array<[number, string[]]>]> = [
    [6, 18, 220, [[YEAR, ['jul', 'aug', 'sep', 'oct']]]],
    [7, 28, 221, [[YEAR, ['aug', 'sep', 'oct']]]],
    [8, 10, 222, [[YEAR, ['sep', 'oct', 'nov', 'dec']], [YEAR + 1, ['jan', 'feb', 'mar', 'apr']]]],
  ];
  for (const [month, day, plotIndex, groups] of advance) {
    const allocations: Array<{ year: number; month: string; amount: number }> = [];
    for (const [year, months] of groups) {
      for (const m of months) allocations.push({ year, month: m, amount: 400 });
    }
    plan.push({ plotIndex: plotIndex % plotCount, month, day, allocations });
  }

  return plan;
}

const EXPENSES: Array<[number, number, string, string, number, string]> = [
  [6, 1, 'Sweeper salary — June', 'Sweeper Salary', 25000, 'Rafiq Masih'],
  [6, 3, 'Guard salary — June', 'Security Guard', 12000, 'Sabir Khan'],
  [6, 8, 'Generator & water pump petrol', 'Petrol / Fuel', 6000, 'Shell Pump'],
  [6, 20, 'Sewerage line cleaning — Block A', 'Sewerage', 5000, 'Nadeem Contractor'],
  [7, 1, 'Sweeper salary — July', 'Sweeper Salary', 25000, 'Rafiq Masih'],
  [7, 3, 'Guard salary — July', 'Security Guard', 12000, 'Sabir Khan'],
  [7, 6, 'Generator & water pump petrol', 'Petrol / Fuel', 5500, 'Shell Pump'],
  [7, 14, 'Street light bulbs & wiring', 'Repairs & Maintenance', 4500, 'Al-Noor Electric'],
  [8, 1, 'Sweeper salary — August', 'Sweeper Salary', 25000, 'Rafiq Masih'],
  [8, 3, 'Guard salary — August', 'Security Guard', 12000, 'Sabir Khan'],
  [8, 5, 'Generator & water pump petrol', 'Petrol / Fuel', 6000, 'Shell Pump'],
  // The big job: far more than the month took in, funded from accumulated
  // savings, so the pool visibly draws down instead of only ever growing.
  [8, 9, 'Main gate rebuild, boundary wall & paint', 'Development Work', 75000, 'Bashir Welding Works'],
];

async function clean() {
  const demo = await Collection.find({ note: DEMO_NOTE }).lean();
  console.log(`Demo payments found: ${demo.length}`);

  // Group the allocations to subtract per (plot, year) so each Payment record is
  // rewritten once rather than once per month.
  const byPlotYear = new Map<string, Record<string, number>>();
  for (const entry of demo) {
    for (const alloc of entry.allocations || []) {
      const key = `${entry.plot}:${alloc.year}`;
      const months = byPlotYear.get(key) || {};
      months[alloc.month] = (months[alloc.month] || 0) + alloc.amount;
      byPlotYear.set(key, months);
    }
  }

  let reverted = 0;
  for (const [key, months] of byPlotYear) {
    const [plotId, year] = key.split(':');
    const payment = await Payment.findOne({ plot: plotId, year: Number(year) });
    if (!payment) continue;
    for (const [month, amount] of Object.entries(months)) {
      const next = (Number((payment.payments as any)[month]) || 0) - amount;
      (payment.payments as any)[month] = next > 0 ? next : null;
    }
    await payment.save(); // pre-save hook recomputes the totals
    reverted += 1;
  }

  const removedCollections = await Collection.deleteMany({ note: DEMO_NOTE });
  const removedExpenses = await Expense.deleteMany({ note: DEMO_NOTE });
  await FinanceSettings.updateOne({ key: 'default' }, { $set: { openingBalance: 0, note: '' } });

  console.log(`Payment records reverted: ${reverted}`);
  console.log(`Payments deleted:         ${removedCollections.deletedCount}`);
  console.log(`Expenses deleted:         ${removedExpenses.deletedCount}`);
  console.log('Opening balance reset to 0.\n');
}

async function seed() {
  await FinanceSettings.updateOne(
    { key: 'default' },
    {
      $set: {
        openingBalance: 50000,
        openingAsOf: new Date('2026-01-01T12:00:00Z'),
        note: 'Carried forward at committee handover',
      },
      $setOnInsert: { key: 'default' },
    },
    { upsert: true },
  );
  console.log('Opening balance set to 50,000.');

  await ensureCategories();
  const categories = await ExpenseCategory.find().lean();
  const categoryId = (name: string) => categories.find((c) => c.name === name)?._id || null;

  const plots = await Plot.find({ isActive: true }).sort({ block: 1, plotNumber: 1 }).lean();
  if (plots.length === 0) throw new Error('No plots in the database — seed plots first.');
  console.log(`Plots available: ${plots.length}`);

  const plan = buildPlan(plots.length);
  let income = 0;
  for (const item of plan) {
    const plot = plots[item.plotIndex];
    const amount = item.allocations.reduce((sum, a) => sum + a.amount, 0);
    await recordCollection({
      plotId: String(plot._id),
      amount,
      method: item.day % 4 === 0 ? 'bank' : 'cash',
      receivedDate: iso(item.month, item.day),
      allocations: item.allocations,
      // Receipts are skipped: 380 Cloudinary uploads would take many minutes and
      // add nothing to what the pages display.
      generateReceipt: false,
      note: DEMO_NOTE,
    });
    income += amount;
  }
  console.log(`Payments recorded: ${plan.length} · PKR ${income.toLocaleString('en-PK')}`);

  let spent = 0;
  for (const [month, day, title, category, amount, paidTo] of EXPENSES) {
    await Expense.create({
      title,
      category: categoryId(category),
      categoryName: category,
      amount,
      expenseDate: new Date(`${iso(month, day)}T12:00:00Z`),
      paidTo,
      method: 'cash',
      note: DEMO_NOTE,
    });
    spent += amount;
  }
  console.log(`Expenses recorded: ${EXPENSES.length} · PKR ${spent.toLocaleString('en-PK')}\n`);
}

async function report() {
  const { getYearReport, getYearlyReport } = await import('../services/finance.service');
  const year = await getYearReport(YEAR);
  const yearly = await getYearlyReport();

  console.log('        income   expense     saved      pool');
  for (const m of year.months.filter((x) => x.income || x.expense)) {
    console.log(
      MONTHS[m.month - 1].padEnd(5) +
        String(m.income).padStart(8) +
        String(m.expense).padStart(10) +
        String(m.saving).padStart(10) +
        String(m.runningSaving).padStart(10),
    );
  }
  console.log(`\nTotal savings pool: PKR ${yearly.totalSaving.toLocaleString('en-PK')}\n`);
}

async function main() {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to run against production.');
    process.exit(1);
  }

  const shouldClean = process.argv.includes('--clean');
  await connectDB();
  console.log(`\nKKB4 — Demo finance data${shouldClean ? ' (CLEAN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (shouldClean) {
    await clean();
  } else {
    // Start from a clean slate so re-running doesn't stack duplicates.
    await clean();
    await seed();
    await report();
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Demo seed failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
