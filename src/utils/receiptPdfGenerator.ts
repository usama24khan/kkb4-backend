/**
 * receiptPdfGenerator.ts
 * ================================
 * Generates payment-receipt PDFs for KKB4 Housing Society.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Language  │  Renderer                                               │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  English   │  PDFKit                                                 │
 * │  Urdu      │  Python (fpdf2 + uharfbuzz + Noto Nastaliq Urdu)        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * One receipt = one slip (no duplicate copy). Urdu receipts are rendered by
 * scripts/generate_urdu_receipt.py, which reuses the same venv / HarfBuzz /
 * Noto Nastaliq setup as the notice script.
 *
 * Receipt PDFs are generated on demand (cheap, and must always reflect the
 * latest DB state) into <backend>/receipts/.
 */

import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { IReceipt } from "../models/Receipt";
import { uploadToCloudinary } from "../lib/uploadToCloudinary";

const execFileAsync = promisify(execFile);

// ─── Paths ──────────────────────────────────────────────────────────────────

/**
 * Receipt PDFs are rendered into the OS temp dir (writable on Vercel), uploaded
 * to Cloudinary, then deleted locally. The receipt controller caches the
 * returned URL on the Receipt document so subsequent requests skip re-render.
 */
const RECEIPTS_DIR = os.tmpdir();

/** Cloudinary key for a receipt PDF, e.g. receipts/2026/receipt_KKB-2026-0001_en.pdf */
function receiptKey(fileName: string, year: number): string {
  return `receipts/${year || "unknown"}/${fileName}`;
}

/**
 * Upload a temp-dir receipt PDF to Cloudinary, delete the local temp copy, and
 * return the public URL. The temp file is removed even if the upload fails.
 */
