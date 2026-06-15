import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Device
 * ======
 * A trusted device that has completed OTP verification for a given admin. Once
 * a device is registered, future logins from it skip the OTP step. The
 * fingerprint is a SHA-256 hash of (User-Agent + IP) computed in
 * lib/fingerprint.ts.
 *
 * Uniqueness is per (adminId, fingerprint): the same physical device can be
 * trusted by more than one admin without colliding.
 */
export interface IDevice extends Document {
  adminId: Types.ObjectId;
  fingerprint: string;
  deviceName: string;
  browser: string;
  os: string;
  ip: string;
  registeredAt: Date;
  lastLoginAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DeviceSchema = new Schema<IDevice>(
  {
    adminId: { type: Schema.Types.ObjectId, ref: "Admin", required: true, index: true },
    fingerprint: { type: String, required: true, index: true },
    deviceName: { type: String, default: "" },
    browser: { type: String, default: "" },
    os: { type: String, default: "" },
    ip: { type: String, default: "" },
    registeredAt: { type: Date, default: () => new Date() },
    lastLoginAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// One trusted-device record per (admin, fingerprint) pair.
DeviceSchema.index({ adminId: 1, fingerprint: 1 }, { unique: true });

export default mongoose.model<IDevice>("Device", DeviceSchema);
