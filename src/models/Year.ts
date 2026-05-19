import mongoose, { Schema, Document } from 'mongoose';

export interface IYear extends Document {
  year: number;
  mcRate: number;
  isActive: boolean;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

const YearSchema = new Schema<IYear>(
  {
    year: { type: Number, required: true, unique: true },
    mcRate: { type: Number, required: true },
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model<IYear>('Year', YearSchema);
