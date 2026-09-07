/**
 * AI chat — query-layer checks.  `npm run check:ai-chat`
 *
 * Exercises every operation through `runPlan`, the seam below the planner, and
 * compares each result against an aggregate computed here. No LLM is involved:
 * Groq's free tier allows 8,000 tokens a minute, so a suite that went through
 * `answerQuestion` would spend its time rate-limited rather than testing
 * anything. What this covers is the half that decides whether an answer is
 * TRUE — the allowlists, the joins, the normalisers, the arithmetic.
 *
 * It SEEDS three payments and removes them again, so it must never point at
 * production; the guard below refuses to run there.
 *
 * Each check states its own expectation from the data, so it keeps working as
 * the dev database changes.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import PaymentEvent from '../models/PaymentEvent';
import { runPlan } from '../services/aiQuery.service';
import { PaymentService } from '../services/payment.service';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  await connectDB();

  // This script writes. Production is read-only territory for it.
  const dbName = mongoose.connection.name;
  if (process.env.NODE_ENV === 'production' || /prod/i.test(dbName)) {
    console.error(
      `Refusing to run against "${dbName}": these checks seed and delete payment ` +
        'rows. Point MONGODB_URI at a development database.',
    );
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`database: ${dbName}`);
  const startedAt = new Date();

  // ── seed: three payments recorded "today" through the grid
  const plots: any[] = await Plot.find({ isActive: true }).sort({ plotNumber: 1 }).limit(3).lean();
  for (const [i, plot] of plots.entries()) {
    await PaymentService.bulkUpsertMonths(
      [{ plotId: String(plot._id), payments: { sep: 400 * (i + 1) } }],
      2026,
    );
  }
  const seededTotal = 400 + 800 + 1200;
  console.log(`seeded 3 payments (${seededTotal} PKR) on ${plots.map((p) => p.plotBlock).join(', ')}\n`);

  const monthStart = '2026-09-01';

  // ── 1. how many payments were added this month
  let r = await runPlan({
    op: 'count', collection: 'paymentevents',
    filter: { type: 'payment', paidAt: { $gte: monthStart } },
  });
  check('count of payments added this month', r.rows[0].count === 3, `got ${r.rows[0].count}`);

  // ── 2. which ones
  r = await runPlan({
    op: 'find', collection: 'paymentevents', populatePlot: true,
    filter: { type: 'payment', paidAt: { $gte: monthStart } },
    sort: { paidAt: -1 }, limit: 25,
  });
  const owners = r.rows.map((row: any) => row.plotBlock);
  check('which payments, with owner details', r.rowCount === 3 && r.rows.every((x: any) => !!x.ownerName),
    owners.join(', '));
  check('rows carry the month paid for and the amount',
    r.rows.every((x: any) => x.month === 'sep' && x.amount > 0),
    r.rows.map((x: any) => `${x.month}:${x.amount}`).join(' '));

  // ── 3. how much came in this month
  r = await runPlan({
    op: 'sumAmount', collection: 'paymentevents', field: 'amount',
    filter: { type: 'payment', paidAt: { $gte: monthStart } },
  });
  const total = r.rows[0]['total amount'];
  check('total received this month', total === seededTotal, `got ${total}, expected ${seededTotal}`);

  // ── 4. per block — the plot join on a brand-new collection
  r = await runPlan({
    op: 'sumAmount', collection: 'paymentevents', field: 'amount',
    plotGroupBy: 'block', sortDir: -1,
    filter: { type: 'payment', paidAt: { $gte: monthStart } },
  });
  // The three seeded plots may sit in different blocks, so build the expectation
  // from what was seeded rather than assuming they share one.
  const expectedByBlock = new Map<string, number>();
  plots.forEach((p, i) => {
    expectedByBlock.set(p.block, (expectedByBlock.get(p.block) ?? 0) + 400 * (i + 1));
  });
  const nonZero = r.rows.filter((x: any) => x['total amount'] > 0);
  check('grouped by block through the plot ref',
    nonZero.length === expectedByBlock.size &&
      nonZero.every((x: any) => expectedByBlock.get(x.block) === x['total amount']),
    nonZero.map((x: any) => `${x.block}:${x['total amount']}`).join(' ') +
      ' expected ' + [...expectedByBlock].map(([b, n]) => `${b}:${n}`).join(' '));

  // ── 5. a date filter must actually bite (this is what coerceDates fixes)
  r = await runPlan({
    op: 'sumAmount', collection: 'paymentevents', field: 'amount',
    filter: { type: 'payment', paidAt: { $gte: '2027-01-01' } },
  });
  check('a future date window returns nothing', (r.matched ?? 0) === 0, `matched ${r.matched}`);

  // ── 6. who has NOT paid this month, from payments (null OR 0)
  const unpaidTruth = await Payment.countDocuments({
    year: 2026, $or: [{ 'payments.sep': null }, { 'payments.sep': 0 }],
  });
  r = await runPlan({ op: 'count', collection: 'payments', filter: { year: 2026, 'payments.sep': null } });
  check('unpaid September counts null and 0 alike', r.rows[0].count === unpaidTruth,
    `got ${r.rows[0].count}, truth ${unpaidTruth}`);

  // ── 7. who HAS paid it
  const paidTruth = await Payment.countDocuments({ year: 2026, 'payments.sep': { $gt: 0 } });
  r = await runPlan({
    op: 'count', collection: 'payments', filter: { year: 2026, 'payments.sep': { $ne: null } },
  });
  check('paid September excludes the zeros', r.rows[0].count === paidTruth,
    `got ${r.rows[0].count}, truth ${paidTruth}`);

  // ── 8. duesSummary — the ratio nothing else can produce
  r = await runPlan({ op: 'duesSummary', yearFrom: 2026, yearTo: 2026 });
  const summary: any = r.rows[0];
  const truth = await Payment.aggregate([
    { $match: { year: 2026 } },
    { $group: { _id: null, due: { $sum: '$totalDue' }, rec: { $sum: '$totalReceived' } } },
  ]);
  const expectedRate = Math.round((truth[0].rec / truth[0].due) * 1000) / 10;
  check('collection rate matches a direct aggregate',
    summary['collectionRate %'] === expectedRate,
    `got ${summary['collectionRate %']}%, expected ${expectedRate}%`);
  check('per-plot average divides by plots, not payment rows',
    summary.avgRemainingPerPlot === Math.round(summary.totalRemaining / summary.plots),
    `${summary.totalRemaining} / ${summary.plots} = ${summary.avgRemainingPerPlot}`);

  // ── 9. plots per phase, derived from block
  r = await runPlan({ op: 'groupCount', collection: 'plots', groupBy: 'phase', filter: { isActive: true } });
  const phaseTotal = r.rows.reduce((n: number, x: any) => n + x.count, 0);
  const activePlots = await Plot.countDocuments({ isActive: true });
  check('plots per phase adds up to every active plot', phaseTotal === activePlots,
    `${phaseTotal} vs ${activePlots}`);
  check('phase came from the block map', r.plan.derivedFrom === 'block', String(r.plan.derivedFrom));

  // ── 10. blanks stored as empty strings
  const blankPhones = await Plot.countDocuments({ ownerPhone: { $in: [null, ''] } });
  r = await runPlan({ op: 'count', collection: 'plots', filter: { ownerPhone: { $exists: false } } });
  check('"no phone recorded" finds empty strings', r.rows[0].count === blankPhones,
    `got ${r.rows[0].count}, truth ${blankPhones}`);

  // ── 11. per-owner grouping
  r = await runPlan({
    op: 'sumAmount', collection: 'paymentevents', field: 'amount',
    plotGroupBy: 'ownerName', sortDir: -1, limit: 1,
    filter: { type: 'payment', paidAt: { $gte: monthStart } },
  });
  check('grouped by owner name', r.rows[0]?.ownerName === plots[2].ownerName,
    `${r.rows[0]?.ownerName} ${r.rows[0]?.['total amount']}`);

  // ── cleanup
  for (const plot of plots) {
    await PaymentService.bulkUpsertMonths([{ plotId: String(plot._id), payments: { sep: null } }], 2026);
  }
  const removed = await PaymentEvent.deleteMany({ createdAt: { $gte: startedAt } });
  console.log(`\ncleaned up ${removed.deletedCount} activity rows`);
  console.log(`${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})();
