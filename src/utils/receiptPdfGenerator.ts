/**
 * receiptPdfGenerator.ts
 * ================================
 * Generates payment-receipt PDFs for KKB4 Housing Society.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Language  │  Renderer                                               │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  English   │  PDFKit                                                 │
 * │  Urdu      │  PDFKit + Noto Nastaliq Urdu font                      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * One receipt = one slip (no duplicate copy). Both English and Urdu receipts
 * are rendered entirely in TypeScript via PDFKit. No Python dependency required.
 *
 * Receipt PDFs are generated on demand (cheap, and must always reflect the
 * latest DB state) into <backend>/receipts/.
 */

import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import os from "os";
import { IReceipt } from "../models/Receipt";
import { uploadToCloudinary } from "../lib/uploadToCloudinary";
import { registerUrduFont, URDU_FONT_FAMILY } from "./urduFont";
import { forPdf, hasNonLatin as hasUrdu } from "./urduText";

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

// Society signature image (shared by both renderers). Optional — if missing,
// the slip falls back to a blank signature line.
const SIGNATURE_PATH = path.join(__dirname, "../../signature/signature.png");
const SIGNATURE_RATIO = 414 / 603; // height / width of signature.png

// English → Urdu month names (the form stores the English month name).
const EN_TO_UR_MONTH: Record<string, string> = {
  January: "جنوری",
  February: "فروری",
  March: "مارچ",
  April: "اپریل",
  May: "مئی",
  June: "جون",
  July: "جولائی",
  August: "اگست",
  September: "ستمبر",
  October: "اکتوبر",
  November: "نومبر",
  December: "دسمبر",
};

const MONTH_KEYS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The months a payment settled, written for the slip.
 *
 * A receipt has to answer "what did I just pay for", and one month name could not:
 * ₨2,000 clearing ten months of 2012 printed as "January". So:
 *
 *   one month            → "July 2026"
 *   an unbroken run      → "January 2012 - October 2012 (10 months)"
 *   gaps in the run      → "Jan 2012, Mar 2012, Apr 2012 (3 months)"
 *
 * Short names in the gappy case because the field is one line and truncates; a
 * long list stops after six and counts the rest.
 */
