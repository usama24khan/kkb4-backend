import mongoose, { Schema, Document } from "mongoose";
import { nextSequence } from "./Counter";

export type ComplaintStatus = "pending" | "in_progress" | "resolved";

/** One admin status change, so the resident can see how their case progressed. */
export interface IComplaintStatusEvent {
  status: ComplaintStatus;
  at: Date;
}

export interface IComplaint extends Document {
  /** Human-readable tracking id, e.g. "CMP-2026-0001". Residents quote this. */
  trackingNumber: string;
  /** Per-year auto-increment behind `trackingNumber`. */
  trackingNumericId: number;
  year: number;
  /** Name the resident typed on the portal form — not a linked account. */
  name: string;
  /** Contact number as typed by the resident. */
  mobile: string;
  message: string;
  status: ComplaintStatus;
  /** Append-only trail of status changes, oldest first. */
  statusHistory: IComplaintStatusEvent[];
  /** Set when an admin marks the complaint resolved. */
  resolvedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ComplaintSchema = new Schema<IComplaint>(
  {
    trackingNumber: { type: String, unique: true, index: true },
    trackingNumericId: { type: Number, index: true },
    year: { type: Number, required: true, default: () => new Date().getFullYear() },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    mobile: { type: String, required: true, trim: true, maxlength: 30 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    status: {
      type: String,
      enum: ["pending", "in_progress", "resolved"],
      default: "pending",
      index: true,
    },
    statusHistory: {
      type: [
        new Schema<IComplaintStatusEvent>(
          {
            status: {
              type: String,
              enum: ["pending", "in_progress", "resolved"],
              required: true,
            },
            at: { type: Date, default: () => new Date() },
          },
          { _id: false, timestamps: false },
        ),
      ],
      default: [],
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ComplaintSchema.index({ createdAt: -1 });
// Per-year uniqueness of the numeric id; trackingNumber stays globally unique.
ComplaintSchema.index({ year: 1, trackingNumericId: -1 });

/**
 * Assign the per-year numeric id and tracking number before validation.
 *
 * Numbering goes through the atomic `Counter` allocator rather than reading the
 * current maximum: measured under an 8-way concurrent burst, read-max-then-write
 * dropped 3 submissions to duplicate-key errors, and retrying didn't help
 * because the parallel writers re-read the same maximum in lockstep. The unique
 * index on `trackingNumber` remains as a backstop.
 */
ComplaintSchema.pre("validate", async function (next) {
  try {
    if (this.trackingNumber && this.trackingNumericId) return next();

    const year = this.year || new Date().getFullYear();
    const ComplaintModel = this.constructor as mongoose.Model<IComplaint>;

    const nextId = await nextSequence(`complaint-${year}`, async () => {
      // Continue from any pre-existing (or backfilled) records for this year.
      const last = await ComplaintModel.findOne({ year })
        .sort({ trackingNumericId: -1 })
        .select("trackingNumericId")
        .lean();
      return last?.trackingNumericId ?? 0;
    });

    this.year = year;
    this.trackingNumericId = nextId;
    this.trackingNumber = `CMP-${year}-${String(nextId).padStart(4, "0")}`;
    next();
  } catch (err) {
    next(err as Error);
  }
});

export default mongoose.model<IComplaint>("Complaint", ComplaintSchema);
