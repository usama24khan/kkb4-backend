import mongoose, { Schema, Document } from 'mongoose';

/**
 * Phase — a DB-backed phase definition.
 *
 * The original phases ("Phase 1".."Phase 3", "Phase P") live as hardcoded
 * constants in config/constants.ts. This collection lets admins register
 * NEW phases at runtime. Reads merge constants ∪ DB via utils/blockRegistry.
 */
export interface IPhase extends Document {
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PhaseSchema = new Schema<IPhase>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model<IPhase>('Phase', PhaseSchema);
