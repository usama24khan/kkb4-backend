import mongoose, { Schema, Document } from 'mongoose';
import { BLOCK_PHASE_MAP, ALLOTMENT_STATUSES } from '../config/constants';

export interface IPlot extends Document {
  srNo: number;
  ownerName: string;
  plotNumber: string;
  block: string;
  phase: number;
  plotBlock: string;
  allotmentStatus: 'Active' | 'Cancelled' | 'Unsold' | 'Unknown';
  isActive: boolean;
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
    phase: { type: Number },
    plotBlock: { type: String, index: true, trim: true },
    allotmentStatus: {
      type: String,
      enum: ALLOTMENT_STATUSES,
      default: 'Active',
    },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

// Derive phase and plotBlock before saving
PlotSchema.pre('save', function (next) {
  if (this.block) {
    this.phase = BLOCK_PHASE_MAP[this.block.toUpperCase()] || 0;
  }
  this.plotBlock = `${this.plotNumber} ${this.block}`.trim();
  next();
});

PlotSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate() as any;
  if (update?.block) {
    update.phase = BLOCK_PHASE_MAP[update.block.toUpperCase()] || 0;
  }
  if (update?.plotNumber || update?.block) {
    const plotNum = update.plotNumber || '';
    const block = update.block || '';
    update.plotBlock = `${plotNum} ${block}`.trim();
  }
  next();
});

// Index for efficient queries
PlotSchema.index({ block: 1, plotNumber: 1 }, { unique: true });
PlotSchema.index({ phase: 1 });
PlotSchema.index({ ownerName: 'text' });

export default mongoose.model<IPlot>('Plot', PlotSchema);
