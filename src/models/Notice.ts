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
  /**
   * Stable, unique batch number, allocated from an atomic counter and printed on
   * the PDFs. Previously the printed number was `countDocuments() + 1`, which
   * was never stored, repeated itself whenever a row was removed, and gave two
   * simultaneous batches the same number — and since uploads overwrite by key,
   * the second batch replaced the first batch's files.
   */
  noticeNumber?: number;
  pdfPath: string;
  pdfPaths: string[];
  /**
   * When the PDFs were deleted by the retention job. Notices are working
   * paperwork: the letters are kept 180 days, then removed to keep storage flat.
   * The row itself is kept forever — it is the answer to "was this owner warned,
   * when, and for how much" — so the UI shows this date instead of offering a
   * download that would 404.
   */
  pdfsPurgedAt?: Date | null;
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
    noticeNumber: { type: Number, index: true },
    pdfPath: { type: String, default: "" },
    pdfPaths: { type: [String], default: [] },
    pdfsPurgedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  },
);

NoticeSchema.index({ createdAt: -1 });
// The history view filters by scope and target; the retention job scans by date.
NoticeSchema.index({ type: 1, targetId: 1, createdAt: -1 });
NoticeSchema.index({ pdfsPurgedAt: 1, createdAt: 1 });

export default mongoose.model<INotice>("Notice", NoticeSchema);
