import Payment, { IPayment } from '../models/Payment';
import Plot from '../models/Plot';
import Collection from '../models/Collection';
import { MONTHS, getMcRateForYear } from '../config/constants';
import { Types } from 'mongoose';

/**
 * Recompute totalReceived/totalDue/remaining from the current month fields.
 * Mutates the payment in place.
 */
function recalcTotals(payment: IPayment): void {
  let total = 0;
  for (const m of MONTHS) {
    const val = (payment.payments as any)[m];
    if (val !== null && val !== undefined && !isNaN(val)) total += val;
  }
  payment.totalReceived = total;
  payment.totalDue = payment.mcRate * 12;
  payment.remaining = payment.totalDue - payment.totalReceived;
}

/** A month the grid refused to reduce, because a recorded payment covers it. */
export interface BlockedMonth {
  plotId: string;
  year: number;
  month: string;
  keptAmount: number;
  attemptedAmount: number;
}

/**
 * Months that a live cash-book entry has paid for, for the given plots.
 *
 * The grid writes dues directly, with no effect on the cash book. That is right
 * for loading old records and wrong for anything the society has actually banked:
 * clearing such a month would leave income in the accounts, a receipt in the
 * owner's hand, and nothing on their record to match. Those months are therefore
 * off limits to the grid — they are changed by voiding the payment in Accounts,
 * which reverses the dues, the income and the receipt together.
 */
async function loadLedgerBackedMonths(plotIds: string[]): Promise<Set<string>> {
  const backed = new Set<string>();
  if (plotIds.length === 0) return backed;

  const live = await Collection.find({
    plot: { $in: plotIds },
    isVoided: false,
    countInCashBook: true,
  })
    .select('plot allocations')
    .lean();

  for (const entry of live as any[]) {
    for (const alloc of entry.allocations || []) {
      backed.add(`${entry.plot}:${alloc.year}:${String(alloc.month).toLowerCase()}`);
    }
  }
  return backed;
}

/**
 * Which of a year's months are backed by a recorded payment.
 *
 * Any route that lowers or removes a month has to consult this. Taking money off
 * a month the cash book has banked leaves the income counted, the owner's record
 * empty and a receipt in their hand — three things that no longer agree, with
 * nothing to show it happened. Voiding the payment in Accounts is the one action
 * that unwinds all three together, so these paths refuse and say so.
 */
async function ledgerBackedMonthsFor(plotId: string, year: number): Promise<Set<string>> {
  const backed = new Set<string>();
  const live = await Collection.find({ plot: plotId, isVoided: false, countInCashBook: true })
    .select('allocations')
    .lean();
  for (const entry of live as any[]) {
    for (const alloc of entry.allocations || []) {
      if (Number(alloc.year) === Number(year)) backed.add(String(alloc.month).toLowerCase());
    }
  }
  return backed;
}

/** Raised when a caller tries to undo a month the cash book has banked. */
export class LedgerBackedError extends Error {
  constructor(public readonly months: string[], public readonly year: number) {
    super(
      `${months.join(', ')} ${year} ${months.length === 1 ? 'is' : 'are'} covered by a recorded payment. ` +
        `Void that payment in Accounts to reverse the dues, the income and the receipt together.`,
    );
    this.name = 'LedgerBackedError';
  }
}

export class PaymentService {
  static async getByPlotAndYear(plotId: string, year: number) {
    return Payment.findOne({ plot: plotId, year }).populate('plot').lean();
  }

  static async getAllByPlot(plotId: string) {
    return Payment.find({ plot: plotId }).sort({ year: 1 }).lean();
  }

  static async update(paymentId: string, data: Partial<IPayment>) {
    const payment = await Payment.findById(paymentId);
    if (!payment) return null;

    if (data.payments) {
      const backed = await ledgerBackedMonthsFor(payment.plot.toString(), payment.year);
      const refused: string[] = [];
      for (const month of MONTHS) {
        const incoming = (data.payments as any)[month];
        if (incoming === undefined) continue;
        const before = Number((payment.payments as any)[month]) || 0;
        const after = Number(incoming) || 0;
        if (after < before && backed.has(month)) {
          refused.push(month);
          continue;
        }
        (payment.payments as any)[month] = incoming;
      }
      if (refused.length) throw new LedgerBackedError(refused, payment.year);
    }
    if (data.mcRate !== undefined) payment.mcRate = data.mcRate;
    if (data.note !== undefined) payment.note = data.note;

    // Recalculate totals
    let total = 0;
    for (const month of MONTHS) {
      const val = (payment.payments as any)[month];
      if (val !== null && val !== undefined && !isNaN(val)) {
        total += val;
      }
    }
    payment.totalReceived = total;
    payment.totalDue = payment.mcRate * 12;
    payment.remaining = payment.totalDue - payment.totalReceived;

    return payment.save();
  }

