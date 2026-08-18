import mongoose, { Schema, Document } from 'mongoose';

/**
 * An admin override of the monthly maintenance charge, effective from a month.
 *
 * `fromMonth` exists because the charge has already changed mid-year once — it
 * rose to PKR 400 in May 2022 — so a rate keyed by year alone would price
 * January to April of that year wrongly. A document applies from its own
 * (year, fromMonth) until the next one takes over.
 */
export interface IMonthlyRate extends Document {
  year: number;
  /** 1–12. Legacy documents predate this field and default to January. */
  fromMonth: number;
  rate: number;
  updatedAt: Date;
}

const MonthlyRateSchema = new Schema<IMonthlyRate>(
  {
    year: { type: Number, required: true },
    fromMonth: { type: Number, required: true, default: 1, min: 1, max: 12 },
    rate: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

MonthlyRateSchema.index({ year: 1, fromMonth: 1 }, { unique: true });

export default mongoose.model<IMonthlyRate>('MonthlyRate', MonthlyRateSchema);
