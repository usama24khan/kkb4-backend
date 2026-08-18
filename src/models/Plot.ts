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

/**
 * Keep `phase`, `plotBlock` and `plotCode` in step whenever a plot's number or
 * block is edited.
 *
 * These are derived fields, and the whole app reads them: the plot lists, the
 * search, the block and phase pages, the payment grid, the AI answers. Moving a
 * plot to another block has to update all three or the plot shows under its old
 * block everywhere.
 *
 * This runs against the *merged* values — what the update carries, falling back to
 * what the document already holds — because an update naming only the block used
 * to blank the number out of both derived fields ("J", "-J"), and an update
 * wrapped in `$set` used to skip this hook altogether and leave all three stale.
 *
 * Everything else that concerns a plot refers to it by id — its payments, its
 * ledger entries, its dues — so those follow a move on their own. Receipts and
 * notices deliberately keep the block they were issued with: they are records of
 * a document already handed over.
 */
async function syncDerivedFields(this: any) {
  {
    const update = (this.getUpdate() || {}) as any;
    // Updates arrive either flat or wrapped in $set; read whichever holds the fields.
    const incoming = update.$set && typeof update.$set === 'object' ? update.$set : update;

    const changesIdentity = incoming.plotNumber !== undefined || incoming.block !== undefined;
    if (!changesIdentity) return;

    const current = await this.model
      .findOne(this.getQuery())
      .select('plotNumber block')
      .lean();

    const plotNumber = String(incoming.plotNumber ?? current?.plotNumber ?? '').trim();
    const block = String(incoming.block ?? current?.block ?? '').toUpperCase().trim();

    const derived: Record<string, string> = {
      plotBlock: `${plotNumber} ${block}`.trim(),
      plotCode: `${plotNumber}-${block}`.trim(),
    };
    if (block) {
      derived.block = block;
      const mapped = BLOCK_PHASE_MAP[block];
      // Custom blocks have no entry in the constant map; leave whatever the
      // caller resolved from the block registry rather than blanking it.
      if (mapped) derived.phase = mapped;
    }

    // Handed back through setUpdate rather than mutating what getUpdate returned:
    // for a flat update that object is a copy, so edits to it never reach the
    // query and the derived fields silently stayed one edit behind.
    if (update.$set && typeof update.$set === 'object') {
      this.setUpdate({ ...update, $set: { ...update.$set, ...derived } });
    } else {
      this.setUpdate({ ...update, ...derived });
    }
  }
}

PlotSchema.pre('findOneAndUpdate', syncDerivedFields);
PlotSchema.pre('updateOne', syncDerivedFields);

// Index for efficient queries
PlotSchema.index({ block: 1, plotNumber: 1 }, { unique: true });
PlotSchema.index({ phase: 1 });
PlotSchema.index({ ownerName: 'text' });

export default mongoose.model<IPlot>('Plot', PlotSchema);
