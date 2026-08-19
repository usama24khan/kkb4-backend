/**
 * pdfGenerator.ts
 * ================================
 * Generates maintenance-notice PDFs for KKB4 Housing Society.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Language  │  Renderer                                               │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  English   │  PDFKit                                                 │
 * │  Urdu      │  PDFKit + Noto Nastaliq Urdu font                      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Both languages are rendered entirely in TypeScript via PDFKit. No Python
 * dependency is required.
 *
 * Font setup:
 *   Drop NotoNastaliqUrdu-Regular.ttf (or -Static.ttf) in backend/scripts/
 *   — or set URDU_FONT_PATH=/absolute/path/to/font.ttf
 *
 * Download font from:
 *   https://fonts.google.com/noto/specimen/Noto+Nastaliq+Urdu
 */

import PDFDocument from "pdfkit";
import {
  MONTHS,
  MONTH_NAMES,
  getMcRateForYear,
  getMcRateForMonth,
  BLOCK_PHASE_MAP,
} from "../config/constants";
import { IPlot } from "../models/Plot";
import { IPaymentMonths } from "../models/Payment";
import path from "path";
import fs from "fs";
import os from "os";
import { uploadToCloudinary } from "../lib/uploadToCloudinary";
import {
  findUrduFontPath,
  registerUrduFont,
  URDU_FONT_FAMILY,
} from "./urduFont";
import { forPdf, hasNonLatin, wrapUrdu } from "./urduText";

/**
 * Return the canonical phase for a plot using the current BLOCK_PHASE_MAP.
 * Falls back to the stored `plot.phase` if the block isn't mapped (which
 * shouldn't happen, but is safe). This makes notices immune to stale phase
 * values left in the DB from before a phase-mapping change — they'll always
 * show the correct phase even if the migration script hasn't been run.
 */