export function formatCoveredMonths(
  covered: { year: number; month: string }[] | undefined,
  lang: "en" | "ur",
): string | null {
  if (!covered || covered.length === 0) return null;

  const ord = (m: { year: number; month: string }) =>
    m.year * 12 + MONTH_KEYS.indexOf(String(m.month).toLowerCase());
  const sorted = [...covered].sort((a, b) => ord(a) - ord(b));

  const longName = (m: { year: number; month: string }) => {
    const idx = MONTH_KEYS.indexOf(String(m.month).toLowerCase());
    const en = MONTH_NAMES[idx] || String(m.month);
    return `${lang === "ur" ? EN_TO_UR_MONTH[en] || en : en} ${m.year}`;
  };
  const shortName = (m: { year: number; month: string }) => {
    const idx = MONTH_KEYS.indexOf(String(m.month).toLowerCase());
    const en = MONTH_NAMES[idx] || String(m.month);
    return `${lang === "ur" ? EN_TO_UR_MONTH[en] || en : en.slice(0, 3)} ${m.year}`;
  };

  if (sorted.length === 1) return longName(sorted[0]);

  const count = sorted.length;
  // No brackets in the Urdu form. The renderer reverses word order to lay Urdu
  // out right to left, which leaves a "(" facing the wrong way and its partner
  // stranded at the other end of the line; a separator carries the same meaning
  // and cannot come apart.
  const contiguous = sorted.every((m, i) => i === 0 || ord(m) === ord(sorted[i - 1]) + 1);

  if (lang === "ur") {
    // Count first, then the range. The bracketed English form has no good Urdu
    // equivalent here: brackets mirror under right-to-left layout and a middle
    // dot next to a number reads as another digit ("10 ·" looked like "100").
    // "تا" is "to", which is how the range would be said aloud.
    const head = `${count} ماہ:`;
    if (contiguous) return `${head} ${longName(sorted[0])} تا ${longName(sorted[count - 1])}`;
    const list = sorted.slice(0, 6).map(shortName).join(", ");
    const rest = count - Math.min(6, count);
    return rest > 0 ? `${head} ${list} + ${rest} مزید` : `${head} ${list}`;
  }

  const suffix = `(${count} months)`;
  if (contiguous) {
    return `${longName(sorted[0])} - ${longName(sorted[count - 1])} ${suffix}`;
  }

  const shown = sorted.slice(0, 6).map(shortName).join(", ");
  const rest = count - Math.min(6, count);
  const more = rest > 0 ? ` +${rest} more` : "";
  return `${shown}${more} ${suffix}`;
}

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
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(r.societyName || "KKB Housing Society", left, y, { width: innerW });
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(10)
    .text("Payment Receipt", left, doc.y + 2, { width: innerW });

  y += 42;
  doc
    .lineWidth(0.7)
    .strokeColor(LINE)
    .moveTo(left, y)
    .lineTo(right, y)
    .stroke();
  y += 14;

  // ── Field grid ──
  const colGap = 16;
  const colW = (innerW - colGap) / 2;
  const rowH = 22;

  const field = (
    label: string,
    value: string,
    cx: number,
    cy: number,
    cw: number,
  ): void => {
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED)
      .text(label.toUpperCase(), cx, cy, { width: cw });
    doc
      .font("Helvetica-Bold")
      .fontSize(11.5)
      .fillColor(INK)
      .text(value || "—", cx, cy + 10, {
        width: cw,
        ellipsis: true,
        lineBreak: false,
      });
  };

  // The date the money came in sits at the top, where a receipt is read first.
  field("Receipt No.", r.receiptNumber, left, y, colW);
  field("Received On", fmtDate(r.paymentDate), left + colW + colGap, y, colW);
  y += rowH + 12;

  field("Block No.", r.blockNo, left, y, colW);
  field("Plot No.", r.plotNo, left + colW + colGap, y, colW);
  y += rowH + 12;

  field("Received From (Owner)", r.ownerName, left, y, innerW);
  y += rowH + 12;

  // What the money paid for. Every settled month is named across the full width,
  // because the old Month/Year pair could only show the first one — and printed
  // the year the slip was issued next to it, so arrears read "January 2026" for a
  // payment covering 2012.
  const paidFor = formatCoveredMonths(r.coveredMonths, "en");
  if (paidFor) {
    field("Paid For", paidFor, left, y, innerW);
    y += rowH + 12;
  } else {
    // Receipts written before covered months were recorded, and receipt-only
    // slips, still have just the one month.
    field("Month", r.month || "—", left, y, colW);
    field("Year", r.year ? String(r.year) : "—", left + colW + colGap, y, colW);
    y += rowH + 12;

    if (r.dateFrom && r.dateTo) {
      field("Period", `${fmtDate(r.dateFrom)} - ${fmtDate(r.dateTo)}`, left, y, innerW);
      y += rowH + 12;
    }
  }
  y += 4;

  // ── Amount band ──
  doc
    .lineWidth(0.7)
    .strokeColor(LINE)
    .rect(left, y, innerW, 40)
    .fillAndStroke("#f8fafc", LINE);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(MUTED)
    .text("AMOUNT RECEIVED", left + 12, y + 8);
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(INK)
    .text(formatRs(r.amount), left + 12, y + 18);
  y += 40 + 18;

  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor(MUTED)
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
      doc.image(SIGNATURE_PATH, sigX + (sigW - imgW) / 2, sigTop, {
        width: imgW,
      });
      lineY = sigTop + imgH + 3;
    } catch {
      lineY = sigTop + 30; // corrupt/unsupported image — leave blank space
    }
  } else {
    lineY = sigTop + 30;
  }

  doc
    .lineWidth(0.6)
    .strokeColor(LINE)
    .moveTo(sigX, lineY)
    .lineTo(sigX + sigW, lineY)
    .stroke();
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(MUTED)
    .text("Authorized Signatory", sigX, lineY + 4, {
      width: sigW,
      align: "center",
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(INK)
    .text(r.societyName || "KKB Housing Society", sigX, lineY + 14, {
      width: sigW,
      align: "center",
    });

  // ── Card border (drawn last, sized to the actual content) ──
  const cardBottom = lineY + 28;
  doc
    .lineWidth(0.9)
    .strokeColor(LINE)
    .roundedRect(ox, oy, w, cardBottom - oy, 8)
    .stroke();
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
    stream.on("error", (err) => { doc.end(); reject(err); });
    doc.on("error", (err) => { stream.destroy(); reject(err); });
  });

  return renderToTmp.then(async () => {
    const url = await uploadReceiptAndCleanup(tmpPath, fileName, receipt.year);
    return { url, fileName };
  });
}

