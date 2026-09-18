import mongoose, { Schema, Document, Types } from "mongoose";
import { nextSequence } from "./Counter";

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
  /**
   * Every month this payment settled, oldest first — what the owner is actually
   * holding a receipt for. `month`/`year` above name only the first of them, so
   * a slip covering four months could not otherwise say so.
   */
  coveredMonths: { year: number; month: string }[];

  // Meta
  societyName: string;          // Default: "KKB Housing Society"
  isVerified: boolean;          // Admin-generated receipts default to true
  // Cash-book linkage. Set when the receipt was produced by the "record
  // payment" flow, which also writes a Collection ledger entry and clears the
  // plot's dues months. Older standalone receipts leave this null.
  collectionRef?: Types.ObjectId | null;
  // Set when the underlying collection is voided. The receipt is kept (its
  // number was already handed to the owner) but is no longer valid.
  isVoided: boolean;
  voidReason: string;
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
    coveredMonths: {
      type: [
        new Schema<{ year: number; month: string }>(
          {
            year: { type: Number, required: true },
            month: { type: String, required: true, lowercase: true, trim: true },
          },
          { _id: false, timestamps: false },
        ),
      ],
      default: [],
    },

    societyName: { type: String, default: "KKB Housing Society", trim: true },
    isVerified: { type: Boolean, default: true },
    collectionRef: { type: Schema.Types.ObjectId, ref: "Collection", default: null },
    isVoided: { type: Boolean, default: false },
    voidReason: { type: String, default: "", trim: true },
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
// A plot's own receipt history — opened every time an admin views a plot, and
// the one query that would otherwise scan the whole archive as it grows.
ReceiptSchema.index({ plotRef: 1, createdAt: -1 });
// The retention job's scan: old receipts that still hold a cached PDF.
ReceiptSchema.index({ createdAt: 1, filePath: 1 });

/**
 * Allocate the receipt number before validation, for brand-new documents that
 * don't already carry one.
 *
 * The number comes from an atomic counter (`receipt-<year>` in the `counters`
 * collection), NOT from reading the current maximum. Reading the maximum loses
 * receipts under concurrency: two payments recorded in the same moment read the
 * same maximum, and the loser fails on the unique index — which in the
 * record-payment flow meant money recorded with no receipt at all. See the
 * docblock on `nextSequence` for why `$inc` is the only correct answer here.
 *
 * The counter is seeded from the existing maximum the first time a year is
 * used, so an existing series continues instead of restarting at 1.
 *
 * A number is consumed even if the save then fails for some other reason, so
 * the series can contain gaps. That is the right trade: a gap is a question an
 * admin can answer ("nothing was issued as 0042"), whereas a duplicate receipt
 * number is a dispute with an owner.
 */
ReceiptSchema.pre("validate", async function (next) {
  try {
    if (this.receiptNumber && this.receiptNumericId) return next();

    const year = this.year || new Date().getFullYear();
    const ReceiptModel = this.constructor as mongoose.Model<IReceipt>;

    const nextId = await nextSequence(`receipt-${year}`, async () => {
      const last = await ReceiptModel.findOne({ year })
        .sort({ receiptNumericId: -1 })
        .select("receiptNumericId")
        .lean();
      return last?.receiptNumericId ?? 0;
    });

    this.receiptNumericId = nextId;
    this.receiptNumber = formatReceiptNumber(year, nextId);
    next();
  } catch (err) {
    next(err as Error);
  }
});

/**
 * `KKB-2026-0001`. Four digits covers this society comfortably (278 plots can
 * produce at most ~3,300 receipts a year); past 9,999 the number simply grows a
 * digit rather than wrapping, so the sequence stays correct either way.
 */
export function formatReceiptNumber(year: number, numericId: number): string {
  return `KKB-${year}-${String(numericId).padStart(4, "0")}`;
}

export default mongoose.model<IReceipt>("Receipt", ReceiptSchema);
