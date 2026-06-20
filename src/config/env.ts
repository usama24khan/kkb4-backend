import dotenv from "dotenv";
import path from "path";

// On Vercel, env vars are injected directly — no .env files exist on the
// filesystem. Only load from .env files when running locally.
if (!process.env.VERCEL) {
  const nodeEnv = process.env.NODE_ENV || "development";
  dotenv.config({
    path: path.resolve(process.cwd(), `.env.${nodeEnv}`),
  });
}

export const env = {
  PORT: parseInt(process.env.PORT || "5000", 10),
  MONGODB_URI:
    process.env.MONGODB_URI || "mongodb://localhost:27017/kkb4_maintenance",
  JWT_SECRET: process.env.JWT_SECRET || "default-secret",
  JWT_REFRESH_SECRET:
    process.env.JWT_REFRESH_SECRET || "default-refresh-secret",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "15m",
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || "admin@kkb4.com",
  ADMIN_DEFAULT_PASSWORD: process.env.ADMIN_DEFAULT_PASSWORD || "Admin@1234",
  NODE_ENV: process.env.NODE_ENV || "development",
  CORS_ORIGINS: (
    process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:3001"
  ).split(","),

  // ── Cloudinary (media/object storage) ─────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
  // Optional top-level folder PDFs are stored under (e.g. "kkb4").
  CLOUDINARY_FOLDER: process.env.CLOUDINARY_FOLDER || "",

  // ── OTP email (Gmail via nodemailer) ──────────────────────────────────────
  // Gmail account the OTP is sent FROM + a 16-char Gmail App Password.
  EMAIL_FROM: process.env.EMAIL_FROM || "",
  EMAIL_APP_PASSWORD: process.env.EMAIL_APP_PASSWORD || "",
  // Inbox OTP codes are delivered TO. Defaults to ADMIN_EMAIL if unset, but
  // ADMIN_EMAIL doubles as the admin login identity (which may not be a real
  // mailbox), so set OTP_EMAIL explicitly to a deliverable address.
  OTP_EMAIL: process.env.OTP_EMAIL || process.env.ADMIN_EMAIL || "admin@kkb4.com",
};