function canonicalPhase(plot: IPlot): string {
  const block = (plot.block || "").toUpperCase();
  return BLOCK_PHASE_MAP[block] || plot.phase || "";
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/**
 * Notice PDFs are generated into the OS temp dir (writable on Vercel, where the
 * deployment FS is read-only), uploaded to Cloudinary, then deleted locally.
 * `NOTICES_DIR` is the scratch space for both the PDF and the Urdu payload file.
 */
const NOTICES_DIR = os.tmpdir();

/**
 * Cloudinary storage key for notice PDFs. Final key looks like:
 *   notices/2025/notice_12_374_A_2024-2025.pdf
 */
function noticeKey(fileName: string, yearLabel: string): string {
  return `notices/${yearLabel}/${fileName}`;
}

/**
 * Upload a freshly-generated notice PDF (sitting in the temp dir) to Cloudinary,
 * delete the local temp copy, and return the public delivery URL. On upload
 * failure the temp file is still cleaned up and the error propagates.
 */
async function uploadNoticeAndCleanup(
  tmpPath: string,
  yearLabel: string,
): Promise<string> {
  try {
    const url = await uploadToCloudinary(
      tmpPath,
      noticeKey(path.basename(tmpPath), yearLabel),
    );
    return url;
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// Society signature image (shared with the receipt generator). Optional — if
// missing, the notice falls back to a plain signature line.
const SIGNATURE_PATH = path.join(__dirname, "../../signature/signature.png");
const SIGNATURE_RATIO = 414 / 603; // height / width of signature.png

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Structural shape we actually need to compute a breakdown.
 * Matches both full Mongoose documents and `.lean()` plain objects.
 */
export interface PaymentRecordLike {
  year: number;
  mcRate: number;
  payments: IPaymentMonths;
}

export interface YearBreakdown {
  year: number;
  mcRate: number;
  unpaidMonths: string[]; // ['mar', 'jun', 'sep', 'dec']
  amountDue: number;
}

export interface NoticeInput {
  plot: IPlot;
  payments: PaymentRecordLike[];
  yearFrom: number;
  yearTo: number;
  noticeNumber: number;
  language?: "en" | "ur";
  paymentDeadline?: Date | null;
}

export interface NoticeResult {
  pdfPath: string;
  amountDue: number;
  breakdowns: YearBreakdown[];
}

// ─── Breakdown computation ───────────────────────────────────────────────────

/**
 * Compute year-by-year unpaid breakdown for a plot over a year range.
 */
export function computeBreakdown(
  payments: PaymentRecordLike[],
  yearFrom: number,
  yearTo: number,
): { breakdowns: YearBreakdown[]; grandTotal: number } {
  const byYear = new Map<number, PaymentRecordLike>();
  for (const p of payments) byYear.set(p.year, p);

  const breakdowns: YearBreakdown[] = [];
  let grandTotal = 0;

  for (let y = yearFrom; y <= yearTo; y++) {
    const payment = byYear.get(y);
    const unpaidMonths: string[] = [];
    let amountDue = 0;

    // Each month is charged at its own rate. The charge rose mid-2022, so a
    // year-wide figure would understate the arrears of every month since May
    // 2022 and overstate January to April of that year.
    for (let i = 0; i < MONTHS.length; i++) {
      const m = MONTHS[i];
      const monthRate = getMcRateForMonth(y, i + 1);
      const paid = payment ? Number((payment.payments as any)[m] || 0) : 0;
      if (paid < monthRate) {
        unpaidMonths.push(m);
        amountDue += monthRate - paid;
      }
    }
    // The rate column can only show one number per year; use the prevailing one.
    const mcRate = getMcRateForYear(y);

    if (amountDue > 0) {
      breakdowns.push({ year: y, mcRate, unpaidMonths, amountDue });
      grandTotal += amountDue;
    }
  }

  return { breakdowns, grandTotal };
}

// ─── English renderer (PDFKit, unchanged) ───────────────────────────────────

function formatPKR(n: number): string {
  return `PKR ${Math.round(n).toLocaleString("en-PK")}`;
}

// ─── English PDF generator ───────────────────────────────────────────────────

function generateEnglishPDF(input: NoticeInput): Promise<NoticeResult> {
  const { plot, payments, yearFrom, yearTo, noticeNumber, paymentDeadline } =
    input;
  const { breakdowns, grandTotal } = computeBreakdown(
    payments,
    yearFrom,
    yearTo,
  );
  const yearLabel =
    yearFrom === yearTo ? `${yearFrom}` : `${yearFrom}-${yearTo}`;
  const fileName = `notice_${noticeNumber}_${plot.plotBlock.replace(/\s/g, "_")}_${yearLabel}.pdf`;
  const tmpPath = path.join(NOTICES_DIR, fileName);

  // Render to the temp file first…
  const renderToTmp = new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const stream = fs.createWriteStream(tmpPath);
    doc.pipe(stream);
    renderNotice(
      doc,
      plot,
      breakdowns,
      grandTotal,
      yearLabel,
      noticeNumber,
      paymentDeadline,
      "en",
    );
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", (err) => { doc.end(); reject(err); });
    doc.on("error", (err) => { stream.destroy(); reject(err); });
  });

  // …then upload to Cloudinary and clean up the temp file.
  return renderToTmp.then(async () => {
    const url = await uploadNoticeAndCleanup(tmpPath, yearLabel);
    return { pdfPath: url, amountDue: grandTotal, breakdowns };
  });
}

// ─── Urdu renderer (PDFKit + Noto Nastaliq Urdu) ─────────────────────────────

// Urdu translations
/** The number residents are told to contact. Shown on both notices. */
const SOCIETY_PHONE = "03070420007";

const URDU_STATUS: Record<string, string> = {
  Active: "فعال",
  Cancelled: "منسوخ",
  Unsold: "غیر فروخت",
  Unknown: "نامعلوم",
};

// Monochrome palette (matches original Python notice template)
const UR_DARK = "#0f172a"; // rgb(15, 23, 42)
const UR_SOFT_DARK = "#334155"; // rgb(51, 65, 85)
const UR_MUTED = "#64748b"; // rgb(100, 116, 139)
const UR_SUBTLE = "#94a3b8"; // rgb(148, 163, 184)
const UR_LINE_GREY = "#d2d9e3"; // rgb(210, 217, 227)
const UR_HEADER_BG = "#f3f5f8"; // rgb(243, 245, 248)

/** Convert millimetres to PDF points (1 mm ≈ 2.8346 pt). */
function mm(v: number): number {
  return v * (72 / 25.4);
}

function line(
  doc: PDFKit.PDFDocument,
  str: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "right" | "center" = "left",
): void {
  // Urdu strings are drawn right to left; Latin-only ones (numbers, dates) are
  // left as they are. See utils/urduText.ts.
  //
  // Never allowed to wrap: the string is already reversed, so PDFKit would break
  // it at what is visually the end of the sentence and stack the halves in the
  // wrong order. Prose is broken into lines by `wrapUrdu` before it gets here.
  doc.text(forPdf(str), x, y, { width, align, lineBreak: false });
}

/**
 * How the dues read as a sentence.
 *
 * Not a line per year: a notice is a letter, and "PKR 1,600 for 4 months of
 * 2023, PKR 2,400 for 6 months of 2024 and PKR 4,800 for all of 2025" is how a
 * person would say it. The amounts and years are all still there to check.
 */
function duesSentence(breakdowns: YearBreakdown[], lang: "en" | "ur"): string {
  const parts = breakdowns.map((row) => {
    const months = row.unpaidMonths.length;
    const amount = row.amountDue.toLocaleString("en-US");
    if (lang === "ur") {
      return months === 12
        ? `سال ${row.year} کے پورے سال کے ${amount} روپے`
        : `سال ${row.year} کے ${months} ماہ کے ${amount} روپے`;
    }
    return months === 12
      ? `PKR ${amount} for all of ${row.year}`
      : `PKR ${amount} for ${months} month${months === 1 ? "" : "s"} of ${row.year}`;
  });

  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];

  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  return lang === "ur"
    ? `${rest.join("، ")} اور ${last}`
    : `${rest.join(", ")} and ${last}`;
}

