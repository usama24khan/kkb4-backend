/**
 * fingerprint.ts
 * ================================
 * Derive a stable device fingerprint + human-readable device info from an
 * incoming request. The fingerprint is a SHA-256 hash of (User-Agent + IP);
 * the device info (browser / OS / name) is parsed from the User-Agent with
 * ua-parser-js for display in the OTP email and the trusted-devices list.
 */

import crypto from "crypto";
import type { Request } from "express";
import { UAParser } from "ua-parser-js";

export interface DeviceInfo {
  deviceName: string;
  browser: string;
  os: string;
  ip: string;
  userAgent: string;
}

export interface FingerprintResult {
  fingerprint: string;
  deviceInfo: DeviceInfo;
}

/**
 * Resolve the client IP, honouring proxy headers (Vercel / load balancers put
 * the real client IP in X-Forwarded-For; the first entry is the client).
 */
export function getClientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length) {
    return xff[0].split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "";
}

function joinParts(...parts: Array<string | undefined>): string {
  return parts.filter((p) => p && p.trim()).join(" ").trim();
}

/**
 * Compute the fingerprint and parsed device info for a request.
 *
 * Note: the fingerprint includes the IP, so the same browser on a different
 * network produces a new fingerprint and re-triggers OTP — this is intentional
 * ("new/unknown devices always require OTP").
 */
export function generateFingerprint(req: Request): FingerprintResult {
  const userAgent = (req.headers["user-agent"] as string) || "";
  const ip = getClientIp(req);

  const parsed = new UAParser(userAgent).getResult();

  const browser = joinParts(parsed.browser.name, parsed.browser.version) || "Unknown browser";
  const os = joinParts(parsed.os.name, parsed.os.version) || "Unknown OS";
  // Prefer a real device label (e.g. "Apple iPhone"); fall back to the OS name
  // for desktops where ua-parser-js leaves device fields empty.
  const deviceName =
    joinParts(parsed.device.vendor, parsed.device.model) ||
    parsed.os.name ||
    "Unknown device";

  const fingerprint = crypto
    .createHash("sha256")
    .update(`${userAgent}|${ip}`)
    .digest("hex");

  return {
    fingerprint,
    deviceInfo: { deviceName, browser, os, ip, userAgent },
  };
}

export default generateFingerprint;
