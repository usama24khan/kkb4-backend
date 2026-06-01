import mongoose, { Schema, Document, Types } from "mongoose";

export interface INotice extends Document {
  type: "plot" | "block" | "phase";
  targetId: string;
  /**
   * Human-readable label for `targetId`. Populated at creation time so the
   * history view doesn't have to resolve ObjectIds back to plot names later.
   *   - plot scope: "374 A" (plotBlock)
   *   - multi-plot: "374 A +4 more"
   *   - block scope: "A" (same as targetId)
   *   - phase scope: "Phase 1" (same as targetId)
   * Older notices (pre-migration) won't have this — fall back to `targetId`.
   */
  targetLabel?: string;
  year: number;
  yearFrom: number;
  yearTo: number;
  monthFrom: string;
  monthTo: string;
  language: "en" | "ur";
  paymentDeadline?: Date | null;
  minDuesThreshold: number;
  generatedBy: Types.ObjectId;
  plotCount: number;
  totalDue: number;
  pdfPath: string;
  pdfPaths: string[];
  createdAt: Date;
}

const NoticeSchema = new Schema<INotice>(
  {
    type: { type: String, enum: ["plot", "block", "phase"], required: true },
    targetId: { type: String, required: true },
    targetLabel: { type: String, default: "" },
    // `year` retained for backwards compatibility; mirrors `yearTo`.
    year: { type: Number, required: true },
    yearFrom: { type: Number, required: true },
    yearTo: { type: Number, required: true },
    monthFrom: { type: String, default: "jan" },
    monthTo: { type: String, default: "dec" },
    language: { type: String, enum: ["en", "ur"], default: "en" },
    paymentDeadline: { type: Date, default: null },
    minDuesThreshold: { type: Number, default: 0 },
    generatedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    plotCount: { type: Number, default: 1 },
    totalDue: { type: Number, default: 0 },
    pdfPath: { type: String, default: "" },
    pdfPaths: { type: [String], default: [] },
  },
  {
    timestamps: true,
  },
);

NoticeSchema.index({ createdAt: -1 });

export default mongoose.model<INotice>("Notice", NoticeSchema);
