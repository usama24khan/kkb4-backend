import mongoose, { Schema, Document, Types } from 'mongoose';
import { toBookPeriod, periodOrdinal, monthNumber } from '../utils/financePeriod';

/**
 * Collection
 * ==========
 * One cash-in event: money that physically reached the society on a given day.
 *
 * Why this exists alongside `Payment`
 * -----------------------------------
 * `Payment` answers "which months of dues are cleared for this plot" — its month
 * buckets are *what the money is for*. It cannot answer "how much did we take in
 * during March 2026", because a bucket filled today for Jan 2015 looks identical
 * to one filled in 2015. This model records *when the cash arrived*
 * (`receivedDate` → `bookYear`/`bookMonth`) and, separately, which dues buckets
 * it cleared (`allocations`). That split is what makes advance payments and
 * years-late arrears both land in the month the money was actually handed over.
 *
 * Historical backfill
 * -------------------
 * Loading 2012-onwards records that were collected *and already spent* years ago
 * must not inflate today's income. Those rows are written with
 * `entryType: 'historical'` and `countInCashBook: false`: they still fill the
 * dues buckets (so owner balances are right) but the cash book ignores them
 * entirely. The real carried-over cash from that era is represented once, as
 * `FinanceSettings.openingBalance`.
 *
 * Voiding
 * -------
 * Rows are never deleted. `isVoided` excludes an entry from every total, and the
 * void routine also subtracts the allocations back out of `Payment`, so a
 * mistaken entry can be reversed without losing the audit trail.
 */

export type CollectionMethod = 'cash' | 'bank' | 'online' | 'cheque' | 'other';
export type CollectionEntryType = 'live' | 'historical';

export const COLLECTION_METHODS: CollectionMethod[] = ['cash', 'bank', 'online', 'cheque', 'other'];

/** One month of dues cleared by this payment. */
export interface IAllocation {
  /** Dues year, e.g. 2024. */
  year: number;
  /** Dues month as a `'jan'`…`'dec'` key (matches `Payment.payments`). */
  month: string;
  amount: number;
}

export interface ICollection extends Document {
  plot: Types.ObjectId;
  amount: number;
  method: CollectionMethod;

  /** When the cash actually arrived. Drives the book period. */
  receivedDate: Date;
  bookYear: number;
  /** 1 = January … 12 = December. */
  bookMonth: number;
  /** `bookYear * 12 + bookMonth`, for cheap range queries. */
  bookOrdinal: number;

  allocations: IAllocation[];
  /** Part of `amount` covering months before the book period (late dues). */
  arrearsAmount: number;
  /** Part covering the book period's own month. */
  currentAmount: number;
  /** Part covering months after the book period (paid ahead). */
  advanceAmount: number;
  /** Part not tied to any month (donation, fine, unallocated remainder). */
  unallocatedAmount: number;

  entryType: CollectionEntryType;
  /** false → archival row; updates dues but never counts as income. */
  countInCashBook: boolean;

  receiptRef?: Types.ObjectId | null;
  note: string;
  recordedBy?: Types.ObjectId | null;

  isVoided: boolean;
  voidedAt?: Date | null;
  voidedBy?: Types.ObjectId | null;
  voidReason: string;

  createdAt: Date;
  updatedAt: Date;
}

const AllocationSchema = new Schema<IAllocation>(
  {
    year: { type: Number, required: true },
    month: { type: String, required: true, lowercase: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const CollectionSchema = new Schema<ICollection>(
  {
    plot: { type: Schema.Types.ObjectId, ref: 'Plot', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: COLLECTION_METHODS, default: 'cash' },

    receivedDate: { type: Date, required: true, default: () => new Date() },
    bookYear: { type: Number, required: true },
    bookMonth: { type: Number, required: true, min: 1, max: 12 },
    bookOrdinal: { type: Number, required: true },

    allocations: { type: [AllocationSchema], default: [] },
    arrearsAmount: { type: Number, default: 0 },
    currentAmount: { type: Number, default: 0 },
    advanceAmount: { type: Number, default: 0 },
    unallocatedAmount: { type: Number, default: 0 },

    entryType: { type: String, enum: ['live', 'historical'], default: 'live' },
    countInCashBook: { type: Boolean, default: true },

    receiptRef: { type: Schema.Types.ObjectId, ref: 'Receipt', default: null },
    note: { type: String, default: '', trim: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },

    isVoided: { type: Boolean, default: false },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    voidReason: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

/**
 * Derive the book period from `receivedDate` and pre-compute the
 * arrears / current / advance split so month reports never have to re-walk
 * every allocation array.
 */
CollectionSchema.pre('validate', function (next) {
  const period = toBookPeriod(this.receivedDate || new Date());
  this.bookYear = period.bookYear;
  this.bookMonth = period.bookMonth;
  this.bookOrdinal = periodOrdinal(period.bookYear, period.bookMonth);

  const bookOrd = this.bookOrdinal;
  let arrears = 0;
  let current = 0;
  let advance = 0;
  let allocated = 0;

  for (const alloc of this.allocations || []) {
    const amount = Number(alloc.amount) || 0;
    allocated += amount;
    const num = monthNumber(alloc.month);
    if (!num) continue;
    const ord = periodOrdinal(alloc.year, num);
    if (ord < bookOrd) arrears += amount;
    else if (ord === bookOrd) current += amount;
    else advance += amount;
  }

  this.arrearsAmount = arrears;
  this.currentAmount = current;
  this.advanceAmount = advance;
  this.unallocatedAmount = Math.max(0, (Number(this.amount) || 0) - allocated);

  next();
});

// Month/year reports: "all live income in this book period".
CollectionSchema.index({ bookOrdinal: 1, countInCashBook: 1, isVoided: 1 });
CollectionSchema.index({ bookYear: 1, bookMonth: 1 });
// Plot ledger ("show this owner's payment history, newest first").
CollectionSchema.index({ plot: 1, receivedDate: -1 });
CollectionSchema.index({ receivedDate: -1 });

export default mongoose.model<ICollection>('Collection', CollectionSchema);