// ─── Urdu renderer (PDFKit + Noto Nastaliq Urdu) ─────────────────────────────

/** Convert millimetres to PDF points. */
function mm(v: number): number {
  return v * (72 / 25.4);
}

// Monochrome palette (matches original Python receipt template)
const UR_DARK = "#0f172a"; // rgb(15, 23, 42)
const UR_SOFT_DARK = "#334155"; // rgb(51, 65, 85)
const UR_MUTED_C = "#64748b"; // rgb(100, 116, 139)
const UR_SUBTLE = "#94a3b8"; // rgb(148, 163, 184)
const UR_LINE_GREY = "#cbd5e1"; // rgb(203, 213, 225)
const UR_BAND_BG = "#f8fafc"; // rgb(248, 250, 252)

/**
 * Render the Urdu receipt slip using PDFKit.
 *
 * Replicates the layout of the original Python receipt template exactly —
 * same A5 page, card border, field grid, amount band, signature section,
 * colours, and spacing.
 */
function renderUrduSlip(
  doc: PDFKit.PDFDocument,
  p: IReceipt & { language: string },
): void {
  const URDU = URDU_FONT_FAMILY;
  const LATIN_B = "Helvetica-Bold";

  // Page geometry (A5: 148 × 210 mm)
  const PAGE_W = mm(148);
  const MARGIN = mm(14);
  const PAD = mm(9);
  const CARD_TOP = mm(13);

  const boxX = MARGIN;
  const boxW = PAGE_W - 2 * MARGIN;
  const innerL = boxX + PAD;
  const innerR = boxX + boxW - PAD;
  const innerW = innerR - innerL;

  let y = CARD_TOP + PAD;

  // ── Header ──
  const society = p.societyName || "کے کے بی ہاؤسنگ سوسائٹی";
  doc.font(URDU).fontSize(15).fillColor(UR_DARK);
  const societyOut = forPdf(society);
  let sw = doc.widthOfString(societyOut);
  doc.text(societyOut, (PAGE_W - sw) / 2, y, { lineBreak: false });
  // Nastaliq at 15pt swings well below its baseline; mm(10) let the subtitle's
  // ascenders cross the title's descenders.
  y += mm(13);

  const subtitle = "ادائیگی کی رسید";
  doc.font(URDU).fontSize(10).fillColor(UR_MUTED_C);
  const subtitleOut = forPdf(subtitle);
  sw = doc.widthOfString(subtitleOut);
  doc.text(subtitleOut, (PAGE_W - sw) / 2, y, { lineBreak: false });
  y += mm(11);

  // Horizontal divider
  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.3));
  doc.moveTo(innerL, y).lineTo(innerR, y).stroke();
  y += mm(6);

  // ── Two-column meta rows ──
  // Noto Nastaliq glyphs extend far above the baseline — give each row
  // enough height so the 8pt label never visually bleeds into the value below.
  const colGap = mm(8);
  const colW = (innerW - colGap) / 2;
  const rightColX = innerR - colW;
  const leftColX = innerL;
  // rowH must cover: label (8pt Nastaliq ≈ 13pt visual) + gap + value (11pt Nastaliq ≈ 17pt visual)
  const LABEL_FS = 7;
  const VALUE_FS = 11;
  const LABEL_H = mm(9.5); // visual height of Nastaliq label line
  const rowH = mm(22);     // total height per field row

  const urduField = (
    labelUr: string,
    value: string,
    colX: number,
    cy: number,
    w: number,
    valueUrdu?: boolean | null,
  ): void => {
    // Label: small muted Urdu text, right-aligned, words in reading order.
    doc.font(URDU).fontSize(LABEL_FS).fillColor(UR_SUBTLE);
    doc.text(forPdf(labelUr), colX, cy, { width: w, align: "right", lineBreak: false });

    // Value: rendered below the label with enough clearance for Nastaliq ascenders
    const valY = cy + LABEL_H;
    if (valueUrdu === true) {
      doc.font(URDU).fontSize(VALUE_FS).fillColor(UR_DARK);
    } else if (valueUrdu === false) {
      doc.font(LATIN_B).fontSize(VALUE_FS).fillColor(UR_DARK);
    } else {
      if (hasUrdu(value || "")) {
        doc.font(URDU).fontSize(VALUE_FS).fillColor(UR_DARK);
      } else {
        doc.font(LATIN_B).fontSize(VALUE_FS).fillColor(UR_DARK);
      }
    }
    doc.text(forPdf(value || "—"), colX, valY, {
      width: w,
      align: "right",
      lineBreak: false,
    });
  };

  // Row 1: Receipt number (right) | Date (left)
  urduField("رسید نمبر", p.receiptNumber, rightColX, y, colW, false);
  urduField("موصولی کی تاریخ", fmtDate(p.paymentDate), leftColX, y, colW, false);
  y += rowH;

  // Row 2: Block (right) | Plot (left)
  urduField("بلاک نمبر", p.blockNo || "", rightColX, y, colW);
  urduField("پلاٹ نمبر", p.plotNo || "", leftColX, y, colW);
  y += rowH;

  // Row 3: Owner name (full width)
  urduField("مالک کا نام", p.ownerName || "", innerL, y, innerW);
  y += rowH;

  // Row 4: every month the payment settled, full width (see the English renderer
  // for why a single Month/Year pair was not enough).
  const urPaidFor = formatCoveredMonths(p.coveredMonths, "ur");
  if (urPaidFor) {
    urduField("ادا شدہ مہینے", urPaidFor, innerL, y, innerW);
    y += rowH;
  } else {
    const urMonth = EN_TO_UR_MONTH[p.month] || p.month || "";
    urduField("مہینہ", urMonth, rightColX, y, colW);
    urduField("سال", p.year ? String(p.year) : "", leftColX, y, colW, false);
    y += rowH;

    if (p.dateFrom && p.dateTo) {
      const period = `${fmtDate(p.dateFrom)} - ${fmtDate(p.dateTo)}`;
      urduField("دورانیہ", period, innerL, y, innerW, false);
      y += rowH;
    }
  }
  y += mm(3);

  // ── Amount band ──
  // Band is tall enough to hold: "موصول رقم" label (top) + amount line (middle).
  // Nastaliq at fontSize 14 needs ~18pt (≈6.5mm) of visual height, so bandH=26mm
  // gives comfortable padding above and below.
  const bandH = mm(23);
  doc.save();
  doc.lineWidth(mm(0.3));
  doc.rect(innerL, y, innerW, bandH).fillAndStroke(UR_BAND_BG, UR_LINE_GREY);
  doc.restore();

  // "موصول رقم" label — small, top-right inside band
  doc.font(URDU).fontSize(7).fillColor(UR_MUTED_C);
  doc.text(forPdf("موصول رقم"), innerL, y + mm(4), {
    width: innerW - mm(4),
    align: "right",
    lineBreak: false,
  });

  // Amount line — "X,XXX/- روپے", right-aligned inside the band.
  //
  // Drawn as one string in the Urdu font rather than two runs in two fonts:
  // Helvetica and Nastaliq place their baselines very differently, so the same
  // `y` put the rupee word visibly below the digits, as if it had wrapped.
  const amount = Math.round(p.amount || 0);
  // Two spaces: one closes up to almost nothing between a Latin figure and a
  // Nastaliq word, leaving "4,000/-روپے" with no gap at all.
  const amountStr = `${amount.toLocaleString("en-US")}/-  روپے`;

  doc.font(URDU).fontSize(14).fillColor(UR_DARK);
  doc.text(forPdf(amountStr), innerL, y + mm(11), {
    width: innerW - mm(4),
    align: "right",
    lineBreak: false,
  });

  y += bandH + mm(4);


  // ── Signature ──
  // On the right: this document reads right to left, and a signature block on
  // the left is the clearest sign that a page was laid out for the wrong script.
  const sigW = mm(55);
  const sigX = innerR - sigW;
  const sigTop = y;

  let lineY: number;
  if (fs.existsSync(SIGNATURE_PATH)) {
    const imgW = mm(17);
    const imgH = imgW * SIGNATURE_RATIO;
    try {
      doc.image(SIGNATURE_PATH, sigX + (sigW - imgW) / 2, sigTop, {
        width: imgW,
      });
      lineY = sigTop + imgH + mm(1.5);
    } catch {
      lineY = sigTop + mm(12);
    }
  } else {
    lineY = sigTop + mm(12);
  }

  // Signature line
  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.3));
  doc.moveTo(sigX, lineY).lineTo(sigX + sigW, lineY).stroke();

  // "مجاز دستخط" (Authorized signatory)
  doc.font(URDU).fontSize(8).fillColor(UR_MUTED_C);
  doc.text(forPdf("مجاز دستخط"), sigX, lineY + mm(2), {
    width: sigW,
    align: "center",
    lineBreak: false,
  });

  // Society name
  doc.font(URDU).fontSize(8).fillColor(UR_DARK);
  doc.text(forPdf(society), sigX, lineY + mm(9), {
    width: sigW,
    align: "center",
    lineBreak: false,
  });

  // ── Card border (drawn last, sized to the actual content) ──
  const cardBottom = lineY + mm(16);
  if (process.env.RECEIPT_LAYOUT_DEBUG === "1") {
    console.log(
      `[receipt layout] card ${(CARD_TOP / mm(1)).toFixed(1)}mm → ${(cardBottom / mm(1)).toFixed(1)}mm` +
        ` · page 210mm · slack ${(210 - cardBottom / mm(1)).toFixed(1)}mm`,
    );
  }
  doc.lineWidth(mm(0.4)).strokeColor(UR_LINE_GREY);
  doc
    .roundedRect(boxX, CARD_TOP, boxW, cardBottom - CARD_TOP, mm(2.5))
    .stroke();
}

