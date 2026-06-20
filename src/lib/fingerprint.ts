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
 *
 * IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) are normalized to plain IPv4
 * so that the same machine always produces the same fingerprint regardless of
 * whether the OS/Express stack uses IPv4 or IPv6 sockets.
 */
export function getClientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  let raw: string;
  if (typeof xff === "string" && xff.length) {
    raw = xff.split(",")[0].trim();
  } else if (Array.isArray(xff) && xff.length) {
    raw = xff[0].split(",")[0].trim();
  } else {
    raw = req.ip || req.socket?.remoteAddress || "";
  }
  // Normalize ::ffff:127.0.0.1 → 127.0.0.1, ::1 → 127.0.0.1
  if (raw === "::1") return "127.0.0.1";
  return raw.replace(/^::ffff:/, "");
}

function joinParts(...parts: Array<string | undefined>): string {
  return parts.filter((p) => p && p.trim()).join(" ").trim();
}

/**
 * Compute the fingerprint and parsed device info for a request.
 *
 * The fingerprint is SHA-256(browserName|osName|ip) — intentionally version-
 * stable so that a Chrome update (148 → 149) or macOS patch does not force a
 * new OTP challenge. Only switching browsers, operating systems, or networks
 * (IP addresses) produces a new fingerprint.
 *
 * Note: the fingerprint includes the normalized IP, so the same browser on a
 * different network re-triggers OTP — this is intentional.
 */
export function generateFingerprint(req: Request): FingerprintResult {
  const userAgent = (req.headers["user-agent"] as string) || "";
  const ip = getClientIp(req);

  const parsed = new UAParser(userAgent).getResult();

  const browserName = parsed.browser.name || "Unknown";
  const osName = parsed.os.name || "Unknown";

  const browser = joinParts(parsed.browser.name, parsed.browser.version) || "Unknown browser";
  const os = joinParts(parsed.os.name, parsed.os.version) || "Unknown OS";
  // Prefer a real device label (e.g. "Apple iPhone"); fall back to the OS name
  // for desktops where ua-parser-js leaves device fields empty.
  const deviceName =
    joinParts(parsed.device.vendor, parsed.device.model) ||
    parsed.os.name ||
    "Unknown device";

  // Use browser name + OS name (no versions) so the fingerprint survives
  // browser auto-updates. IP is still included so a new network = new OTP.
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${browserName}|${osName}|${ip}`)
    .digest("hex");

  return {
    fingerprint,
    deviceInfo: { deviceName, browser, os, ip, userAgent },
  };
}

export default generateFingerprint;
