import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * OTP
 * ===
 * A one-time 6-digit code issued when an admin logs in from an unrecognised
 * device. The code is emailed to ADMIN_EMAIL and must be confirmed via
 * POST /auth/verify-otp before the device is trusted.
 *
 * `expiresAt` carries a TTL index so MongoDB auto-purges expired codes; `used`
 * guards against replay within the validity window.
 */
export interface IOTP extends Document {
  adminId: Types.ObjectId;
  otp: string;          // 6-digit string, e.g. "043912"
  fingerprint: string;  // device fingerprint this OTP authorises
  expiresAt: Date;      // 10 minutes after creation
  used: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Minutes an OTP stays valid after creation. */
export const OTP_TTL_MINUTES = 10;

const OTPSchema = new Schema<IOTP>(
  {
    adminId: { type: Schema.Types.ObjectId, ref: "Admin", required: true, index: true },
    otp: { type: String, required: true },
    fingerprint: { type: String, required: true, index: true },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
    },
    used: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// TTL index: MongoDB deletes the document once `expiresAt` passes.
OTPSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Fast lookup of the active code for a device.
OTPSchema.index({ fingerprint: 1, used: 1, expiresAt: 1 });

export default mongoose.model<IOTP>("OTP", OTPSchema);
