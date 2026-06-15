/**
 * mailer.ts
 * ================================
 * Gmail-backed mailer (via nodemailer) used to deliver admin-login OTP codes.
 *
 * Setup: enable 2-Step Verification on the Gmail account, create an App
 * Password (Google Account → Security → App passwords) and set:
 *   EMAIL_FROM            the Gmail address
 *   EMAIL_APP_PASSWORD    the 16-char app password
 * OTPs are sent TO env.OTP_EMAIL (falls back to ADMIN_EMAIL).
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env";
import type { DeviceInfo } from "./fingerprint";

let transporter: Transporter | null = null;

/** True when the Gmail credentials needed to send mail are present. */
export function isMailerConfigured(): boolean {
  return Boolean(env.EMAIL_FROM && env.EMAIL_APP_PASSWORD);
}

function getTransporter(): Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: env.EMAIL_FROM,
      pass: env.EMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildOtpHtml(otp: string, deviceInfo: DeviceInfo, when: string): string {
  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:6px 0;color:#64748b;font-size:13px;width:120px;">${label}</td>
      <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${escapeHtml(value)}</td>
    </tr>`;

  return `
  <div style="background:#f1f5f9;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
      <div style="background:linear-gradient(135deg,#10B981,#059669);padding:24px 28px;">
        <div style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-0.3px;">KKB4 Admin Panel</div>
        <div style="color:rgba(255,255,255,0.85);font-size:12.5px;margin-top:2px;">New device sign-in verification</div>
      </div>
      <div style="padding:28px;">
        <p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.5;">
          A sign-in was attempted from a device we don't recognise. Enter the code below to verify it's you. This code expires in 10 minutes.
        </p>
        <div style="text-align:center;margin:24px 0;">
          <div style="display:inline-block;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:16px 28px;">
            <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#047857;font-family:'SFMono-Regular',Consolas,monospace;">${escapeHtml(otp)}</div>
          </div>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-top:8px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:6px;">Device details</div>
          <table style="width:100%;border-collapse:collapse;">
            ${row("Device", deviceInfo.deviceName)}
            ${row("Browser", deviceInfo.browser)}
            ${row("OS", deviceInfo.os)}
            ${row("IP address", deviceInfo.ip || "—")}
            ${row("Time", when)}
          </table>
        </div>
        <p style="margin:20px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">
          If this wasn't you, do not share this code and consider changing your password.
        </p>
      </div>
    </div>
  </div>`;
}

/**
 * Send the OTP code to env.ADMIN_EMAIL with device context. Throws if the
 * mailer isn't configured so the caller can surface a clear error.
 */
export async function sendOTPEmail(otp: string, deviceInfo: DeviceInfo): Promise<void> {
  if (!isMailerConfigured()) {
    throw new Error(
      "Email is not configured. Set EMAIL_FROM and EMAIL_APP_PASSWORD to send OTP codes.",
    );
  }

  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Karachi", hour12: true });

  await getTransporter().sendMail({
    from: `"KKB4 Admin" <${env.EMAIL_FROM}>`,
    to: env.OTP_EMAIL,
    subject: `KKB4 login code: ${otp}`,
    text:
      `Your KKB4 admin verification code is ${otp} (expires in 10 minutes).\n\n` +
      `Device: ${deviceInfo.deviceName}\nBrowser: ${deviceInfo.browser}\n` +
      `OS: ${deviceInfo.os}\nIP: ${deviceInfo.ip}\nTime: ${when}`,
    html: buildOtpHtml(otp, deviceInfo, when),
  });
}

export default sendOTPEmail;
