import mongoose, { Schema, Document, Types } from 'mongoose';
import { toBookPeriod, periodOrdinal } from '../utils/financePeriod';

/**
 * Expense
 * =======
 * Money the society paid out — sweeper salary, petrol, sewerage repairs, and
 * one-off works funded from accumulated savings.
 *
 * `expenseDate` drives the book period exactly as `Collection.receivedDate`
 * does, so income and expenditure are always compared over the same window.
 * `categoryName` is snapshotted at write time so a renamed or deactivated
 * category never rewrites history.
 *
 * Expenses are voided, not deleted, so a month that was already reported to
 * residents can be corrected without the numbers silently changing shape.
 */

export type ExpenseMethod = 'cash' | 'bank' | 'online' | 'cheque' | 'other';

export const EXPENSE_METHODS: ExpenseMethod[] = ['cash', 'bank', 'online', 'cheque', 'other'];

export interface IExpense extends Document {
  title: string;
  category?: Types.ObjectId | null;
  /** Snapshot of the category name at creation time. */
  categoryName: string;
  amount: number;

  expenseDate: Date;
  bookYear: number;
  /** 1 = January … 12 = December. */
  bookMonth: number;
  /** `bookYear * 12 + bookMonth`, for cheap range queries. */
  bookOrdinal: number;

  paidTo: string;
  method: ExpenseMethod;
  note: string;
  /** Cloudinary URL of a bill / voucher image. Admin-visible only. */
  attachmentUrl: string;

  recordedBy?: Types.ObjectId | null;
  isVoided: boolean;
  voidedAt?: Date | null;
  voidedBy?: Types.ObjectId | null;
  voidReason: string;

  createdAt: Date;
  updatedAt: Date;
}

const ExpenseSchema = new Schema<IExpense>(
  {
    title: { type: String, required: true, trim: true },
    category: { type: Schema.Types.ObjectId, ref: 'ExpenseCategory', default: null },
    categoryName: { type: String, default: '', trim: true },
    amount: { type: Number, required: true, min: 0 },

    expenseDate: { type: Date, required: true, default: () => new Date() },
    bookYear: { type: Number, required: true },
    bookMonth: { type: Number, required: true, min: 1, max: 12 },
    bookOrdinal: { type: Number, required: true },

    paidTo: { type: String, default: '', trim: true },
    method: { type: String, enum: EXPENSE_METHODS, default: 'cash' },
    note: { type: String, default: '', trim: true },
    attachmentUrl: { type: String, default: '' },

    recordedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    isVoided: { type: Boolean, default: false },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    voidReason: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

/** Keep the book period in step with `expenseDate` on every write. */
ExpenseSchema.pre('validate', function (next) {
  const period = toBookPeriod(this.expenseDate || new Date());
  this.bookYear = period.bookYear;
  this.bookMonth = period.bookMonth;
  this.bookOrdinal = periodOrdinal(period.bookYear, period.bookMonth);
  next();
});

ExpenseSchema.index({ bookOrdinal: 1, isVoided: 1 });
ExpenseSchema.index({ bookYear: 1, bookMonth: 1 });
ExpenseSchema.index({ category: 1, bookOrdinal: 1 });
ExpenseSchema.index({ expenseDate: -1 });

export default mongoose.model<IExpense>('Expense', ExpenseSchema);