/**
 * The maintenance notice — one page, in one language.
 *
 * Whichever language is chosen is the language of the whole notice: the title,
 * the table labels, the message, the note and the signatory line. Nothing is
 * repeated in translation, so the page reads as a letter rather than a
 * side-by-side document.
 *
 * Urdu is drawn through `line()`, which reverses word order so a left-to-right
 * renderer produces right-to-left text, and its prose is broken into fitting
 * lines by `wrapUrdu` first — a reversed string must never be handed to PDFKit's
 * own wrapping. The Urdu table is mirrored: labels on the right, values left.
 */
function renderNotice(
  doc: PDFKit.PDFDocument,
  plot: IPlot,
  breakdowns: YearBreakdown[],
  grandTotal: number,
  yearLabel: string,
  noticeNumber: number,
  paymentDeadline: Date | null | undefined,
  lang: "en" | "ur",
): void {
  const isUr = lang === "ur";
  const URDU = URDU_FONT_FAMILY;
  const LATIN = "Helvetica";
  const LATIN_B = "Helvetica-Bold";

  const PAGE_W = mm(210);
  const PAGE_H = mm(297);
  const LEFT_X = mm(20);
  const RIGHT_X = mm(190);
  const CONTENT_W = RIGHT_X - LEFT_X;

  let y = mm(20);

  /** A heading or short line in the notice's own language. */
  const heading = (text: string, size: number, align: "left" | "right" | "center") => {
    if (isUr) {
      doc.font(URDU).fontSize(size).fillColor(UR_DARK);
      line(doc, text, LEFT_X, y, CONTENT_W, align);
    } else {
      doc.font(LATIN_B).fontSize(size).fillColor(UR_DARK);
      doc.text(text, LEFT_X, y, { width: CONTENT_W, align, lineBreak: false });
    }
  };

  /**
   * A paragraph in the notice's own language, wrapped to the content width.
   * Returns nothing; `y` is left below the last line.
   */
  const paragraph = (
    text: string,
    size: number,
    opts: { bold?: boolean; indent?: number; lh?: number } = {},
  ) => {
    const indent = opts.indent ?? 0;
    const width = CONTENT_W - indent;
    if (isUr) {
      doc.font(URDU).fontSize(size).fillColor(UR_DARK);
      const lh = opts.lh ?? mm(9.5);
      for (const l of wrapUrdu(doc, text, width)) {
        line(doc, l, LEFT_X + indent, y, width, "right");
        y += lh;
      }
    } else {
      doc.font(opts.bold ? LATIN_B : LATIN).fontSize(size).fillColor(UR_DARK);
      doc.text(text, LEFT_X + indent, y, { width, align: "left", lineGap: 2 });
      y = doc.y + mm(1);
    }
  };

  // ── Title: the word NOTICE, and nothing above it ──────────────────────────

  if (isUr) {
    doc.font(URDU).fontSize(24).fillColor(UR_DARK);
    line(doc, "نوٹس", LEFT_X, y, CONTENT_W, "center");
    // A 24pt Nastaliq line box is about 21mm tall, so anything less than this
    // puts the rule inside the word rather than under it.
    y += mm(23);
  } else {
    doc.font(LATIN_B).fontSize(26).fillColor(UR_DARK);
    doc.text("NOTICE", LEFT_X, y, { width: CONTENT_W, align: "center" });
    y = doc.y + mm(6);
  }

  doc.strokeColor(UR_DARK).lineWidth(mm(0.6));
  doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
  y += mm(7);

  // ── Who and what this concerns ────────────────────────────────────────────

  const statusValue = isUr
    ? URDU_STATUS[plot.allotmentStatus || "Unknown"] || plot.allotmentStatus || ""
    : plot.allotmentStatus || "—";

  const rows: Array<{ label: string; value: string; valueIsUrdu?: boolean }> = [
    { label: isUr ? "نوٹس نمبر" : "Notice No", value: String(noticeNumber) },
    { label: isUr ? "تاریخ" : "Date", value: new Date().toLocaleDateString("en-GB") },
    { label: isUr ? "مالک" : "Owner", value: plot.ownerName || "—" },
    {
      label: isUr ? "پلاٹ / بلاک / فیز" : "Plot / Block / Phase",
      value: `${plot.plotNumber || "?"} / ${plot.block || "?"} / ${canonicalPhase(plot) || "—"}`,
    },
  ];
  if (plot.ownerPhone) rows.push({ label: isUr ? "فون" : "Phone", value: plot.ownerPhone });
  rows.push({ label: isUr ? "حیثیت" : "Status", value: statusValue, valueIsUrdu: isUr });

  const LABEL_W = mm(50);
  // Nastaliq's line box at 10.5pt is 9.26mm — taller than a 9mm row, which is why
  // Urdu text was crossing the rules. Measured: an 11mm row with the text 0.5mm
  // down sits centred, with clearance above and below.
  const ROW_H = isUr ? mm(11) : mm(9);
  const UR_TEXT_DY = mm(0.5);
  // Helvetica at 11pt is ~3.9mm tall; centre it in whichever row height is used.
  const LATIN_TEXT_DY = isUr ? mm(3.6) : mm(2.8);
  const tableTop = y;
  // Mirrored for Urdu: the label column sits on the right, values to its left.
  const labelX = isUr ? RIGHT_X - LABEL_W : LEFT_X;
  const valueX = isUr ? LEFT_X : LEFT_X + LABEL_W;
  const valueW = CONTENT_W - LABEL_W;

  for (const row of rows) {
    if (isUr) {
      doc.font(URDU).fontSize(10.5).fillColor(UR_SOFT_DARK);
      line(doc, row.label, labelX + mm(3), y + UR_TEXT_DY, LABEL_W - mm(6), "right");
    } else {
      doc.font(LATIN_B).fontSize(10).fillColor(UR_SOFT_DARK);
      doc.text(row.label, labelX + mm(3), y + mm(3), {
        width: LABEL_W - mm(6), align: "left", lineBreak: false,
      });
    }

    if (row.valueIsUrdu) {
      doc.font(URDU).fontSize(11).fillColor(UR_DARK);
      line(doc, row.value, valueX + mm(3), y + UR_TEXT_DY, valueW - mm(6), "right");
    } else {
      doc.font(LATIN).fontSize(11).fillColor(UR_DARK);
      doc.text(row.value, valueX + mm(3), y + LATIN_TEXT_DY, {
        width: valueW - mm(6), align: isUr ? "right" : "left", lineBreak: false,
      });
    }

    y += ROW_H;
    doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.2));
    doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
  }

  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.35));
  doc.rect(LEFT_X, tableTop, CONTENT_W, y - tableTop).stroke();
  doc.moveTo(labelX, tableTop).lineTo(labelX, y).stroke();
  y += mm(10);

  // ── The message, written as sentences ─────────────────────────────────────

  const dues = duesSentence(breakdowns, lang);
  const total = grandTotal.toLocaleString("en-US");
  const deadline = paymentDeadline
    ? new Date(paymentDeadline).toLocaleDateString("en-GB")
    : null;

  if (!breakdowns.length) {
    paragraph(
      isUr
        ? `آپ کے پلاٹ پر مدت ${yearLabel} کے لیے کوئی مینٹیننس فیس واجب الادا نہیں ہے۔`
        : `No maintenance fee is outstanding on your plot for ${yearLabel}.`,
      12,
    );
  } else {
    paragraph(
      isUr
        ? `آپ کے پلاٹ پر مدت ${yearLabel} کی مینٹیننس فیس واجب الادا ہے۔ اِس میں ${dues} شامل ہیں۔ ` +
            `کل واجب الادا رقم ${total} روپے ہے۔`
        : `The maintenance fee on your plot for ${yearLabel} has not been paid. ` +
            `This is made up of ${dues}. The total outstanding amount is PKR ${total}.`,
      12,
    );
    y += mm(3);

    if (deadline) {
      paragraph(
        isUr
          ? `براہ کرم مکمل رقم ${deadline} تک سوسائٹی آفس میں جمع کروائیں اور رسید حاصل کریں۔`
          : `Please pay the full amount at the society office by ${deadline} and collect a receipt.`,
        12,
        { bold: true },
      );
    } else {
      paragraph(
        isUr
          ? "براہ کرم مکمل رقم سوسائٹی آفس میں جمع کروائیں اور رسید حاصل کریں۔"
          : "Please pay the full amount at the society office and collect a receipt.",
        12,
        { bold: true },
      );
    }
  }
  y += mm(6);

  // ── Important note ────────────────────────────────────────────────────────

  const noteTop = y;
  y += mm(4);

  heading(isUr ? "اہم نوٹ" : "Important Note", isUr ? 13 : 11.5, isUr ? "right" : "left");
  y += isUr ? mm(11) : mm(7);

  paragraph(
    isUr
      ? "مقررہ تاریخ تک ادائیگی نہ ہونے پر سوسائٹی کی سہولیات معطل ہو سکتی ہیں۔ " +
          "ادائیگی کی رسید ضرور حاصل کریں، کیونکہ رسید کے بغیر ادائیگی کا اندراج نہیں ہوتا۔"
      : "Society services may be suspended if payment is not received by the date above. " +
          "Always collect a receipt — a payment without one is not recorded.",
    isUr ? 11.5 : 10,
    { indent: mm(4), lh: mm(9) },
  );
  y += mm(3);

  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.35));
  doc.rect(LEFT_X, noteTop, CONTENT_W, y - noteTop).stroke();
  y += mm(8);

  // ── Contact ───────────────────────────────────────────────────────────────

  if (isUr) {
    doc.font(URDU).fontSize(12).fillColor(UR_DARK);
    line(doc, `واٹس ایپ نمبر: ${SOCIETY_PHONE}`, LEFT_X, y, CONTENT_W, "right");
    y += mm(11);
  } else {
    doc.font(LATIN_B).fontSize(12).fillColor(UR_DARK);
    doc.text(`WhatsApp: ${SOCIETY_PHONE}`, LEFT_X, y, { width: CONTENT_W, align: "left" });
    y = doc.y + mm(5);
  }

  // ── Signature ─────────────────────────────────────────────────────────────

  const sigW = mm(66);
  const sigX = RIGHT_X - sigW;
  const sigImgW = mm(18);
  const sigImgH = sigImgW * SIGNATURE_RATIO;
  const sigY = Math.min(y + sigImgH + mm(12), PAGE_H - mm(20) - mm(14));

  if (fs.existsSync(SIGNATURE_PATH)) {
    try {
      doc.image(SIGNATURE_PATH, sigX + (sigW - sigImgW) / 2, sigY - sigImgH - mm(1), {
        width: sigImgW,
      });
    } catch {
      /* corrupt or unsupported image — the line below still reads as a signature */
    }
  }

  doc.strokeColor(UR_DARK).lineWidth(mm(0.3));
  doc.moveTo(sigX, sigY).lineTo(RIGHT_X, sigY).stroke();

  if (isUr) {
    doc.font(URDU).fontSize(11).fillColor(UR_DARK);
    line(doc, "جنرل سیکریٹری / چیئرمین", sigX, sigY + mm(2), sigW, "center");
  } else {
    doc.font(LATIN_B).fontSize(10.5).fillColor(UR_DARK);
    doc.text("General Secretary / Chairman", sigX, sigY + mm(3), {
      width: sigW, align: "center", lineBreak: false,
    });
  }

  if (process.env.NOTICE_LAYOUT_DEBUG === "1") {
    const asMm = (v: number) => (v / mm(1)).toFixed(1);
    console.log(
      `[notice ${lang}] content ends ${asMm(y)}mm · signature ${asMm(sigY)}mm` +
        ` · footer ends ${asMm(sigY + mm(12))}mm · page 297mm`,
    );
  }
}

