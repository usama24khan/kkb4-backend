import mongoose, { Schema, Document } from 'mongoose';

/**
 * ExpenseCategory
 * ===============
 * A heading the society spends money under — sweeper salary, petrol, sewerage
 * and so on. Kept as its own collection (rather than a hard-coded enum) because
 * the committee adds new headings over time.
 *
 * Categories are never hard-deleted: an expense snapshots `categoryName` at
 * write time, but historic rows still point here, so deactivation (`isActive`)
 * is what hides a heading from the "add expense" dropdown.
 */
export interface IExpenseCategory extends Document {
  name: string;
  nameUr: string;
  /** Optional soft budget — surfaced as a warning in the UI, never enforced. */
  monthlyBudget: number | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const ExpenseCategorySchema = new Schema<IExpenseCategory>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    nameUr: { type: String, default: '', trim: true },
    monthlyBudget: { type: Number, default: null, min: 0 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 100 },
  },
  { timestamps: true }
);

ExpenseCategorySchema.index({ isActive: 1, sortOrder: 1 });

export default mongoose.model<IExpenseCategory>('ExpenseCategory', ExpenseCategorySchema);