  static async deletePayment(paymentId: string) {
    const payment = await Payment.findById(paymentId).select('plot year payments').lean();
    if (!payment) return null;

    // Deleting the year would take every month with it, recorded payments included.
    const backed = await ledgerBackedMonthsFor((payment as any).plot.toString(), (payment as any).year);
    const withMoney = MONTHS.filter((m) => backed.has(m));
    if (withMoney.length) throw new LedgerBackedError(withMoney, (payment as any).year);

    return Payment.findByIdAndDelete(paymentId);
  }

  /**
   * Void a single month for a (plot, year) payment record.
   * The cleared amount is preserved in `voidedEntries` so it can be restored.
   * Returns the result of the operation, or null if no such payment record /
   * month value exists.
   */
  static async voidMonth(
    paymentId: string,
    month: string,
    adminId: string | undefined,
    reason?: string,
  ): Promise<{ payment: IPayment; voidedAmount: number } | null> {
    if (!MONTHS.includes(month as any)) return null;

    const payment = await Payment.findById(paymentId);
    if (!payment) return null;

    const currentAmount = (payment.payments as any)[month];
    if (currentAmount === null || currentAmount === undefined || currentAmount === 0) {
      // Nothing to void.
      return null;
    }

    // Voiding here only clears the dues; the income and the receipt would remain.
    const backed = await ledgerBackedMonthsFor(payment.plot.toString(), payment.year);
    if (backed.has(month)) throw new LedgerBackedError([month], payment.year);

    payment.voidedEntries.push({
      month,
      amount: currentAmount,
      voidedAt: new Date(),
      voidedBy: adminId ? new Types.ObjectId(adminId) : null,
      reason: reason || '',
      restored: false,
      restoredAt: null,
      restoredBy: null,
    } as any);

    (payment.payments as any)[month] = null;
    recalcTotals(payment);

    const saved = await payment.save();
    return { payment: saved, voidedAmount: currentAmount };
  }

  /**
   * Restore the most-recent unrestored void for a given month. Returns null if
   * there's nothing to restore (no matching unrestored entry) or the payment
   * doesn't exist.
   */
  static async restoreMonth(
    paymentId: string,
    month: string,
    adminId: string | undefined,
  ): Promise<{ payment: IPayment; restoredAmount: number } | null> {
    if (!MONTHS.includes(month as any)) return null;

    const payment = await Payment.findById(paymentId);
    if (!payment) return null;

    // Find the most-recent unrestored void for this month.
    let targetIdx = -1;
    let targetTime = -Infinity;
    payment.voidedEntries.forEach((entry, idx) => {
      if (entry.month !== month || entry.restored) return;
      const t = entry.voidedAt ? new Date(entry.voidedAt).getTime() : 0;
      if (t >= targetTime) {
        targetTime = t;
        targetIdx = idx;
      }
    });
    if (targetIdx === -1) return null;

    const entry = payment.voidedEntries[targetIdx];
    entry.restored = true;
    entry.restoredAt = new Date();
    entry.restoredBy = adminId ? new Types.ObjectId(adminId) : null;

    (payment.payments as any)[month] = entry.amount;
    recalcTotals(payment);

    const saved = await payment.save();
    return { payment: saved, restoredAmount: entry.amount };
  }

  static async upsert(plotId: string, year: number, data: Partial<IPayment>) {
    const existing = await Payment.findOne({ plot: plotId, year });
    const defaultRate = getMcRateForYear(year);

    if (existing) {
      if (data.payments) {
        const backed = await ledgerBackedMonthsFor(plotId, year);
        const refused: string[] = [];
        for (const month of MONTHS) {
          const incoming = (data.payments as any)[month];
          if (incoming === undefined) continue;
          const before = Number((existing.payments as any)[month]) || 0;
          const after = Number(incoming) || 0;
          if (after < before && backed.has(month)) {
            refused.push(month);
            continue;
          }
          (existing.payments as any)[month] = incoming;
        }
        if (refused.length) throw new LedgerBackedError(refused, year);
      }
      if (data.mcRate !== undefined) existing.mcRate = data.mcRate;
      if (data.note !== undefined) existing.note = data.note;

      let total = 0;
      for (const month of MONTHS) {
        const val = (existing.payments as any)[month];
        if (val !== null && val !== undefined && !isNaN(val)) {
          total += val;
        }
      }
      existing.totalReceived = total;
      existing.totalDue = existing.mcRate * 12;
      existing.remaining = existing.totalDue - existing.totalReceived;

      return existing.save();
    }

    const payment = new Payment({
      plot: plotId,
      year,
      mcRate: data.mcRate || defaultRate,
      payments: data.payments || {},
      note: data.note || '',
    });

    return payment.save();
  }

