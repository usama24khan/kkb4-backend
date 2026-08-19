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

function formatUnpaidMonthsEn(months: string[]): string {
  if (months.length === 0) return "—";
  if (months.length === 12) return "All 12 months";
  const indexes = months.map((m) => MONTHS.indexOf(m as any));
  const isRun =
    indexes.length > 1 &&
    indexes.every((v, i) => i === 0 || v === indexes[i - 1] + 1);
  if (isRun) {
    return `${MONTH_NAMES[months[0]].slice(0, 3)}–${MONTH_NAMES[months[months.length - 1]].slice(0, 3)} (${months.length})`;
  }
  return months.map((m) => MONTH_NAMES[m].slice(0, 3)).join(", ");
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
    // The English notice carries Urdu too — the title, the note heading and the
    // signatory line. If the font is missing the page still renders, in English
    // alone, rather than failing outright.
    let hasUrduFont = true;
    try {
      registerUrduFont(doc);
    } catch {
      hasUrduFont = false;
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
      "en",
      hasUrduFont,
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

const URDU_MONTH: Record<string, string> = {
  jan: "جنوری",
  feb: "فروری",
  mar: "مارچ",
  apr: "اپریل",
  may: "مئی",
  jun: "جون",
  jul: "جولائی",
  aug: "اگست",
  sep: "ستمبر",
  oct: "اکتوبر",
  nov: "نومبر",
  dec: "دسمبر",
};

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

function urduUnpaidMonths(months: string[]): string {
  if (!months.length) return "—";
  if (months.length === 12) return "تمام 12 ماہ";
  return months.map((m) => URDU_MONTH[m] || m).join("، ");
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
 * The maintenance notice — one design, rendered for either language.
 *
 * Deliberately plain, because a resident has to be able to read it at the gate:
 * the word NOTICE at the top in both languages, who and what it concerns in a
 * bordered table, the dues stated as lines rather than a grid, the important
 * note, the WhatsApp number, and the signature. Nothing else.
 *
 * `lead` decides which language comes first in each pair; both are always shown,
 * so one notice serves an Urdu reader and an English reader alike.
 *
 * Urdu is drawn through `line()`, which reverses word order so a left-to-right
 * renderer produces right-to-left text — see utils/urduText.ts. Urdu prose is
 * broken into fitting lines by `wrapUrdu` first, since a reversed string must
 * never be handed to PDFKit's own wrapping.
 */
function renderNotice(
  doc: PDFKit.PDFDocument,
  plot: IPlot,
  breakdowns: YearBreakdown[],
  grandTotal: number,
  yearLabel: string,
  noticeNumber: number,
  paymentDeadline: Date | null | undefined,
  lead: "en" | "ur",
  hasUrduFont: boolean,
): void {
  const URDU = URDU_FONT_FAMILY;
  const LATIN = "Helvetica";
  const LATIN_B = "Helvetica-Bold";

  const PAGE_W = mm(210);
  const PAGE_H = mm(297);
  const LEFT_X = mm(20);
  const RIGHT_X = mm(190);
  const CONTENT_W = RIGHT_X - LEFT_X;

  let y = mm(20);

  /** An Urdu line, skipped entirely if the font could not be registered. */
  const ur = (
    text: string,
    size: number,
    x: number,
    w: number,
    align: "left" | "right" | "center" = "right",
    colour: string = UR_DARK,
  ) => {
    if (!hasUrduFont) return;
    doc.font(URDU).fontSize(size).fillColor(colour);
    line(doc, text, x, y, w, align);
  };

  /** Urdu prose, wrapped then drawn line by line; returns the height used. */
  const urParagraph = (text: string, size: number, lh: number, colour = UR_DARK): void => {
    if (!hasUrduFont) return;
    doc.font(URDU).fontSize(size).fillColor(colour);
    for (const l of wrapUrdu(doc, text, CONTENT_W)) {
      line(doc, l, LEFT_X, y, CONTENT_W, "right");
      y += lh;
    }
  };

  /** English prose, wrapped by PDFKit. */
  const en = (text: string, size = 10, colour = UR_DARK, bold = false) => {
    doc.font(bold ? LATIN_B : LATIN).fontSize(size).fillColor(colour);
    doc.text(text, LEFT_X, y, { width: CONTENT_W, align: "left" });
    y = doc.y;
  };

  // ── Title: the word NOTICE, in both languages, and nothing above it ───────

  doc.font(LATIN_B).fontSize(26).fillColor(UR_DARK);
  doc.text("NOTICE", LEFT_X, y, { width: CONTENT_W, align: "center" });
  y = doc.y + mm(1);

  if (hasUrduFont) {
    doc.font(URDU).fontSize(18).fillColor(UR_DARK);
    line(doc, "نوٹس", LEFT_X, y, CONTENT_W, "center");
    // Nastaliq drops well below its origin — the rule was crossing the word.
    y += mm(16);
  }

  doc.strokeColor(UR_DARK).lineWidth(mm(0.6));
  doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
  y += mm(6);

  // ── Who and what this concerns ────────────────────────────────────────────

  const status = plot.allotmentStatus || "Unknown";
  const rows: Array<{ en: string; ur: string; value: string }> = [
    { en: "Notice No", ur: "نوٹس نمبر", value: String(noticeNumber) },
    { en: "Date", ur: "تاریخ", value: new Date().toLocaleDateString("en-GB") },
    { en: "Owner", ur: "مالک", value: plot.ownerName || "—" },
    {
      en: "Plot / Block / Phase",
      ur: "پلاٹ / بلاک / فیز",
      value: `${plot.plotNumber || "?"} / ${plot.block || "?"} / ${canonicalPhase(plot) || "—"}`,
    },
  ];
  if (plot.ownerPhone) rows.push({ en: "Phone", ur: "فون", value: plot.ownerPhone });
  rows.push({
    en: "Status",
    ur: "حیثیت",
    value: hasUrduFont ? status : status,
  });

  const LABEL_W = mm(62);
  const ROW_H = mm(8);
  const tableTop = y;

  for (const row of rows) {
    // English label at the left of the cell, Urdu at the right of it, so the
    // reader finds the label in whichever script they read.
    doc.font(LATIN_B).fontSize(9.5).fillColor(UR_SOFT_DARK);
    doc.text(row.en, LEFT_X + mm(3), y + mm(3), { width: LABEL_W - mm(6), align: "left", lineBreak: false });
    if (hasUrduFont) {
      doc.font(URDU).fontSize(9).fillColor(UR_SOFT_DARK);
      line(doc, row.ur, LEFT_X + mm(3), y + mm(0.8), LABEL_W - mm(6), "right");
    }

    doc.font(LATIN).fontSize(11).fillColor(UR_DARK);
    doc.text(row.value, LEFT_X + LABEL_W + mm(3), y + mm(2.8), {
      width: CONTENT_W - LABEL_W - mm(6), align: "left", lineBreak: false,
    });

    y += ROW_H;
    doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.2));
    doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
  }

  // Outer border and the divider between label and value columns.
  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.35));
  doc.rect(LEFT_X, tableTop, CONTENT_W, y - tableTop).stroke();
  doc.moveTo(LEFT_X + LABEL_W, tableTop).lineTo(LEFT_X + LABEL_W, y).stroke();
  y += mm(7);

  // ── The message ───────────────────────────────────────────────────────────

  /**
   * One statement in both languages, English then Urdu (or the reverse when the
   * notice leads in Urdu). Each gets its own band of the page: drawing them at
   * the same y let a Nastaliq line, which reaches much lower than a Latin one,
   * land on top of its own translation.
   */
  const pair = (enText: string, urText: string, enSize = 10.5, urSize = 12, bold = false) => {
    const drawEn = () => {
      doc.font(bold ? LATIN_B : LATIN).fontSize(enSize).fillColor(UR_DARK);
      doc.text(enText, LEFT_X, y, { width: CONTENT_W, align: "left" });
      y = doc.y + mm(2);
    };
    const drawUr = () => {
      if (!hasUrduFont) return;
      urParagraph(urText, urSize, mm(9.5));
      y += mm(2.5);
    };
    if (lead === "en") { drawEn(); drawUr(); } else { drawUr(); drawEn(); }
  };

  pair(
    `Your maintenance fee for ${yearLabel} has not been paid. The details are:`,
    `آپ کی مینٹیننس فیس (${yearLabel}) واجب الادا ہے۔ تفصیل درج ذیل ہے:`,
    11,
    12,
  );
  y += mm(3);

  if (!breakdowns.length) {
    pair(
      "No maintenance dues are outstanding for this period.",
      "مذکورہ مدت کے لیے کوئی رقم واجب الادا نہیں ہے۔",
    );
  } else {
    for (const row of breakdowns) {
      const months = row.unpaidMonths.length;
      const amount = row.amountDue.toLocaleString("en-US");

      doc.font(LATIN).fontSize(10.5).fillColor(UR_DARK);
      const enText =
        months === 12
          ? `${row.year}:  full year  —  PKR ${amount}`
          : `${row.year}:  ${months} month${months === 1 ? "" : "s"}  —  PKR ${amount}`;
      doc.text(enText, LEFT_X + mm(4), y + mm(2.5), {
        width: CONTENT_W / 2, align: "left", lineBreak: false,
      });

      const urText =
        months === 12
          ? `سال ${row.year}: پورا سال — ${amount} روپے`
          : `سال ${row.year}: ${months} ماہ — ${amount} روپے`;
      ur(urText, 12, PAGE_W / 2 - mm(10), CONTENT_W / 2 + mm(20) - mm(10));

      y += mm(8);
    }

    y += mm(2.5);
    doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.3));
    doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
    y += mm(5);

    const total = grandTotal.toLocaleString("en-US");
    doc.font(LATIN_B).fontSize(12).fillColor(UR_DARK);
    doc.text(`Total outstanding:  PKR ${total}`, LEFT_X + mm(4), y + mm(2.5), {
      width: CONTENT_W / 2, align: "left", lineBreak: false,
    });
    ur(`کل واجب الادا رقم: ${total} روپے`, 13, PAGE_W / 2 - mm(10), CONTENT_W / 2 + mm(20) - mm(10));
    y += mm(12);
  }

  if (paymentDeadline) {
    const deadline = new Date(paymentDeadline).toLocaleDateString("en-GB");
    pair(
      `Please pay at the society office by ${deadline}.`,
      `براہ کرم مذکورہ رقم ${deadline} تک سوسائٹی آفس میں جمع کروائیں۔`,
      10.5,
      12,
      true,
    );
    y += mm(2);
  }

  // ── Important note, in both languages ─────────────────────────────────────

  const NOTE_EN =
    "Society services may be suspended if payment is not received by the date above. " +
    "Always collect a receipt — a payment without one is not recorded.";
  const NOTE_UR =
    "مقررہ تاریخ تک ادائیگی نہ ہونے پر سوسائٹی کی سہولیات معطل ہو سکتی ہیں۔ " +
    "ادائیگی کی رسید ضرور حاصل کریں۔";

  const noteTop = y;
  y += mm(4);

  // Both headings on one line, then the two texts stacked — the Urdu heading was
  // landing in the middle of the English sentence.
  doc.font(LATIN_B).fontSize(11).fillColor(UR_DARK);
  doc.text("Important Note", LEFT_X + mm(4), y + mm(1), {
    width: CONTENT_W / 2, align: "left", lineBreak: false,
  });
  ur("اہم نوٹ", 12, PAGE_W / 2, CONTENT_W / 2 - mm(4));
  y += mm(11);

  doc.font(LATIN).fontSize(9.5).fillColor(UR_DARK);
  doc.text(NOTE_EN, LEFT_X + mm(4), y, { width: CONTENT_W - mm(8), align: "left" });
  y = doc.y + mm(2);
  if (hasUrduFont) {
    doc.font(URDU).fontSize(11).fillColor(UR_DARK);
    for (const l of wrapUrdu(doc, NOTE_UR, CONTENT_W - mm(8))) {
      line(doc, l, LEFT_X + mm(4), y, CONTENT_W - mm(8), "right");
      y += mm(8);
    }
  }
  y += mm(2);

  // A light box, so the note reads as the warning it is.
  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.35));
  doc.rect(LEFT_X, noteTop, CONTENT_W, y - noteTop).stroke();
  y += mm(7);

  // ── Contact ───────────────────────────────────────────────────────────────

  doc.font(LATIN_B).fontSize(12).fillColor(UR_DARK);
  doc.text(`WhatsApp: ${SOCIETY_PHONE}`, LEFT_X, y, { width: CONTENT_W, align: "left" });
  y = doc.y + mm(6);

  // ── Signature ─────────────────────────────────────────────────────────────

  const sigW = mm(66);
  const sigX = RIGHT_X - sigW;
  const sigImgW = mm(18);
  const sigImgH = sigImgW * SIGNATURE_RATIO;
  const sigY = Math.max(y + sigImgH + mm(5), PAGE_H - mm(20) - mm(24));

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

  doc.font(LATIN_B).fontSize(10).fillColor(UR_DARK);
  doc.text("General Secretary / Chairman", sigX, sigY + mm(2.5), {
    width: sigW, align: "center", lineBreak: false,
  });
  if (hasUrduFont) {
    doc.font(URDU).fontSize(10.5).fillColor(UR_DARK);
    line(doc, "جنرل سیکریٹری / چیئرمین", sigX, sigY + mm(8), sigW, "center");
  }

  if (process.env.NOTICE_LAYOUT_DEBUG === "1") {
    const asMm = (v: number) => (v / mm(1)).toFixed(1);
    console.log(
      `[notice ${lead}] content ends ${asMm(y)}mm · signature ${asMm(sigY)}mm` +
        ` · footer ends ${asMm(sigY + mm(15))}mm · page 297mm`,
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
      true,
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
