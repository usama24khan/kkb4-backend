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
    const mcRate = payment?.mcRate ?? getMcRateForYear(y);
    const unpaidMonths: string[] = [];
    let amountDue = 0;

    for (const m of MONTHS) {
      const paid = payment ? Number((payment.payments as any)[m] || 0) : 0;
      if (paid < mcRate) {
        unpaidMonths.push(m);
        amountDue += mcRate - paid;
      }
    }

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

function renderEnglish(
  doc: PDFKit.PDFDocument,
  plot: IPlot,
  breakdowns: YearBreakdown[],
  grandTotal: number,
  yearLabel: string,
  noticeNumber: number,
  paymentDeadline?: Date | null,
): void {
  doc
    .fontSize(20)
    .font("Helvetica-Bold")
    .text("KKB4 Housing Society", { align: "center" });
  doc
    .fontSize(10)
    .font("Helvetica")
    .text("Maintenance Fee Collection Office", { align: "center" });
  doc.text("Contact: admin@kkb4.com", { align: "center" });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown();

  doc
    .fontSize(14)
    .font("Helvetica-Bold")
    .text("MAINTENANCE DUE NOTICE", { align: "center" });
  doc.moveDown(0.5);

  doc.fontSize(10).font("Helvetica");
  doc.text(`Notice No: ${noticeNumber}`);
  doc.text(`Date: ${new Date().toLocaleDateString("en-GB")}`);
  doc.text(`Covering: ${yearLabel}`);
  doc.moveDown();

  doc.fontSize(11).font("Helvetica-Bold").text("Owner Details:");
  doc.fontSize(10).font("Helvetica");
  doc.text(`Name: ${plot.ownerName || "—"}`);
  doc.text(
    `Plot Number: ${plot.plotNumber} | Block: ${plot.block} | Phase: ${canonicalPhase(plot) || "—"}`,
  );
  if (plot.ownerPhone) doc.text(`Phone: ${plot.ownerPhone}`);
  doc.text(`Status: ${plot.allotmentStatus}`);
  doc.moveDown();

  doc.fontSize(11).font("Helvetica-Bold").text("Outstanding Dues");
  doc.moveDown(0.4);

  const tableLeft = 50;
  const tableRight = 545;
  const colWidths = [60, 230, 80, 105];
  const headers = ["Year", "Months Unpaid", "Rate/Mo", "Amount Due"];

  const headerY = doc.y;
  doc.fontSize(10).font("Helvetica-Bold");
  let xPos = tableLeft;
  headers.forEach((h, i) => {
    doc.text(h, xPos, headerY, { width: colWidths[i] });
    xPos += colWidths[i];
  });
  doc
    .moveTo(tableLeft, headerY + 16)
    .lineTo(tableRight, headerY + 16)
    .stroke();

  doc.font("Helvetica");
  let yPos = headerY + 22;

  if (breakdowns.length === 0) {
    doc
      .fillColor("#059669")
      .text("No outstanding dues for the selected period.", tableLeft, yPos);
    doc.fillColor("black");
    yPos += 24;
  } else {
    for (const row of breakdowns) {
      xPos = tableLeft;
      doc.text(String(row.year), xPos, yPos, { width: colWidths[0] });
      xPos += colWidths[0];
      doc.text(formatUnpaidMonthsEn(row.unpaidMonths), xPos, yPos, {
        width: colWidths[1],
      });
      xPos += colWidths[1];
      doc.text(formatPKR(row.mcRate), xPos, yPos, { width: colWidths[2] });
      xPos += colWidths[2];
      doc.text(formatPKR(row.amountDue), xPos, yPos, { width: colWidths[3] });
      yPos += 18;
      if (yPos > 720) {
        doc.addPage();
        yPos = 50;
      }
    }
  }

  doc.moveTo(tableLeft, yPos).lineTo(tableRight, yPos).stroke();
  yPos += 10;

  doc.fontSize(12).font("Helvetica-Bold");
  doc.text("TOTAL OUTSTANDING", tableLeft, yPos, {
    width: colWidths[0] + colWidths[1] + colWidths[2],
  });
  doc.text(
    formatPKR(grandTotal),
    tableLeft + colWidths[0] + colWidths[1] + colWidths[2],
    yPos,
    {
      width: colWidths[3],
    },
  );
  yPos += 24;

  if (paymentDeadline) {
    doc.fontSize(10).font("Helvetica-Bold");
    doc.text(
      `Please clear all outstanding dues by: ${new Date(paymentDeadline).toLocaleDateString("en-GB")}`,
      tableLeft,
      yPos,
    );
    yPos += 16;
    doc.fontSize(9).font("Helvetica").fillColor("#64748b");
    doc.text(
      "Failure to pay may result in suspension of society services for your plot.",
      tableLeft,
      yPos,
    );
    doc.fillColor("black");
    yPos += 20;
  }

  doc.y = yPos + 6;
  doc.fontSize(11).font("Helvetica-Bold").text("Payment Instructions:");
  doc.fontSize(10).font("Helvetica");
  doc.text("Please deposit your maintenance fee at the KKB4 Society Office.");
  
  doc.moveDown(2);

  // Signature image above the line (right-aligned), then the line + labels.
  const sigRight = 545;
  const imgW = 90;
  const imgH = imgW * SIGNATURE_RATIO;
  // Avoid overflowing the page bottom — start a new page if there isn't room.
  if (doc.y + imgH + 40 > doc.page.height - 50) {
    doc.addPage();
  }
  if (fs.existsSync(SIGNATURE_PATH)) {
    try {
      doc.image(SIGNATURE_PATH, sigRight - imgW, doc.y, { width: imgW });
      doc.y += imgH + 2;
    } catch {
      /* corrupt/unsupported image — fall back to a plain line */
    }
  }
  doc.fillColor("black").fontSize(10).font("Helvetica");
  doc.text("_________________________", 350, doc.y, { align: "right" });
  doc.text("Secretary / Chairman", 350, doc.y + 5, { align: "right" });
  doc.text("KKB4 Housing Society", 350, doc.y + 5, { align: "right" });
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
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(tmpPath);
    doc.pipe(stream);
    renderEnglish(
      doc,
      plot,
      breakdowns,
      grandTotal,
      yearLabel,
      noticeNumber,
      paymentDeadline,
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

function hasNonLatin(text: string): boolean {
  return Array.from(text || "").some((c) => c.charCodeAt(0) > 127);
}

/**
 * Reverse word order for RTL rendering in PDFKit.
 *
 * PDFKit renders glyphs left-to-right regardless of script.  Fontkit shapes
 * each Nastaliq word correctly, but word ORDER stays in Unicode/logical order
 * (first word on the left).  Pre-reversing the word order means PDFKit's LTR
 * placement puts the first logical word on the RIGHT — exactly what an Urdu
 * reader expects.
 *
 * Two separator modes:
 *  - Urdu comma list ("جون، جولائی، ...") → split on "، ", reverse items, rejoin
 *  - Space-separated sentence → split on space, reverse words, rejoin
 */
function rtlWords(text: string): string {
  if (text.includes("، ")) {
    return text.split("، ").reverse().join("، ");
  }
  return text.split(" ").reverse().join(" ");
}

function line(
  doc: PDFKit.PDFDocument,
  str: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "right" | "center" = "left",
): void {
  // Urdu/Arabic strings: pre-reverse word order so LTR rendering is visually RTL.
  // Latin-only strings (numbers, dates, email) are left unchanged.
  const rendered = hasNonLatin(str) ? rtlWords(str) : str;
  doc.text(rendered, x, y, { width, align });
}

function renderUrdu(
  doc: PDFKit.PDFDocument,
  plot: IPlot,
  breakdowns: YearBreakdown[],
  grandTotal: number,
  yearLabel: string,
  noticeNumber: number,
  paymentDeadline?: Date | null,
): void {
  const URDU = URDU_FONT_FAMILY;
  const LATIN = "Helvetica";
  const LATIN_B = "Helvetica-Bold";

  const PAGE_W = mm(210);
  const PAGE_H = mm(297);
  const MARGIN_B = mm(18);
  const LEFT_X = mm(20);
  const RIGHT_X = mm(190);
  const CONTENT_W = mm(170);

  const LH_URDU = mm(8);
  const LABEL_VAL_GAP = mm(3);

  let y = mm(18);

  // ── Masthead ──────────────────────────────────────────────────────────────

  doc.font(URDU).fontSize(18).fillColor(UR_DARK);
  const societyName = "کے کے بی فیز 4 ہاؤسنگ سوسائٹی";
  line(doc, societyName, 0, y, PAGE_W, "center");
  y += mm(10);

  const phone = "03226576614";
  const emailLabel = "ای میل:";
  const emailValue = "admin@kkb4.com";

  doc.font(LATIN).fontSize(9).fillColor(UR_MUTED);
  const emailValueW = doc.widthOfString(emailValue);
  doc.text(emailValue, RIGHT_X - emailValueW, y, { lineBreak: false });
  doc.font(URDU).fontSize(9).fillColor(UR_MUTED);
  const emailLabelW = doc.widthOfString(emailLabel);
  doc.text(emailLabel, RIGHT_X - emailValueW - mm(2) - emailLabelW, y, { lineBreak: false });

  doc.font(LATIN).fontSize(9).fillColor(UR_MUTED);
  doc.text(phone, LEFT_X, y, { lineBreak: false });
  const phoneW = doc.widthOfString(phone);
  doc.font(URDU).fontSize(9).fillColor(UR_MUTED);
  doc.text("فون:", LEFT_X + phoneW + mm(2), y, { lineBreak: false });

  y += mm(9);

  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.3));
  doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
  y += mm(7);

  // ── Title ─────────────────────────────────────────────────────────────────

  const titleText = "واجب الادا فیس نوٹس";
  doc.font(URDU).fontSize(16).fillColor(UR_DARK);
  line(doc, titleText, 0, y, PAGE_W, "center");
  y += mm(11);

  // ── Meta rows ─────────────────────────────────────────────────────────────

  const META_LABEL_W = mm(32);
  const META_VALUE_W = mm(32);

  const metaRow = (labelUr: string, value: string, yPos: number): number => {
    doc.font(URDU).fontSize(10).fillColor(UR_SUBTLE);
    line(doc, labelUr, RIGHT_X - META_LABEL_W, yPos, META_LABEL_W, "right");
    doc.font(LATIN_B).fontSize(10).fillColor(UR_DARK);
    line(
      doc, value,
      RIGHT_X - META_LABEL_W - LABEL_VAL_GAP - META_VALUE_W, yPos,
      META_VALUE_W, "right",
    );
    return yPos + LH_URDU;
  };

  y = metaRow("نوٹس نمبر", String(noticeNumber), y);
  y = metaRow("تاریخ", new Date().toLocaleDateString("en-GB"), y);
  y = metaRow("دورانیہ", yearLabel, y);
  y += mm(4);

  // ── Owner block ───────────────────────────────────────────────────────────

  doc.font(URDU).fontSize(11).fillColor(UR_SOFT_DARK);
  line(doc, "مالک کی تفصیلات", LEFT_X, y, CONTENT_W, "right");
  y += LH_URDU + mm(2);

  const ownerRow = (
    labelUr: string,
    value: string,
    yPos: number,
    valueIsUrdu = false,
  ): number => {
    const labelW = mm(45);
    doc.font(URDU).fontSize(10).fillColor(UR_SUBTLE);
    line(doc, labelUr, RIGHT_X - labelW, yPos, labelW, "right");

    const valueW = RIGHT_X - labelW - LABEL_VAL_GAP - LEFT_X;
    if (valueIsUrdu || hasNonLatin(value)) {
      doc.font(URDU).fontSize(10).fillColor(UR_DARK);
    } else {
      doc.font(LATIN).fontSize(10).fillColor(UR_DARK);
    }
    line(doc, value, LEFT_X, yPos, valueW, "right");
    return yPos + LH_URDU;
  };

  if (plot.ownerName) y = ownerRow("نام", plot.ownerName, y);
  y = ownerRow(
    "پلاٹ نمبر، بلاک، فیز",
    `${plot.plotNumber || "?"} / ${plot.block || "?"} / ${canonicalPhase(plot) || "—"}`,
    y,
  );
  if (plot.ownerPhone) y = ownerRow("فون", plot.ownerPhone, y);
  y = ownerRow(
    "حیثیت",
    URDU_STATUS[plot.allotmentStatus || "Unknown"] || plot.allotmentStatus || "",
    y, true,
  );
  y += mm(5);

  // ── Dues table ────────────────────────────────────────────────────────────

  doc.font(URDU).fontSize(11).fillColor(UR_SOFT_DARK);
  line(doc, "واجب الادا بقایا", LEFT_X, y, CONTENT_W, "right");
  y += LH_URDU + mm(2);

  const colAmount = mm(32);
  const colRate = mm(26);
  const colYear = mm(20);
  const colMonths = CONTENT_W - colAmount - colRate - colYear;
  const colX = [
    LEFT_X,
    LEFT_X + colAmount,
    LEFT_X + colAmount + colRate,
    LEFT_X + colAmount + colRate + colMonths,
  ];
  const colW = [colAmount, colRate, colMonths, colYear];

  const HEADER_H = mm(10);
  const HEADER_PAD = mm(2.2);

  doc.save();
  doc.rect(LEFT_X, y, CONTENT_W, HEADER_H).fill(UR_HEADER_BG);
  doc.restore();
  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.3));
  doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
  doc.moveTo(LEFT_X, y + HEADER_H).lineTo(RIGHT_X, y + HEADER_H).stroke();

  const hY = y + HEADER_PAD;
  const tableHeaders = ["واجب رقم", "ماہانہ شرح", "بقایا مہینے", "سال"];
  for (let i = 0; i < tableHeaders.length; i++) {
    doc.font(URDU).fontSize(9.5).fillColor(UR_SOFT_DARK);
    line(doc, tableHeaders[i], colX[i], hY, colW[i], "center");
  }
  y += HEADER_H + mm(1);

  if (!breakdowns.length) {
    doc.font(URDU).fontSize(10).fillColor(UR_MUTED);
    line(
      doc, "منتخب مدت کے لیے کوئی واجب الادا بقایا نہیں۔",
      LEFT_X, y + mm(4), CONTENT_W, "center",
    );
    y += mm(16);
  } else {
    const ROW_H = mm(10);
    const ROW_PAD = mm(1.8);

    for (let idx = 0; idx < breakdowns.length; idx++) {
      const row = breakdowns[idx];
      const rowTextY = y + ROW_PAD;

      doc.font(LATIN_B).fontSize(10.5).fillColor(UR_DARK);
      line(doc, row.amountDue.toLocaleString("en-US"), colX[0], rowTextY, colW[0], "center");

      doc.font(LATIN).fontSize(10.5).fillColor(UR_DARK);
      line(doc, row.mcRate.toLocaleString("en-US"), colX[1], rowTextY, colW[1], "center");

      doc.font(URDU).fontSize(10).fillColor(UR_DARK);
      line(doc, urduUnpaidMonths(row.unpaidMonths), colX[2], rowTextY, colW[2], "center");

      doc.font(LATIN).fontSize(10.5).fillColor(UR_DARK);
      line(doc, String(row.year), colX[3], rowTextY, colW[3], "center");

      y += ROW_H;

      if (idx < breakdowns.length - 1) {
        doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.15));
        doc.moveTo(LEFT_X, y - mm(0.4)).lineTo(RIGHT_X, y - mm(0.4)).stroke();
      }

      if (y > PAGE_H - MARGIN_B - mm(45)) {
        doc.addPage({ size: "A4", margin: 0 });
        y = mm(18);
      }
    }
  }

  doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.3));
  doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
  y += mm(6);

  // ── Grand total ───────────────────────────────────────────────────────────

  doc.font(URDU).fontSize(12).fillColor(UR_DARK);
  line(doc, "کل واجب الادا رقم", RIGHT_X - mm(60), y, mm(60), "right");

  doc.font(LATIN_B).fontSize(12).fillColor(UR_DARK);
  const digitsStr = `${grandTotal.toLocaleString("en-US")}`;
  const digitsW = doc.widthOfString(digitsStr) + mm(2);
  line(doc, digitsStr, LEFT_X, y, digitsW, "left");
  doc.font(URDU).fontSize(12).fillColor(UR_DARK);
  line(doc, "روپے", LEFT_X + digitsW, y, mm(20), "left");
  y += LH_URDU + mm(3);

  // ── Deadline ──────────────────────────────────────────────────────────────

  if (paymentDeadline) {
    doc.font(URDU).fontSize(10).fillColor(UR_DARK);
    line(
      doc, "براہ کرم تمام بقایا اس تاریخ تک ادا کریں:",
      RIGHT_X - mm(80), y, mm(80), "right",
    );
    doc.font(LATIN_B).fontSize(10).fillColor(UR_DARK);
    line(
      doc, new Date(paymentDeadline).toLocaleDateString("en-GB"),
      LEFT_X, y, mm(30), "left",
    );
    y += LH_URDU + mm(2);
  }
  y += mm(3);

  // ── Payment instructions ──────────────────────────────────────────────────

  doc.font(URDU).fontSize(11).fillColor(UR_SOFT_DARK);
  line(doc, "ادائیگی کی ہدایات", LEFT_X, y, CONTENT_W, "right");
  y += LH_URDU;

  doc.font(URDU).fontSize(10).fillColor(UR_DARK);
  line(
    doc, "براہ کرم اپنی مینٹیننس فیس کے کے بی 4 سوسائٹی آفس میں جمع کروائیں۔",
    LEFT_X, y, CONTENT_W, "right",
  );
  y += mm(8);

  // ── Signature block ───────────────────────────────────────────────────────

  const sigW = mm(60);
  const sigX = RIGHT_X - sigW;
  let sigY = Math.max(y + mm(10), PAGE_H - MARGIN_B - mm(26));

  if (fs.existsSync(SIGNATURE_PATH)) {
    const imgW = mm(24);
    const imgH = imgW * SIGNATURE_RATIO;
    try {
      doc.image(SIGNATURE_PATH, sigX + (sigW - imgW) / 2, sigY - imgH - mm(1), { width: imgW });
    } catch {
      /* corrupt/unsupported image — fall back to a plain line */
    }
  }

  doc.strokeColor(UR_DARK).lineWidth(mm(0.3));
  doc.moveTo(sigX, sigY).lineTo(RIGHT_X, sigY).stroke();

  doc.font(URDU).fontSize(10).fillColor(UR_DARK);
  line(doc, "سیکریٹری، چیئرمین", sigX, sigY + mm(4), sigW, "right");
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
    renderUrdu(
      doc,
      plot,
      breakdowns,
      grandTotal,
      yearLabel,
      noticeNumber,
      paymentDeadline,
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
