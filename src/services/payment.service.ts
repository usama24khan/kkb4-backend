import Payment, { IPayment } from '../models/Payment';
import Plot from '../models/Plot';
import { MONTHS } from '../config/constants';

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

  static async upsert(plotId: string, year: number, data: Partial<IPayment>) {
    const existing = await Payment.findOne({ plot: plotId, year });

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
      mcRate: data.mcRate || 200,
      payments: data.payments || {},
      note: data.note || '',
    });

    return payment.save();
  }

  static async bulkUpdate(entries: Array<{ plotId: string; amount: number }>, year: number, month: string) {
    const results = [];

    for (const entry of entries) {
      let payment = await Payment.findOne({ plot: entry.plotId, year });
      
      if (!payment) {
        payment = new Payment({
          plot: entry.plotId,
          year,
          mcRate: 200,
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

  static async getPaymentsByPhase(phase: number, year: number) {
    const plots = await Plot.find({ phase, isActive: true }).lean();
    const plotIds = plots.map(p => p._id);

    const payments = await Payment.find({
      plot: { $in: plotIds },
      year,
    }).populate('plot').lean();

    return payments;
  }
}
