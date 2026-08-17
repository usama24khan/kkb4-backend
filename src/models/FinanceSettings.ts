import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * FinanceSettings
 * ===============
 * Single-document configuration for the cash book, keyed by the literal
 * `'default'` so an upsert can never create a second copy.
 *
 * `openingBalance` is the one honest number for the pre-system era. Historical
 * dues records are backfilled as archival collections that deliberately do not
 * count as income (see `Collection`), because that money was collected *and
 * spent* years ago. Whatever cash genuinely carried forward into the first month
 * the system tracks is entered here once, and every running-savings figure
 * starts from it.
 *
 * `openingAsOf` marks the period the balance is stated at: month reports before
 * it are historical archive, reports from it onwards are live bookkeeping.
 */
export interface IFinanceSettings extends Document {
  key: string;
  openingBalance: number;
  openingAsOf: Date;
  note: string;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const FinanceSettingsSchema = new Schema<IFinanceSettings>(
  {
    key: { type: String, default: 'default', unique: true, immutable: true },
    openingBalance: { type: Number, default: 0 },
    openingAsOf: { type: Date, default: () => new Date() },
    note: { type: String, default: '', trim: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true }
);

export default mongoose.model<IFinanceSettings>('FinanceSettings', FinanceSettingsSchema);