// ─── Urdu PDF generator ─────────────────────────────────────────────────────

async function generateUrduPDF(receipt: IReceipt): Promise<ReceiptResult> {
  const fileName = safeFileName(receipt.receiptNumber, "ur");
  const tmpPath = path.join(RECEIPTS_DIR, fileName);

  const renderToTmp = new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 0 });
    try {
      registerUrduFont(doc);
    } catch (err) {
      reject(err);
      return;
    }
    const stream = fs.createWriteStream(tmpPath);
    doc.pipe(stream);

    renderUrduSlip(doc, receipt as IReceipt & { language: string });

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", (err) => { doc.end(); reject(err); });
    doc.on("error", (err) => { stream.destroy(); reject(err); });
  });

  return renderToTmp.then(async () => {
    const url = await uploadReceiptAndCleanup(tmpPath, fileName, receipt.year);
    return { url, fileName };
  });
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Generate a payment-receipt PDF (single slip) for one receipt.
 *  - English → PDFKit (Helvetica)
 *  - Urdu    → PDFKit (Noto Nastaliq Urdu)
 */
export async function generateReceiptPDF(
  receipt: IReceipt,
): Promise<ReceiptResult> {
  if (receipt.language === "ur") {
    try {
      return await generateUrduPDF(receipt);
    } catch (err) {
      // fontkit GPOS bug with Noto Nastaliq Urdu — fall back to English layout.
      console.warn("[receipt] Urdu PDF failed, falling back to English:", (err as Error).message);
      return generateEnglishPDF(receipt);
    }
  }
  return generateEnglishPDF(receipt);
}
