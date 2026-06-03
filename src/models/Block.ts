import mongoose, { Schema, Document } from 'mongoose';

/**
 * Block — a DB-backed block definition.
 *
 * The original blocks (A..L, P) live as hardcoded constants in
 * config/constants.ts and map to a phase via BLOCK_PHASE_MAP. This collection
 * lets admins register NEW blocks at runtime, each linked to a phase (which may
 * itself be a built-in constant phase or a DB-backed Phase).
 *
 * `code` is the short identifier carried on every Plot (e.g. "A", "M1").
 * Reads merge constants ∪ DB via utils/blockRegistry.
 */
export interface IBlock extends Document {
  code: string;
  phase: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const BlockSchema = new Schema<IBlock>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    phase: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model<IBlock>('Block', BlockSchema);
