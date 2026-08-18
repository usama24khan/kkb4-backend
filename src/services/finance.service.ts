/**
 * finance.service.ts
 * ==================
 * The society cash book: what came in, what went out, what is left.
 *
 * Two rules govern everything here.
 *
 * 1. **Money counts in the month it was received, not the month it pays for.**
 *    An owner clearing three years of arrears today adds the whole amount to
 *    today's income; an owner paying four months ahead does too. The dues months
 *    those payments clear are recorded separately, as allocations against
 *    `Payment`.
 *
 * 2. **Nothing is stored that can be derived.** Monthly income, expenditure,
 *    savings and the running balance are aggregated from the ledger on every
 *    read, so a corrected or voided entry can never leave a stale total behind.
 *
 * Savings are a single running balance rather than a sum of good months:
 *
 *     monthSaving(M)   = income(M) − expense(M)              // may be negative
 *     runningSaving(M) = openingBalance + Σ monthSaving(m ≤ M)
 *
 * which is what lets the committee spend an accumulated pool on one large job
 * and see the pool draw down correctly.
 */

import { Types } from 'mongoose';
import Collection, { IAllocation, ICollection } from '../models/Collection';
import Expense from '../models/Expense';
import ExpenseCategory from '../models/ExpenseCategory';
import FinanceSettings, { IFinanceSettings } from '../models/FinanceSettings';
import Payment from '../models/Payment';
import Plot from '../models/Plot';
import Receipt from '../models/Receipt';
import MonthlyRate from '../models/MonthlyRate';
import { MONTHS, YEARS_WITH_DATA, getMcRateForMonth } from '../config/constants';
import {
  currentBookPeriod,
  monthKey,
  monthNumber,
  periodOrdinal,
  toBookPeriod,
} from '../utils/financePeriod';
import { generateReceiptPDF } from '../utils/receiptPdfGenerator';

/** How many months ahead an owner may pay in advance. */
export const MAX_ADVANCE_MONTHS = 36;

/** Earliest dues year the society charges for. */
export const DUES_START_YEAR = Math.min(...YEARS_WITH_DATA);