// ─── Urdu PDF generator ─────────────────────────────────────────────────────

/**
 * Generate an Urdu notice using PDFKit + Noto Nastaliq Urdu font.
 * Replaces the previous Python subprocess approach.
 */
async function generateUrduPDF(input: NoticeInput): Promise<NoticeResult> {
  const { plot, payments, yearFrom, yearTo, noticeNumber, paymentDeadline } =
    input;
  const { breakdowns, grandTotal } = computeBreakdown(
    payments,
    yearFrom,
    yearTo,
  );
  const yearLabel =
    yearFrom === yearTo ? `${yearFrom}` : `${yearFrom}-${yearTo}`;
  const fileName = `notice_${noticeNumber}_${plot.plotBlock.replace(/\s/g, "_")}_${yearLabel}_ur.pdf`;
  const tmpPath = path.join(NOTICES_DIR, fileName);

  const renderToTmp = new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    try {
      registerUrduFont(doc);
    } catch (err) {
      reject(err);
      return;
    }
    const stream = fs.createWriteStream(tmpPath);
    doc.pipe(stream);
    renderNotice(
      doc,
      plot,
      breakdowns,
      grandTotal,
      yearLabel,
      noticeNumber,
      paymentDeadline,
      "ur",
    );
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", (err) => { doc.end(); reject(err); });
    doc.on("error", (err) => { stream.destroy(); reject(err); });
  });

  return renderToTmp.then(async () => {
    const url = await uploadNoticeAndCleanup(tmpPath, yearLabel);
    return { pdfPath: url, amountDue: grandTotal, breakdowns };
  });
}

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * Check whether the Urdu rendering pipeline is healthy. Now that we use PDFKit
 * directly (no Python subprocess), this simply verifies the font file is present.
 */