async function uploadReceiptAndCleanup(
  tmpPath: string,
  fileName: string,
  year: number,
): Promise<string> {
  try {
    return await uploadToCloudinary(tmpPath, receiptKey(fileName, year));
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

const PYTHON_SCRIPT = path.join(__dirname, "../../scripts/generate_urdu_receipt.py");

// Society signature image (shared by both renderers). Optional — if missing,
// the slip falls back to a blank signature line.
const SIGNATURE_PATH = path.join(__dirname, "../../signature/signature.png");
const SIGNATURE_RATIO = 414 / 603; // height / width of signature.png

function resolvePythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython = path.join(__dirname, "../../.venv/bin/python3");
  if (fs.existsSync(venvPython)) return venvPython;
  return "python3";
}

const PYTHON_BIN = resolvePythonBin();

// English → Urdu month names (the form stores the English month name).
const EN_TO_UR_MONTH: Record<string, string> = {
  January: "جنوری", February: "فروری", March: "مارچ", April: "اپریل",
  May: "مئی", June: "جون", July: "جولائی", August: "اگست",
  September: "ستمبر", October: "اکتوبر", November: "نومبر", December: "دسمبر",
};

// ─── Public types ──────────────────────────────────────────────────────────

export interface ReceiptResult {
  /** Public Cloudinary URL of the uploaded PDF. */
  url: string;
  fileName: string;
}

function safeFileName(receiptNumber: string, language: string): string {
  return `receipt_${receiptNumber.replace(/[^A-Za-z0-9_-]/g, "_")}_${language}.pdf`;
}

// ─── English renderer (PDFKit) ───────────────────────────────────────────────

const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#cbd5e1";

function formatRs(n: number): string {
  return `Rs. ${Math.round(n || 0).toLocaleString("en-PK")}/-`;
}

function fmtDate(d?: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB");
}

/** Render the single receipt slip inside the rectangle (ox, oy, w, h). */
function renderEnglishSlip(
  doc: PDFKit.PDFDocument,
  r: IReceipt,
  ox: number,
  oy: number,
  w: number,
): void {
  const pad = 20;
  const left = ox + pad;
  const right = ox + w - pad;
  const innerW = right - left;

  let y = oy + pad;

  // ── Header ──
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18)
    .text(r.societyName || "KKB Housing Society", left, y, { width: innerW });
  doc.fillColor(MUTED).font("Helvetica").fontSize(10)
    .text("Payment Receipt", left, doc.y + 2, { width: innerW });

  y += 42;
  doc.lineWidth(0.7).strokeColor(LINE).moveTo(left, y).lineTo(right, y).stroke();
  y += 14;

  // ── Field grid ──
  const colGap = 16;
  const colW = (innerW - colGap) / 2;
  const rowH = 22;

  const field = (label: string, value: string, cx: number, cy: number, cw: number): void => {
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
      .text(label.toUpperCase(), cx, cy, { width: cw });
    doc.font("Helvetica-Bold").fontSize(11.5).fillColor(INK)
      .text(value || "—", cx, cy + 10, { width: cw, ellipsis: true, lineBreak: false });
  };

  field("Receipt No.", r.receiptNumber, left, y, colW);
  field("Date", fmtDate(r.paymentDate), left + colW + colGap, y, colW);
  y += rowH + 12;

  field("Block No.", r.blockNo, left, y, colW);
  field("Plot No.", r.plotNo, left + colW + colGap, y, colW);
  y += rowH + 12;

  field("Received From (Owner)", r.ownerName, left, y, innerW);
  y += rowH + 12;

  field("Month", r.month || "—", left, y, colW);
  field("Year", r.year ? String(r.year) : "—", left + colW + colGap, y, colW);
  y += rowH + 12;

  // Optional payment period (date range)
  if (r.dateFrom && r.dateTo) {
    field("Period", `${fmtDate(r.dateFrom)} - ${fmtDate(r.dateTo)}`, left, y, innerW);
    y += rowH + 12;
  }
  y += 4;

  // ── Amount band ──
  doc.lineWidth(0.7).strokeColor(LINE).rect(left, y, innerW, 40).fillAndStroke("#f8fafc", LINE);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("AMOUNT RECEIVED", left + 12, y + 8);
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK)
    .text(formatRs(r.amount), left + 12, y + 18);
  y += 40 + 18;

  doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
    .text("Received with thanks.", left, y);

  // ── Signature (single, society side) ──
  // Flows BELOW the amount section so it can never overlap the amount band.
  // The image sits above the line, and the card border is sized to fit.
  const sigW = 150;
  const sigX = right - sigW;
  const sigTop = y + 8;

  let lineY: number;
  const imgW = 48;
  const imgH = imgW * SIGNATURE_RATIO;
  if (fs.existsSync(SIGNATURE_PATH)) {
    try {
      doc.image(SIGNATURE_PATH, sigX + (sigW - imgW) / 2, sigTop, { width: imgW });
      lineY = sigTop + imgH + 3;
    } catch {
      lineY = sigTop + 30; // corrupt/unsupported image — leave blank space
    }
  } else {
    lineY = sigTop + 30;
  }

  doc.lineWidth(0.6).strokeColor(LINE).moveTo(sigX, lineY).lineTo(sigX + sigW, lineY).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text("Authorized Signatory", sigX, lineY + 4, { width: sigW, align: "center" });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK)
    .text(r.societyName || "KKB Housing Society", sigX, lineY + 14, { width: sigW, align: "center" });

  // ── Card border (drawn last, sized to the actual content) ──
  const cardBottom = lineY + 28;
  doc.lineWidth(0.9).strokeColor(LINE).roundedRect(ox, oy, w, cardBottom - oy, 8).stroke();
}

