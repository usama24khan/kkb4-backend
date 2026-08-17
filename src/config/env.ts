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

  // ── User portal (resident-facing app) ─────────────────────────────────────
  // One shared read-only account for the whole society: every resident signs in
  // with the same credentials, then browses the full plot registry. Rotate by
  // setting these env vars — no code change needed.
  USER_PORTAL_EMAIL: process.env.USER_PORTAL_EMAIL || "user@kkb4.com",
  USER_PORTAL_PASSWORD: process.env.USER_PORTAL_PASSWORD || "User@1234",
  NODE_ENV: process.env.NODE_ENV || "development",

  // Requests allowed per IP per 15 minutes across /api (see middleware/rateLimiter).
  // Raise it locally when a test run replays hundreds of requests from one address.
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || "600", 10),
  CORS_ORIGINS: (
    process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:3001"
  ).split(","),

  // ── Cloudinary (media/object storage) ─────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
  // Optional top-level folder PDFs are stored under (e.g. "kkb4").
  CLOUDINARY_FOLDER: process.env.CLOUDINARY_FOLDER || "",

  // ── AI database chat (admin-only, read-only) ──────────────────────────────
  // Groq powers the natural-language → query translation. Free key at
  // https://console.groq.com — leave blank to disable the feature entirely.
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16 and now
  // 404s, so the default moved to the replacement they recommend. gpt-oss-120b
  // is a *reasoning* model — see aiQuery.service for the two accommodations that
  // requires (reasoning_effort and token headroom).
  //
  // qwen3.6-27b is the other suggested replacement but is not a drop-in here: it
  // fails this app's `response_format: json_object` requests outright.
  GROQ_MODEL: process.env.GROQ_MODEL || "openai/gpt-oss-120b",

  // ── OTP email (Gmail via nodemailer) ──────────────────────────────────────
  // Gmail account the OTP is sent FROM + a 16-char Gmail App Password.
  EMAIL_FROM: process.env.EMAIL_FROM || "",
  EMAIL_APP_PASSWORD: process.env.EMAIL_APP_PASSWORD || "",
  // Inbox OTP codes are delivered TO. Defaults to ADMIN_EMAIL if unset, but
  // ADMIN_EMAIL doubles as the admin login identity (which may not be a real
  // mailbox), so set OTP_EMAIL explicitly to a deliverable address.
  OTP_EMAIL: process.env.OTP_EMAIL || process.env.ADMIN_EMAIL || "admin@kkb4.com",
};