/** Default categories created on first use so the expense form is never empty. */
const DEFAULT_CATEGORIES = [
  { name: 'Sweeper Salary', nameUr: 'خاکروب کی تنخواہ', sortOrder: 10 },
  { name: 'Security Guard', nameUr: 'چوکیدار کی تنخواہ', sortOrder: 20 },
  { name: 'Petrol / Fuel', nameUr: 'پٹرول / ایندھن', sortOrder: 30 },
  { name: 'Sewerage', nameUr: 'سیوریج', sortOrder: 40 },
  { name: 'Electricity', nameUr: 'بجلی', sortOrder: 50 },
  { name: 'Repairs & Maintenance', nameUr: 'مرمت و دیکھ بھال', sortOrder: 60 },
  { name: 'Development Work', nameUr: 'ترقیاتی کام', sortOrder: 70 },
  { name: 'Miscellaneous', nameUr: 'متفرق', sortOrder: 999 },
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface MonthDue {
  year: number;
  month: string;
  /** Full charge for that month. */
  rate: number;
  /** Already recorded against the month. */
  paid: number;
  /** `rate − paid`, floored at 0. */
  owed: number;
}

export interface RecordCollectionInput {
  plotId: string;
  amount: number;
  method?: string;
  receivedDate?: string | Date;
  /** Explicit month allocation. Omit to auto-allocate oldest-unpaid-first. */
  allocations?: Array<{ year: number; month: string; amount: number }>;
  entryType?: 'live' | 'historical';
  note?: string;
  /** Generate a receipt for this payment. Defaults to true for live entries. */
  generateReceipt?: boolean;
  language?: 'en' | 'ur';
  /** Overrides the society name printed on the receipt. */
  societyName?: string;
  /** Year to begin auto-allocation from; defaults to the plot's earliest record. */
  allocateFromYear?: number;
  /**
   * Whether to write the allocations into `Payment`. The bulk grid sets the
   * month buckets itself and then asks for a ledger row describing what it just
   * changed, so it passes false to avoid double-crediting the owner.
   */
  applyToDues?: boolean;
}

export interface PeriodTotals {
  income: number;
  expense: number;
  saving: number;
}

// ── Rates ────────────────────────────────────────────────────────────────────

/**
 * Resolves the monthly charge for any given month.
 *
 * The charge rose to PKR 400 in May 2022, part-way through the year, so this is
 * answered per month and never per year — pricing January to April 2022 at 400
 * would overcharge, and pricing May onwards at 200 undercharges every receipt
 * issued since.
 *
 * Admin overrides in the database take precedence over the built-in schedule.
 * Each override applies from its own (year, fromMonth) until the next one, so a
 * mid-year change can be expressed by adding a second entry for that year.
 */
export type RateResolver = (year: number, month: number) => number;

export async function getRateResolver(): Promise<RateResolver> {
  const docs = await MonthlyRate.find().select('year fromMonth rate').lean();
  const overrides = docs
    .map((d: any) => ({
      ordinal: periodOrdinal(d.year, Number(d.fromMonth) || 1),
      rate: Number(d.rate),
    }))
    .sort((a, b) => a.ordinal - b.ordinal);

  return (year: number, month: number): number => {
    const ordinal = periodOrdinal(year, month);
    // The latest override that has taken effect by this month, if any.
    let resolved: number | null = null;
    for (const o of overrides) {
      if (o.ordinal <= ordinal) resolved = o.rate;
      else break;
    }
    return resolved ?? getMcRateForMonth(year, month);
  };
}

/**
 * Monthly charge per year — the year's prevailing (December) figure.
 *
 * Only for callers that can hold one number per year, such as the `mcRate`
 * stored on a payment record. Anything computing what is owed wants
 * `getRateResolver`.
 */
export async function getRateMap(): Promise<Record<number, number>> {
  const resolve = await getRateResolver();
  const map: Record<number, number> = {};
  for (const year of YEARS_WITH_DATA) map[year] = resolve(year, 12);
  return map;
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * The singleton settings doc, created on first read.
 *
 * An upsert rather than find-then-create: the reports fan out into several
 * parallel queries that each need the opening balance, so a read-then-write
 * would race with itself on a cold database and trip the unique `key` index.
 */
export async function getSettings(): Promise<IFinanceSettings> {
  return FinanceSettings.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default', openingBalance: 0, openingAsOf: new Date() } },
    { new: true, upsert: true }
  ) as unknown as IFinanceSettings;
}

/** Create the default expense categories once, then return all of them. */
export async function ensureCategories() {
  const count = await ExpenseCategory.countDocuments();
  if (count === 0) {
    // insertMany with ordered:false so a concurrent cold start racing us on the
    // unique name index doesn't abort the whole seed.
    await ExpenseCategory.insertMany(DEFAULT_CATEGORIES, { ordered: false }).catch(() => {});
  }
  return ExpenseCategory.find().sort({ sortOrder: 1, name: 1 }).lean();
}

// ── Dues & allocation ────────────────────────────────────────────────────────

/**
 * Every month from `fromYear` up to `throughOrdinal` that still owes money for
 * this plot, oldest first, followed by the future months it could pay ahead
 * into. Months already covered are omitted from the arrears part but future
 * months are always listed (they carry `paid: 0` until someone pays ahead).
 */
export async function getDuesLadder(
  plotId: string,
  opts: { fromYear?: number; throughOrdinal?: number; advanceMonths?: number } = {}
): Promise<{ arrears: MonthDue[]; future: MonthDue[] }> {
  const resolveRate = await getRateResolver();
  const payments = await Payment.find({ plot: plotId }).lean();
  const byYear = new Map<number, any>();
  for (const p of payments) byYear.set(p.year, p);

  const now = currentBookPeriod();
  const throughOrdinal = opts.throughOrdinal ?? periodOrdinal(now.bookYear, now.bookMonth);
  const advanceMonths = opts.advanceMonths ?? MAX_ADVANCE_MONTHS;

  // Where to start counting arrears from. An explicit year wins; otherwise the
  // plot's earliest existing record, so a plot with no history at all doesn't
  // suddenly owe from 2012.
  const recordedYears = payments.map((p) => p.year);
  const fromYear =
    opts.fromYear ??
    (recordedYears.length ? Math.min(...recordedYears) : Math.floor(throughOrdinal / 12));

  const arrears: MonthDue[] = [];
  const future: MonthDue[] = [];

  const startOrdinal = periodOrdinal(fromYear, 1);
  const endOrdinal = throughOrdinal + advanceMonths;

  for (let ord = startOrdinal; ord <= endOrdinal; ord++) {
    const month = ((ord - 1) % 12) + 1;
    const year = Math.floor((ord - month) / 12);
    if (year < DUES_START_YEAR) continue;

    const record = byYear.get(year);
    // The schedule decides, not the record's own `mcRate`: that field holds one
    // number for a whole year and cannot describe a month the charge changed in.
    const rate = resolveRate(year, month);
    const paid = Number(record?.payments?.[monthKey(month)]) || 0;
    const owed = Math.max(0, rate - paid);
    const entry: MonthDue = { year, month: monthKey(month), rate, paid, owed };

    if (ord <= throughOrdinal) {
      if (owed > 0) arrears.push(entry);
    } else {
      future.push(entry);
    }
  }

  return { arrears, future };
}

/**
 * Spread `amount` over months, at each month's own rate.
 *
 * Two modes, because "which months did this money pay for" is the admin's call,
 * not something to infer:
 *
 *  - default: oldest-unpaid-first, then on into future months. Right when an
 *    owner is clearing a backlog.
 *  - `startYear`/`startMonth`: begin at that month and run forwards, ignoring
 *    older unpaid months entirely. Right when the owner says "this is for July"
 *    — without it, ₨400 handed over in July silently cleared Jan and Feb 2012
 *    instead, because those were the oldest months owing.
 *
 * A trailing remainder too small to cover a whole month is still allocated
 * (a part-payment against that month), so `unallocatedAmount` stays 0 whenever
 * the money maps onto real months.
 */
export async function autoAllocate(
  plotId: string,
  amount: number,
  opts: {
    fromYear?: number;
    throughOrdinal?: number;
    startYear?: number;
    startMonth?: number;
  } = {}
): Promise<IAllocation[]> {
  // When anchored to a month, the ladder has to reach back to that month even if
  // the plot's own records start later.
  const { arrears, future } = await getDuesLadder(plotId, {
    ...opts,
    fromYear: opts.fromYear ?? opts.startYear,
  });
  let ladder = [...arrears, ...future];

  if (opts.startYear && opts.startMonth) {
    // Anchored to a month the admin named: drop everything before it.
    const startOrd = periodOrdinal(opts.startYear, opts.startMonth);
    ladder = ladder.filter((d) => periodOrdinal(d.year, monthNumber(d.month)) >= startOrd);
  }

  const allocations: IAllocation[] = [];
  let left = amount;

  for (const due of ladder) {
    if (left <= 0) break;
    // A month that owes nothing is passed over, so the money lands on the next
    // month with room instead of stacking a second full charge onto a month that
    // is already settled. Partly-paid months still take what they are short.
    if (due.owed <= 0) continue;
    const take = Math.min(left, due.owed);
    allocations.push({ year: due.year, month: due.month, amount: take });
    left -= take;
  }

  return allocations;
}

/** What a single month owes, for warning the admin before a payment is recorded. */
export async function getMonthStatus(
  plotId: string,
  year: number,
  month: number,
): Promise<{ year: number; month: string; paid: number; rate: number; owed: number }> {
  const resolveRate = await getRateResolver();
  const record: any = await Payment.findOne({ plot: plotId, year }).lean();
  const rate = resolveRate(year, month);
  const paid = Number(record?.payments?.[monthKey(month)]) || 0;
  return { year, month: monthKey(month), paid, rate, owed: Math.max(0, rate - paid) };
}

/** A month an allocation targets that already has money recorded against it. */
export interface AllocationConflict {
  year: number;
  month: string;
  /** Already recorded against that month. */
  alreadyPaid: number;
  /** The month's full charge. */
  rate: number;
  /** What the month would hold once this payment is applied. */
  wouldBecome: number;
}

/**
 * Which of these months already have money against them.
 *
 * Allocations are added to a month rather than replacing it, so recording ₨400
 * for a July that already holds ₨400 leaves July at ₨800. That is right for a
 * genuine top-up and wrong for a payment being entered twice, and only the person
 * at the counter can tell which — so the UI shows this and lets them decide,
 * rather than the server silently doing either.
 */
export async function findAllocationConflicts(
  plotId: string,
  allocations: Array<{ year: number; month: string; amount: number }>,
): Promise<AllocationConflict[]> {
  if (!allocations.length) return [];

  const resolveRate = await getRateResolver();
  const years = [...new Set(allocations.map((a) => a.year))];
  const payments = await Payment.find({ plot: plotId, year: { $in: years } }).lean();
  const byYear = new Map(payments.map((p) => [p.year, p]));

  const conflicts: AllocationConflict[] = [];
  for (const alloc of allocations) {
    const record: any = byYear.get(alloc.year);
    const alreadyPaid = Number(record?.payments?.[String(alloc.month).toLowerCase()]) || 0;
    if (alreadyPaid <= 0) continue;
    conflicts.push({
      year: alloc.year,
      month: String(alloc.month).toLowerCase(),
      alreadyPaid,
      rate: resolveRate(alloc.year, monthNumber(String(alloc.month))),
      wouldBecome: alreadyPaid + alloc.amount,
    });
  }
  return conflicts;
}

/** Reject allocations that reference an impossible month or a negative amount. */
function validateAllocations(allocations: Array<{ year: number; month: string; amount: number }>): string | null {
  for (const a of allocations) {
    if (!Number.isInteger(a.year) || a.year < DUES_START_YEAR || a.year > 2100) {
      return `Invalid allocation year: ${a.year}`;
    }
    if (!monthNumber(String(a.month))) return `Invalid allocation month: ${a.month}`;
    if (!Number.isFinite(a.amount) || a.amount < 0) return `Invalid allocation amount for ${a.month} ${a.year}`;
  }
  return null;
}

/**
 * Add (or, with a negative `sign`, subtract) allocations against the plot's
 * `Payment` month buckets, creating the year record when it doesn't exist yet.
 * Buckets are adjusted rather than overwritten so two part-payments for the same
 * month accumulate instead of clobbering each other.
 */
async function applyAllocations(
  plotId: string,
  allocations: IAllocation[],
  sign: 1 | -1
): Promise<void> {
  if (!allocations.length) return;

  const resolveRate = await getRateResolver();
  const byYear = new Map<number, IAllocation[]>();
  for (const alloc of allocations) {
    const list = byYear.get(alloc.year) || [];
    list.push(alloc);
    byYear.set(alloc.year, list);
  }

  for (const [year, list] of byYear) {
    let payment = await Payment.findOne({ plot: plotId, year });
    if (!payment) {
      // Reversing something that was never recorded — nothing to undo.
      if (sign === -1) continue;
      payment = new Payment({
        plot: plotId,
        year,
        mcRate: resolveRate(year, 12),
        payments: {},
      });
    }

    for (const alloc of list) {
      const key = String(alloc.month).toLowerCase();
      if (!MONTHS.includes(key as any)) continue;
      const current = Number((payment.payments as any)[key]) || 0;
      const next = current + sign * alloc.amount;
      // A cleared month drops back to null rather than 0 so the existing UI
      // (which treats > 0 as paid and null as untouched) stays consistent.
      (payment.payments as any)[key] = next > 0 ? next : null;
    }

    // The pre-save hook recomputes totalReceived / totalDue / remaining.
    await payment.save();
  }
}

// ── Recording money in ───────────────────────────────────────────────────────

/**
 * Record a payment received from a plot owner.
 *
 * One call does all four things that must stay in step: the dues months are
 * cleared on `Payment`, the cash is written to the ledger, a receipt is issued,
 * and the owner's totals are recalculated. Historical entries skip the receipt
 * and are flagged out of the cash book (see `Collection` for why).
 *
 * The writes are ordered so a mid-way failure is recoverable: the dues buckets
 * are applied first, and if the ledger row then fails to save they are rolled
 * straight back out.
 */
export async function recordCollection(
  input: RecordCollectionInput,
  adminId?: string
): Promise<{ collection: ICollection; receipt: any | null }> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('A valid amount greater than zero is required'), { status: 400 });
  }

  const plot = await Plot.findById(input.plotId).lean();
  if (!plot) {
    throw Object.assign(new Error('Selected plot not found'), { status: 400 });
  }

  const entryType = input.entryType === 'historical' ? 'historical' : 'live';
  const receivedDate = input.receivedDate ? new Date(input.receivedDate) : new Date();
  if (isNaN(receivedDate.getTime())) {
    throw Object.assign(new Error('Invalid received date'), { status: 400 });
  }
  const period = toBookPeriod(receivedDate);

  // Allocations: caller-supplied wins, otherwise auto oldest-first. Auto
  // allocation for a historical entry is capped at the entry's own period so a
  // 2015 record never quietly pays off 2024.
  //
  // An *explicit* empty array means "this money isn't for any particular month"
  // (a donation or a fine) and is honoured as such. Only an absent field asks
  // for auto-allocation — treating `[]` as "decide for me" would let a caller
  // silently clear years of dues it never mentioned.
  let allocations: IAllocation[];
  if (Array.isArray(input.allocations)) {
    const error = validateAllocations(input.allocations);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    allocations = input.allocations
      .filter((a) => Number(a.amount) > 0)
      .map((a) => ({
        year: Number(a.year),
        month: String(a.month).toLowerCase(),
        amount: Number(a.amount),
      }));
  } else {
    allocations = await autoAllocate(input.plotId, amount, {
      fromYear: input.allocateFromYear,
      throughOrdinal: periodOrdinal(period.bookYear, period.bookMonth),
    });
  }

  const allocatedTotal = allocations.reduce((sum, a) => sum + a.amount, 0);
  if (allocatedTotal > amount + 0.5) {
    throw Object.assign(
      new Error(`Allocated ${allocatedTotal} exceeds the received amount ${amount}`),
      { status: 400 }
    );
  }

  const applyToDues = input.applyToDues !== false;
  if (applyToDues) await applyAllocations(input.plotId, allocations, 1);

  let collection: ICollection;
  try {
    collection = await Collection.create({
      plot: plot._id,
      amount,
      method: input.method || 'cash',
      receivedDate,
      allocations,
      entryType,
      // The whole point of a historical entry: dues get updated, the cash book
      // does not move.
      countInCashBook: entryType === 'live',
      note: input.note || '',
      recordedBy: adminId ? new Types.ObjectId(adminId) : null,
    });
  } catch (err) {
    // Undo the dues we just applied so the owner's balance isn't silently
    // credited for a payment that has no ledger row.
    if (applyToDues) await applyAllocations(input.plotId, allocations, -1).catch(() => {});
    throw err;
  }

  // Receipts are for money actually handed over; historical data entry doesn't
  // produce one unless the caller explicitly asks.
  const wantsReceipt = input.generateReceipt ?? entryType === 'live';
  let receipt: any = null;
  if (wantsReceipt) {
    try {
      const first = allocations[0];
      const last = allocations[allocations.length - 1];
      // `year` is the year the receipt is *issued* in — receipt numbers are
      // allocated per year (KKB-2026-0001), so dating it by the months being paid
      // for would file today's slip in the 2012 series.
      //
      // The "Month" line, by contrast, names the month being paid *for*: an owner
      // clearing 2015 arrears must not be handed a slip that says August. For a
      // multi-month payment it shows the first covered month, and the period line
      // underneath carries the full span including its years.
      receipt = await Receipt.create({
        year: period.bookYear,
        month: first ? monthLabel(monthNumber(first.month)) : monthLabel(period.bookMonth),
        language: input.language === 'ur' ? 'ur' : 'en',
        plotRef: plot._id,
        blockNo: plot.block || '',
        plotNo: plot.plotNumber || '',
        ownerName: plot.ownerName || '',
        amount,
        paymentDate: receivedDate,
        dateFrom: first ? monthStart(first.year, monthNumber(first.month)) : null,
        dateTo: last ? monthEnd(last.year, monthNumber(last.month)) : null,
        // Every month this payment settled, so the slip can name them all rather
        // than just the first.
        coveredMonths: allocations.map((a) => ({ year: a.year, month: a.month })),
        societyName: input.societyName?.trim() || undefined,
        isVerified: true,
        collectionRef: collection._id,
        generatedBy: adminId || null,
      });

      collection.receiptRef = receipt._id;
      await collection.save();

      // Cache the PDF now so the admin can hand it over immediately. A failure
      // here is not fatal — the PDF route regenerates lazily.
      try {
        const { url } = await generateReceiptPDF(receipt);
        receipt.filePath = url;
        await receipt.save();
      } catch (err) {
        console.warn('[finance] receipt PDF generation failed:', (err as Error).message);
      }
    } catch (err) {
      // The payment itself is recorded; only the receipt failed. Surface it in
      // the logs rather than losing the collection.
      console.warn('[finance] receipt creation failed:', (err as Error).message);
    }
  }

  return { collection, receipt };
}

