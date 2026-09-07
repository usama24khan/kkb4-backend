import { Types } from 'mongoose';
import PaymentEvent, {
  type PaymentEventSource,
  type PaymentEventType,
} from '../models/PaymentEvent';

/**
 * Append-only recorder for month-cell changes. See models/PaymentEvent.ts for
 * why the log exists.
 *
 * Every write path that touches `Payment.payments.<month>` calls `record`. It is
 * deliberately fire-and-forget: a failure here must never fail the payment
 * itself, because the payment is the money and this is only the note about when
 * it was taken. A dropped row costs an admin one line of history; a rejected
 * save costs them the payment.
 */

/** One month cell moving from `from` to `to`. */
export interface MonthChange {
  month: string;
  from: number;
  to: number | null;
}

export interface RecordOptions {
  plotId: string | Types.ObjectId;
  year: number;
  changes: MonthChange[];
  source: PaymentEventSource;
  /** Defaults per change: a rise is a payment, a fall an adjustment. */
  type?: PaymentEventType;
  collectionRef?: string | Types.ObjectId | null;
  recordedBy?: string | Types.ObjectId | null;
  note?: string;
  /** When the money arrived, if that differs from now (a dated cash entry). */
  paidAt?: Date;
}

const toId = (v: string | Types.ObjectId | null | undefined) =>
  v ? new Types.ObjectId(String(v)) : null;

export class PaymentEventService {
  /**
   * Log the month changes that actually moved. Returns the number of rows
   * written, which is what the tests assert on; callers ignore it.
   */
  static async record(opts: RecordOptions): Promise<number> {
    const paidAt = opts.paidAt ?? new Date();
    const rows = opts.changes
      .map((c) => {
        const to = Number(c.to) || 0;
        const from = Number(c.from) || 0;
        const amount = to - from;
        if (amount === 0) return null;
        return {
          plot: toId(opts.plotId),
          year: opts.year,
          month: String(c.month).toLowerCase(),
          amount,
          balanceAfter: to,
          paidAt,
          // A rise is money in; a fall is someone correcting a figure. The
          // caller overrides for the two cases that are neither (void/restore).
          type: opts.type ?? (amount > 0 ? 'payment' : 'adjustment'),
          source: opts.source,
          collectionRef: toId(opts.collectionRef),
          recordedBy: toId(opts.recordedBy),
          note: opts.note || '',
        };
      })
      .filter(Boolean);

    if (!rows.length) return 0;

    try {
      await PaymentEvent.insertMany(rows, { ordered: false });
      return rows.length;
    } catch (err: any) {
      // Logged, never rethrown — see the class comment.
      console.error('⚠️  payment activity not logged:', err?.message || err);
      return 0;
    }
  }
}