  /**
   * Set one month's amount for many plots in a single year.
   *
   * Alongside the saved records it reports the *increase* per plot
   * (`deltas`) — the grid overwrites bucket values, so the difference against
   * what was there before is the only honest measure of "money newly recorded".
   * The caller uses it to write cash-book entries when the admin is entering
   * money received today rather than backfilling history.
   */
  static async bulkUpdate(entries: Array<{ plotId: string; amount: number }>, year: number, month: string) {
    const results = [];
    const deltas: Array<{ plotId: string; allocations: Array<{ year: number; month: string; amount: number }> }> = [];
    const blocked: BlockedMonth[] = [];
    const defaultRate = getMcRateForYear(year);
    const ledgerBacked = await loadLedgerBackedMonths(entries.map((e) => e.plotId));

    for (const entry of entries) {
      let payment = await Payment.findOne({ plot: entry.plotId, year });

      if (!payment) {
        payment = new Payment({
          plot: entry.plotId,
          year,
          mcRate: defaultRate,
          payments: {},
        });
      }

      const before = Number((payment.payments as any)[month]) || 0;
      const next = Number(entry.amount) || 0;
      const increase = next - before;

      // A reduction to a month the cash book has paid for is refused here. Doing
      // it would strand the income and the receipt; voiding the payment in
      // Accounts undoes all three together.
      if (increase < 0 && ledgerBacked.has(`${entry.plotId}:${year}:${month}`)) {
        blocked.push({ plotId: entry.plotId, year, month, keptAmount: before, attemptedAmount: next });
        continue;
      }

      if (increase > 0) {
        deltas.push({ plotId: entry.plotId, allocations: [{ year, month, amount: increase }] });
      }

      (payment.payments as any)[month] = entry.amount;

      let total = 0;
      for (const m of MONTHS) {
        const val = (payment.payments as any)[m];
        if (val !== null && val !== undefined && !isNaN(val)) {
          total += val;
        }
      }
      payment.totalReceived = total;
      payment.totalDue = payment.mcRate * 12;
      payment.remaining = payment.totalDue - payment.totalReceived;

      const saved = await payment.save();
      results.push(saved);
    }

    return { results, deltas, blocked };
  }

  /**
   * Bulk-upsert the full month map for many plots in a single year. Each entry
   * carries a partial `payments` object; only the months present are written
   * (an explicit null clears a month). Used by the "All months" grid editor.
   *
   * Returns the per-plot increases as well (see {@link bulkUpdate}) so the
   * caller can turn them into cash-book entries when the admin is recording
   * money received rather than backfilling old records.
   */
  static async bulkUpsertMonths(
    entries: Array<{ plotId: string; payments: Record<string, number | null> }>,
    year: number,
  ) {
    const results = [];
    const deltas: Array<{ plotId: string; allocations: Array<{ year: number; month: string; amount: number }> }> = [];
    const blocked: BlockedMonth[] = [];
    const defaultRate = getMcRateForYear(year);
    const ledgerBacked = await loadLedgerBackedMonths(entries.map((e) => e.plotId));

    for (const entry of entries) {
      let payment = await Payment.findOne({ plot: entry.plotId, year });
      if (!payment) {
        payment = new Payment({
          plot: entry.plotId,
          year,
          mcRate: defaultRate,
          payments: {},
        });
      }

      const increases: Array<{ year: number; month: string; amount: number }> = [];
      for (const m of MONTHS) {
        const v = (entry.payments || {})[m];
        if (v === undefined) continue;
        const before = Number((payment.payments as any)[m]) || 0;
        const next = v === null || (v as any) === '' ? null : Number(v) || 0;
        const increase = (next || 0) - before;

        // See bulkUpdate: the grid may not take money off a month the cash book
        // has already banked.
        if (increase < 0 && ledgerBacked.has(`${entry.plotId}:${year}:${m}`)) {
          blocked.push({ plotId: entry.plotId, year, month: m, keptAmount: before, attemptedAmount: next || 0 });
          continue;
        }

        if (increase > 0) increases.push({ year, month: m, amount: increase });
        (payment.payments as any)[m] = next;
      }
      if (increases.length) deltas.push({ plotId: entry.plotId, allocations: increases });

      recalcTotals(payment);
      results.push(await payment.save());
    }

    return { results, deltas, blocked };
  }

  static async getPaymentsByBlock(block: string, year: number) {
    const plots = await Plot.find({ block: block.toUpperCase(), isActive: true }).lean();
    const plotIds = plots.map(p => p._id);

    const payments = await Payment.find({
      plot: { $in: plotIds },
      year,
    }).populate('plot').lean();

    return payments;
  }

  static async getPaymentsByPhase(phase: string, year: number) {
    const { PHASE_BLOCK_MAP } = await import('../config/constants');
    const blocks = PHASE_BLOCK_MAP[phase] || [];
    const plots = await Plot.find({ block: { $in: blocks }, isActive: true }).lean();
    const plotIds = plots.map(p => p._id);

    const payments = await Payment.find({
      plot: { $in: plotIds },
      year,
    }).populate('plot').lean();

    return payments;
  }
}