/**
 * Reverse a collection: subtract its allocations back out of the plot's dues,
 * exclude it from every total, and invalidate its receipt. The row itself is
 * kept so the audit trail survives.
 */
export async function voidCollection(
  collectionId: string,
  adminId?: string,
  reason?: string
): Promise<ICollection | null> {
  const collection = await Collection.findById(collectionId);
  if (!collection) return null;
  if (collection.isVoided) return collection;

  await applyAllocations(collection.plot.toString(), collection.allocations, -1);

  collection.isVoided = true;
  collection.voidedAt = new Date();
  collection.voidedBy = adminId ? new Types.ObjectId(adminId) : null;
  collection.voidReason = reason || '';
  await collection.save();

  if (collection.receiptRef) {
    await Receipt.findByIdAndUpdate(collection.receiptRef, {
      isVoided: true,
      isVerified: false,
      voidReason: reason || 'Payment voided',
    }).catch(() => {});
  }

  return collection;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Live income totals for an inclusive book-period range. */
async function incomeBetween(fromOrdinal: number, toOrdinal: number) {
  const [row] = await Collection.aggregate([
    {
      $match: {
        bookOrdinal: { $gte: fromOrdinal, $lte: toOrdinal },
        countInCashBook: true,
        isVoided: false,
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        arrears: { $sum: '$arrearsAmount' },
        current: { $sum: '$currentAmount' },
        advance: { $sum: '$advanceAmount' },
        unallocated: { $sum: '$unallocatedAmount' },
      },
    },
  ]);
  return {
    total: row?.total || 0,
    count: row?.count || 0,
    arrears: row?.arrears || 0,
    current: row?.current || 0,
    advance: row?.advance || 0,
    unallocated: row?.unallocated || 0,
  };
}

/** Expense total for an inclusive book-period range. */
async function expenseBetween(fromOrdinal: number, toOrdinal: number) {
  const [row] = await Expense.aggregate([
    { $match: { bookOrdinal: { $gte: fromOrdinal, $lte: toOrdinal }, isVoided: false } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return { total: row?.total || 0, count: row?.count || 0 };
}

/**
 * Cash in hand at the start of a period: the opening balance plus every month
 * of surplus or deficit before it.
 */
export async function getOpeningBalanceFor(ordinal: number): Promise<number> {
  const settings = await getSettings();
  const [income, expense] = await Promise.all([
    incomeBetween(0, ordinal - 1),
    expenseBetween(0, ordinal - 1),
  ]);
  return settings.openingBalance + income.total - expense.total;
}

/**
 * Full report for one month: income (with its arrears / current / advance
 * split), the expense lines and their category totals, the month's surplus, and
 * the running savings balance before and after.
 */
export async function getMonthReport(year: number, month: number) {
  const ordinal = periodOrdinal(year, month);

  const [income, expenseTotals, expenses, openingBalance, settings] = await Promise.all([
    incomeBetween(ordinal, ordinal),
    expenseBetween(ordinal, ordinal),
    Expense.find({ bookOrdinal: ordinal, isVoided: false })
      .sort({ expenseDate: 1, createdAt: 1 })
      .populate('recordedBy', 'name email')
      .lean(),
    getOpeningBalanceFor(ordinal),
    getSettings(),
  ]);

  const byCategoryMap = new Map<string, { category: string; amount: number; count: number }>();
  for (const e of expenses) {
    const name = e.categoryName || 'Uncategorised';
    const entry = byCategoryMap.get(name) || { category: name, amount: 0, count: 0 };
    entry.amount += e.amount;
    entry.count += 1;
    byCategoryMap.set(name, entry);
  }
  const byCategory = [...byCategoryMap.values()].sort((a, b) => b.amount - a.amount);

  const saving = income.total - expenseTotals.total;
  const now = currentBookPeriod();

  return {
    period: { year, month, monthKey: monthKey(month), ordinal },
    /**
     * Whether this report is the month the society is currently in. The UI needs
     * it to label the savings figure honestly: for a past month the closing
     * balance is history, for this month it is cash on hand right now.
     */
    isCurrentPeriod: ordinal === periodOrdinal(now.bookYear, now.bookMonth),
    income: {
      total: income.total,
      count: income.count,
      arrears: income.arrears,
      current: income.current,
      advance: income.advance,
      unallocated: income.unallocated,
    },
    expense: { total: expenseTotals.total, count: expenseTotals.count, byCategory },
    saving,
    openingBalance,
    closingBalance: openingBalance + saving,
    expenses,
    openingAsOf: settings.openingAsOf,
  };
}

/**
 * The twelve rows behind the year table: income, expenditure, monthly saving and
 * the running savings balance at the end of each month.
 */
export async function getYearReport(year: number) {
  const janOrdinal = periodOrdinal(year, 1);
  const decOrdinal = periodOrdinal(year, 12);

  const [incomeRows, expenseRows, openingBalance] = await Promise.all([
    Collection.aggregate([
      {
        $match: {
          bookOrdinal: { $gte: janOrdinal, $lte: decOrdinal },
          countInCashBook: true,
          isVoided: false,
        },
      },
      {
        $group: {
          _id: '$bookMonth',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
          arrears: { $sum: '$arrearsAmount' },
          current: { $sum: '$currentAmount' },
          advance: { $sum: '$advanceAmount' },
        },
      },
    ]),
    Expense.aggregate([
      { $match: { bookOrdinal: { $gte: janOrdinal, $lte: decOrdinal }, isVoided: false } },
      { $group: { _id: '$bookMonth', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    getOpeningBalanceFor(janOrdinal),
  ]);

  const incomeByMonth = new Map<number, any>(incomeRows.map((r: any) => [r._id, r]));
  const expenseByMonth = new Map<number, any>(expenseRows.map((r: any) => [r._id, r]));

  let running = openingBalance;
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const inc = incomeByMonth.get(m);
    const exp = expenseByMonth.get(m);
    const income = inc?.total || 0;
    const expense = exp?.total || 0;
    const saving = income - expense;
    running += saving;
    months.push({
      month: m,
      monthKey: monthKey(m),
      income,
      incomeCount: inc?.count || 0,
      arrears: inc?.arrears || 0,
      current: inc?.current || 0,
      advance: inc?.advance || 0,
      expense,
      expenseCount: exp?.count || 0,
      saving,
      runningSaving: running,
    });
  }

  const totals = months.reduce(
    (acc, m) => ({
      income: acc.income + m.income,
      expense: acc.expense + m.expense,
      saving: acc.saving + m.saving,
    }),
    { income: 0, expense: 0, saving: 0 } as PeriodTotals
  );

  return { year, openingBalance, closingBalance: running, totals, months };
}

/**
 * One row per year that has any ledger activity, plus the all-time totals and
 * the current savings pool.
 */
export async function getYearlyReport() {
  const [incomeRows, expenseRows, settings] = await Promise.all([
    Collection.aggregate([
      { $match: { countInCashBook: true, isVoided: false } },
      { $group: { _id: '$bookYear', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: { isVoided: false } },
      { $group: { _id: '$bookYear', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    getSettings(),
  ]);

  const incomeByYear = new Map<number, any>(incomeRows.map((r: any) => [r._id, r]));
  const expenseByYear = new Map<number, any>(expenseRows.map((r: any) => [r._id, r]));
  const allYears = [...new Set([...incomeByYear.keys(), ...expenseByYear.keys()])].sort((a, b) => a - b);

  let running = settings.openingBalance;
  const years = allYears.map((year) => {
    const income = incomeByYear.get(year)?.total || 0;
    const expense = expenseByYear.get(year)?.total || 0;
    const saving = income - expense;
    running += saving;
    return {
      year,
      income,
      incomeCount: incomeByYear.get(year)?.count || 0,
      expense,
      expenseCount: expenseByYear.get(year)?.count || 0,
      saving,
      runningSaving: running,
    };
  });

  const totals = years.reduce(
    (acc, y) => ({
      income: acc.income + y.income,
      expense: acc.expense + y.expense,
      saving: acc.saving + y.saving,
    }),
    { income: 0, expense: 0, saving: 0 } as PeriodTotals
  );

  return {
    openingBalance: settings.openingBalance,
    openingAsOf: settings.openingAsOf,
    totals,
    /** Cash the society is holding right now. */
    totalSaving: running,
    years,
  };
}

/**
 * Headline figures for the dashboard: this month's income, expenditure and
 * surplus, plus the total savings pool.
 */
export async function getFinanceOverview() {
  const now = currentBookPeriod();
  const [month, yearly] = await Promise.all([
    getMonthReport(now.bookYear, now.bookMonth),
    getYearlyReport(),
  ]);

  return {
    currentPeriod: { year: now.bookYear, month: now.bookMonth, monthKey: monthKey(now.bookMonth) },
    thisMonth: {
      income: month.income.total,
      expense: month.expense.total,
      saving: month.saving,
    },
    totalSaving: yearly.totalSaving,
    openingBalance: yearly.openingBalance,
    allTime: yearly.totals,
  };
}

// ── Ledger listing ───────────────────────────────────────────────────────────

/**
 * Paginated collections ledger. Filters are all optional and compose: book
 * period, plot, entry type, and whether archival rows are included.
 */
export async function listCollections(opts: {
  year?: number;
  month?: number;
  plotId?: string;
  entryType?: 'live' | 'historical';
  includeArchival?: boolean;
  includeVoided?: boolean;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(200, Math.max(1, opts.limit || 25));

  const filter: any = {};
  if (opts.year && opts.month) filter.bookOrdinal = periodOrdinal(opts.year, opts.month);
  else if (opts.year) {
    filter.bookOrdinal = { $gte: periodOrdinal(opts.year, 1), $lte: periodOrdinal(opts.year, 12) };
  }
  if (opts.plotId) filter.plot = opts.plotId;
  if (opts.entryType) filter.entryType = opts.entryType;
  if (!opts.includeArchival) filter.countInCashBook = true;
  if (!opts.includeVoided) filter.isVoided = false;

  const [items, total] = await Promise.all([
    Collection.find(filter)
      .sort({ receivedDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('plot', 'plotBlock plotNumber block ownerName')
      .populate('receiptRef', 'receiptNumber filePath')
      .populate('recordedBy', 'name email')
      .lean(),
    Collection.countDocuments(filter),
  ]);

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

// ── Small date helpers used for receipt period labels ────────────────────────

function monthLabel(month: number): string {
  return [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][month - 1] || '';
}

function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, Math.max(0, month - 1), 1, 12, 0, 0));
}

function monthEnd(year: number, month: number): Date {
  return new Date(Date.UTC(year, Math.max(1, month), 0, 12, 0, 0));
}
