import Payment, { IPayment } from '../models/Payment';
import Plot from '../models/Plot';
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
      for (const month of MONTHS) {
        if ((data.payments as any)[month] !== undefined) {
          (payment.payments as any)[month] = (data.payments as any)[month];
        }
      }
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
        for (const month of MONTHS) {
          if ((data.payments as any)[month] !== undefined) {
            (existing.payments as any)[month] = (data.payments as any)[month];
          }
        }
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

  static async bulkUpdate(entries: Array<{ plotId: string; amount: number }>, year: number, month: string) {
    const results = [];
    const defaultRate = getMcRateForYear(year);

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

    return results;
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
