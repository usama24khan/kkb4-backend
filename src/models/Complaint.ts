import mongoose, { Schema, Document } from "mongoose";

export type ComplaintStatus = "pending" | "in_progress" | "resolved";

export interface IComplaint extends Document {
  /** Name the resident typed on the portal form — not a linked account. */
  name: string;
  /** Contact number as typed by the resident. */
  mobile: string;
  message: string;
  status: ComplaintStatus;
  /** Set when an admin last moved the complaint out of `pending`. */
  resolvedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ComplaintSchema = new Schema<IComplaint>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    mobile: { type: String, required: true, trim: true, maxlength: 30 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    status: {
      type: String,
      enum: ["pending", "in_progress", "resolved"],
      default: "pending",
      index: true,
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ComplaintSchema.index({ createdAt: -1 });

export default mongoose.model<IComplaint>("Complaint", ComplaintSchema);
