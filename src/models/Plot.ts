import mongoose, { Schema, Document } from 'mongoose';
import { BLOCK_PHASE_MAP, ALLOTMENT_STATUSES } from '../config/constants';

export interface IPlot extends Document {
  srNo: number;
  ownerName: string;
  plotNumber: string;
  block: string;
  phase: string;
  plotBlock: string;
  plotCode: string;
  allotmentStatus: 'Active' | 'Cancelled' | 'Unsold' | 'Unknown';
  isActive: boolean;
  ownerPhone?: string;
  ownerCnic?: string;
  monthlyChargeOverride?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const PlotSchema = new Schema<IPlot>(
  {
    srNo: { type: Number },
    ownerName: { type: String, required: true, trim: true },
    plotNumber: { type: String, required: true, trim: true },
    block: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    phase: { type: String, default: '' },
    plotBlock: { type: String, index: true, trim: true },
    plotCode: { type: String, index: true, trim: true },
    allotmentStatus: {
      type: String,
      enum: ALLOTMENT_STATUSES,
      default: 'Active',
    },
    isActive: { type: Boolean, default: true },
    ownerPhone: { type: String, trim: true, default: '' },
    ownerCnic: { type: String, trim: true, default: '' },
    monthlyChargeOverride: { type: Number, default: null },
  },
  {
    timestamps: true,
  }
);

// Derive phase, plotBlock, and plotCode before saving.
// For the built-in constant blocks the phase is authoritative and always
// re-derived from BLOCK_PHASE_MAP. For DB-backed (custom) blocks the constant
// map has no entry, so we keep whatever `phase` the service resolved via the
// block registry instead of clobbering it with ''.
PlotSchema.pre('save', function (next) {
  if (this.block) {
    const mapped = BLOCK_PHASE_MAP[this.block.toUpperCase()];
    if (mapped) this.phase = mapped;
  }
  this.plotBlock = `${this.plotNumber} ${this.block}`.trim();
  this.plotCode = `${this.plotNumber}-${this.block}`.trim();
  next();
});

PlotSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate() as any;
  if (update?.block) {
    const mapped = BLOCK_PHASE_MAP[update.block.toUpperCase()];
    if (mapped) update.phase = mapped;
  }
  if (update?.plotNumber || update?.block) {
    const plotNum = update.plotNumber || '';
    const block = update.block || '';
    update.plotBlock = `${plotNum} ${block}`.trim();
    update.plotCode = `${plotNum}-${block}`.trim();
  }
  next();
});

// Index for efficient queries
PlotSchema.index({ block: 1, plotNumber: 1 }, { unique: true });
PlotSchema.index({ phase: 1 });
PlotSchema.index({ ownerName: 'text' });

export default mongoose.model<IPlot>('Plot', PlotSchema);