function generateEnglishPDF(receipt: IReceipt): Promise<ReceiptResult> {
  const fileName = safeFileName(receipt.receiptNumber, "en");
  const tmpPath = path.join(RECEIPTS_DIR, fileName);

  const renderToTmp = new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 0 });
    const stream = fs.createWriteStream(tmpPath);
    doc.pipe(stream);

    const pageW = doc.page.width;
    const margin = 26;
    const slipW = pageW - 2 * margin;

    renderEnglishSlip(doc, receipt, margin, margin, slipW);

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });

  return renderToTmp.then(async () => {
    const url = await uploadReceiptAndCleanup(tmpPath, fileName, receipt.year);
    return { url, fileName };
  });
}

// ─── Urdu renderer (Python subprocess) ───────────────────────────────────────

async function generateUrduPDF(receipt: IReceipt): Promise<ReceiptResult> {
  const fileName = safeFileName(receipt.receiptNumber, "ur");
  const filePath = path.join(RECEIPTS_DIR, fileName);

  const payload = {
    outputPath: filePath,
    societyName: receipt.societyName || "کے کے بی ہاؤسنگ سوسائٹی",
    receiptNumber: receipt.receiptNumber,
    date: fmtDate(receipt.paymentDate),
    blockNo: receipt.blockNo || "",
    plotNo: receipt.plotNo || "",
    ownerName: receipt.ownerName || "",
    month: EN_TO_UR_MONTH[receipt.month] || receipt.month || "",
    year: receipt.year ? String(receipt.year) : "",
    amount: Math.round(receipt.amount || 0),
    period:
      receipt.dateFrom && receipt.dateTo
        ? `${fmtDate(receipt.dateFrom)} - ${fmtDate(receipt.dateTo)}`
        : "",
    signaturePath: fs.existsSync(SIGNATURE_PATH) ? SIGNATURE_PATH : "",
    isVerified: !!receipt.isVerified,
  };

  if (!fs.existsSync(PYTHON_SCRIPT)) {
    throw new Error(
      `Urdu receipt generator script not found at ${PYTHON_SCRIPT}. ` +
        `Make sure backend/scripts/generate_urdu_receipt.py exists.`,
    );
  }

  const payloadPath = path.join(
    RECEIPTS_DIR,
    `_payload_${receipt.receiptNumber.replace(/[^A-Za-z0-9_-]/g, "_")}_${Date.now()}.json`,
  );
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), "utf-8");

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_BIN,
      [PYTHON_SCRIPT, "--file", payloadPath],
      { timeout: 60_000 },
    );

    if (stderr?.trim()) {
      if (stderr.includes("DEPENDENCY_ERROR")) {
        throw new Error(`Urdu receipt generator: ${stderr.trim()}`);
      }
      console.warn("[receiptPdfGenerator] Python stderr:", stderr.trim());
    }

    const outPath = stdout.trim() || filePath;
    if (!fs.existsSync(outPath)) {
      throw new Error(
        `Urdu receipt generator finished but no PDF was written at ${outPath}. ` +
          `stderr: ${stderr?.trim() || "(none)"}`,
      );
    }
    const url = await uploadReceiptAndCleanup(outPath, path.basename(outPath), receipt.year);
    return { url, fileName: path.basename(outPath) };
  } catch (err: any) {
    if (err && (err.stderr || err.stdout)) {
      const detail = [err.stderr, err.stdout].filter(Boolean).join("\n").trim();
      const reason = detail || err.message || "Unknown error";
      if (err.code === "ENOENT") {
        throw new Error(
          `Cannot spawn '${PYTHON_BIN}'. Install Python 3 or set PYTHON_BIN env var. ${reason}`,
        );
      }
      throw new Error(`Urdu receipt generator failed: ${reason}`);
    }
    throw err;
  } finally {
    fs.unlink(payloadPath, () => {});
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Generate a payment-receipt PDF (single slip) for one receipt.
 *  - English → PDFKit
 *  - Urdu    → Python (Nastaliq)
 */
export async function generateReceiptPDF(receipt: IReceipt): Promise<ReceiptResult> {
  if (receipt.language === "ur") {
    return generateUrduPDF(receipt);
  }
  return generateEnglishPDF(receipt);
}
