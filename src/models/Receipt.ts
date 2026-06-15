import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Receipt
 * =======
 * A payment-receipt document for KKB4 Housing Society. Each receipt is tied to
 * a real Plot (selected by the admin); the block/plot/owner are snapshotted
 * from that plot at creation time so the receipt remains accurate even if the
 * plot is later edited.
 *
 * `receiptNumber` is auto-generated as `KKB-YYYY-0001`, where the numeric part
 * auto-increments per `year`. Admin-generated receipts are verified by default.
 */
export interface IReceipt extends Document {
  receiptNumber: string;        // Auto-generated: KKB-YYYY-0001
  receiptNumericId: number;     // Auto-increment integer, per year
  year: number;                 // e.g. 2026
  month: string;                // English month name, e.g. "January"
  language: "en" | "ur";        // PDF output language

  // Plot snapshot (source of truth is plotRef; the rest is captured at creation).
  plotRef: Types.ObjectId;
  blockNo: string;
  plotNo: string;
  ownerName: string;

  // Payment
  amount: number;               // e.g. 262
  paymentDate: Date;
  dateFrom?: Date | null;       // optional period start
  dateTo?: Date | null;         // optional period end

  // Meta
  societyName: string;          // Default: "KKB Housing Society"
  isVerified: boolean;          // Admin-generated receipts default to true
  // Full Cloudinary URL of the rendered PDF. Empty until the PDF is first
  // generated (lazily, on the first /receipts/:id/pdf request) and cached.
  filePath: string;
  generatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ReceiptSchema = new Schema<IReceipt>(
  {
    receiptNumber: { type: String, unique: true, index: true },
    receiptNumericId: { type: Number, index: true },
    year: { type: Number, required: true },
    month: { type: String, default: "" },
    language: { type: String, enum: ["en", "ur"], default: "en" },

    plotRef: { type: Schema.Types.ObjectId, ref: "Plot", required: true },
    blockNo: { type: String, default: "", trim: true },
    plotNo: { type: String, default: "", trim: true },
    ownerName: { type: String, default: "", trim: true },

    amount: { type: Number, required: true, min: 0 },
    paymentDate: { type: Date, default: () => new Date() },
    dateFrom: { type: Date, default: null },
    dateTo: { type: Date, default: null },

    societyName: { type: String, default: "KKB Housing Society", trim: true },
    isVerified: { type: Boolean, default: true },
    filePath: { type: String, default: "" }, // Cloudinary PDF URL (lazy cache)
    generatedBy: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  {
    timestamps: true,
  },
);

// Per-year uniqueness of the numeric id; the global receiptNumber stays unique too.
ReceiptSchema.index({ year: 1, receiptNumericId: -1 });
ReceiptSchema.index({ createdAt: -1 });

/**
 * Auto-increment the per-year numeric id and format the human-readable
 * receipt number *before* validation. Only runs for brand-new documents that
 * don't already carry a receiptNumber.
 *
 * Note: the read-then-write is not transactional; the unique index on
 * `receiptNumber` is the backstop against a concurrent-creation race (a
 * duplicate insert throws E11000, surfaced as a retry-able 409).
 */
ReceiptSchema.pre("validate", async function (next) {
  try {
    if (this.receiptNumber && this.receiptNumericId) return next();

    const year = this.year || new Date().getFullYear();
    const ReceiptModel = this.constructor as mongoose.Model<IReceipt>;
    const last = await ReceiptModel.findOne({ year })
      .sort({ receiptNumericId: -1 })
      .select("receiptNumericId")
      .lean();

    const nextId = (last?.receiptNumericId ?? 0) + 1;
    this.receiptNumericId = nextId;
    this.receiptNumber = `KKB-${year}-${String(nextId).padStart(4, "0")}`;
    next();
  } catch (err) {
    next(err as Error);
  }
});

export default mongoose.model<IReceipt>("Receipt", ReceiptSchema);
