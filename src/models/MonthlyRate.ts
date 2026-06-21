import mongoose, { Schema, Document } from 'mongoose';

export interface IMonthlyRate extends Document {
  year: number;
  rate: number;
  updatedAt: Date;
}

const MonthlyRateSchema = new Schema<IMonthlyRate>(
  {
    year: { type: Number, required: true, unique: true },
    rate: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

export default mongoose.model<IMonthlyRate>('MonthlyRate', MonthlyRateSchema);