export async function urduPipelineHealth(): Promise<{
  ok: boolean;
  status: string;
}> {
  const fontPath = findUrduFontPath();
  if (!fontPath) {
    return {
      ok: false,
      status: "Noto Nastaliq Urdu font not found in backend/scripts/",
    };
  }
  return { ok: true, status: `Font: ${fontPath}` };
}

/**
 * Generate a maintenance-notice PDF for a single plot.
 *
 * - English  → rendered by PDFKit (Helvetica).
 * - Urdu     → rendered by PDFKit (Noto Nastaliq Urdu).
 */
export async function generatePlotNotice(
  input: NoticeInput,
): Promise<NoticeResult> {
  if (input.language === "ur") {
    try {
      return await generateUrduPDF(input);
    } catch (err) {
      // fontkit GPOS bug with Noto Nastaliq Urdu — fall back to English layout.
      console.warn("[notice] Urdu PDF failed, falling back to English:", (err as Error).message);
      return generateEnglishPDF(input);
    }
  }
  return generateEnglishPDF(input);
}

/**
 * Generate notices for a list of plots in parallel (capped to avoid OOM).
 */
export async function generateBulkNotices(
  plotsWithPayments: Array<{ plot: IPlot; payments: PaymentRecordLike[] }>,
  yearFrom: number,
  yearTo: number,
  startNoticeNumber: number,
  language: "en" | "ur" = "en",
  paymentDeadline?: Date | null,
): Promise<NoticeResult[]> {
  const CONCURRENCY = 5;

  const results: NoticeResult[] = [];
  for (let i = 0; i < plotsWithPayments.length; i += CONCURRENCY) {
    const batch = plotsWithPayments.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((item, idx) =>
        generatePlotNotice({
          plot: item.plot,
          payments: item.payments,
          yearFrom,
          yearTo,
          noticeNumber: startNoticeNumber + i + idx,
          language,
          paymentDeadline,
        }),
      ),
    );
    results.push(...batchResults);
  }
  return results;
}
