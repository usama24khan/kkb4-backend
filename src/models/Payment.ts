import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IPaymentMonths {
  jan: number | null;
  feb: number | null;
  mar: number | null;
  apr: number | null;
  may: number | null;
  jun: number | null;
  jul: number | null;
  aug: number | null;
  sep: number | null;
  oct: number | null;
  nov: number | null;
  dec: number | null;
}

export interface IPayment extends Document {
  plot: Types.ObjectId;
  year: number;
  mcRate: number;
  payments: IPaymentMonths;
  totalReceived: number;
  totalDue: number;
  remaining: number;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentSchema = new Schema<IPayment>(
  {
    plot: { type: Schema.Types.ObjectId, ref: 'Plot', required: true },
    year: { type: Number, required: true },
    mcRate: { type: Number, required: true, default: 200 },
    payments: {
      jan: { type: Number, default: null },
      feb: { type: Number, default: null },
      mar: { type: Number, default: null },
      apr: { type: Number, default: null },
      may: { type: Number, default: null },
      jun: { type: Number, default: null },
      jul: { type: Number, default: null },
      aug: { type: Number, default: null },
      sep: { type: Number, default: null },
      oct: { type: Number, default: null },
      nov: { type: Number, default: null },
      dec: { type: Number, default: null },
    },
    totalReceived: { type: Number, default: 0 },
    totalDue: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
    note: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

// Calculate totals before saving
PaymentSchema.pre('save', function (next) {
  const payments = this.payments;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
  
  let total = 0;
  for (const month of months) {
    const val = payments[month];
    if (val !== null && val !== undefined && !isNaN(val)) {
      total += val;
    }
  }
  
  this.totalReceived = total;
  this.totalDue = this.mcRate * 12;
  this.remaining = this.totalDue - this.totalReceived;
  
  next();
});

// Compound unique index
PaymentSchema.index({ plot: 1, year: 1 }, { unique: true });
PaymentSchema.index({ year: 1 });

export default mongoose.model<IPayment>('Payment', PaymentSchema);
