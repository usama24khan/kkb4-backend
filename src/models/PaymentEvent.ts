import mongoose, { Schema, Document, Types } from 'mongoose';
import { MONTHS } from '../config/constants';

/**
 * KKB4 — Payment activity log (append-only)
 *
 * WHY THIS EXISTS
 * ---------------
 * `Payment` holds one document per plot per year with twelve month cells. It
 * records *how much* cleared each month but never *when* it was recorded, so
 * questions an admin actually asks — "what came in this month", "which plots
 * paid this week", "how many payments were added today" — had no answer at all.
 * The cash book (`Collection`) does carry `receivedDate`, but only for money
 * entered through the Accounts flow; months edited straight in the payments grid
 * never reach it.
 *
 * One row is appended here every time a month cell changes, whichever path made
 * the change. Nothing else reads back into it and nothing updates a row after it
 * is written: it is a log, not state. `Payment` remains the source of truth for
 * balances — this answers "when and by which route", never "how much is owed".
 *
 * NOT BACKFILLED
 * --------------
 * The 3,900-odd existing payment rows have no month-level dates and cannot get
 * one — the information was never captured. So this log starts empty and fills
 * from the day it ships. A question about activity before that returns nothing,
 * which is the truth: it was not recorded.
 *
 * Historical imports are deliberately NOT logged (see PaymentEventService), or a
 * spreadsheet backfill of a decade of records would read as thousands of
 * payments arriving the moment someone pressed Import.
 */

/** What happened to the month cell. */
export type PaymentEventType = 'payment' | 'adjustment' | 'void' | 'restore';

/**
 * Which route made the change — worth keeping distinct because they mean
 * different things to an admin: `cashbook` money went through Accounts and has a
 * receipt behind it, `grid` was typed straight into the payments table.
 */
export type PaymentEventSource = 'grid' | 'bulk' | 'record' | 'cashbook' | 'import';

export interface IPaymentEvent extends Document {
  plot: Types.ObjectId;
  /** Dues year the month belongs to — NOT when the money arrived. */
  year: number;
  /** Dues month as a 'jan'…'dec' key, matching `Payment.payments`. */
  month: string;
  /** The change itself: positive when paid, negative when reduced or voided. */
  amount: number;
  /** What the month cell holds after the change, so a row stands on its own. */
  balanceAfter: number;
  /** When it was recorded. This is the timestamp the whole log exists for. */
  paidAt: Date;
  type: PaymentEventType;
  source: PaymentEventSource;
  /** The cash-book entry behind this, when the money came through Accounts. */
  collectionRef?: Types.ObjectId | null;
  recordedBy?: Types.ObjectId | null;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentEventSchema = new Schema<IPaymentEvent>(
  {
    plot: { type: Schema.Types.ObjectId, ref: 'Plot', required: true, index: true },
    year: { type: Number, required: true },
    month: { type: String, required: true, enum: [...MONTHS] },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, default: 0 },
    paidAt: { type: Date, required: true, default: () => new Date() },
    type: {
      type: String,
      enum: ['payment', 'adjustment', 'void', 'restore'],
      default: 'payment',
    },
    source: {
      type: String,
      enum: ['grid', 'bulk', 'record', 'cashbook', 'import'],
      default: 'grid',
    },
    collectionRef: { type: Schema.Types.ObjectId, ref: 'Collection', default: null },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true },
);

// "What came in recently" is the question this log is for, so date-first.
PaymentEventSchema.index({ paidAt: -1 });
// A plot's own history, and the dues month a row belongs to.
PaymentEventSchema.index({ plot: 1, paidAt: -1 });
PaymentEventSchema.index({ year: 1, month: 1 });

export default mongoose.model<IPaymentEvent>('PaymentEvent', PaymentEventSchema);
