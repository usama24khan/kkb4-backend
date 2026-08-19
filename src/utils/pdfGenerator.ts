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
  doc.text(`Contact: ${SOCIETY_PHONE}`, { align: "center" });
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
    yPos += 20;
  }

  doc.y = yPos + 6;
  doc.fontSize(11).font("Helvetica-Bold").text("Payment Instructions:");
  doc.fontSize(10).font("Helvetica");
  doc.text("Please deposit your maintenance fee at the KKB4 Society Office.");

  // The same note the Urdu notice carries, under the same heading, so a resident
  // handed either version reads the same warning.
  doc.moveDown(0.8);
  doc.fontSize(11).font("Helvetica-Bold").text("Important Note:");
  doc.fontSize(10).font("Helvetica");
  doc.text(
    "If payment is not received by the date above, society services for this plot may be " +
      "suspended. Always collect a receipt — a payment without a receipt is not recorded.",
  );
  
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
 * The Urdu notice, laid out as an official Pakistani letter.
 *
 * Modelled on the form these notices actually take: a masthead naming the office
 * it comes from, a rule, the date and letter number beneath it, an underlined
 * subject, then the matter itself as prose. No table — the dues are stated as
 * lines, each given in Urdu and in English so either reader can check the
 * figures, which is how a society notice gets read in practice.
 *
 * Every Urdu string is drawn through `line()`, which reverses word order so a
 * left-to-right renderer produces right-to-left text; prose is broken into lines
 * beforehand by `wrapUrdu`, because letting PDFKit wrap already-reversed text
 * would order the lines backwards.
 */
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
  const LEFT_X = mm(20);
  const RIGHT_X = mm(190);
  const CONTENT_W = RIGHT_X - LEFT_X;

  // Nastaliq needs a taller line than a Latin face at the same size, and this is
  // a letter rather than a form — it should breathe.
  const LH = mm(10);
  const LH_TIGHT = mm(8.5);

  let y = mm(18);

  /** One Urdu line, right-aligned across the full width. */
  const ur = (text: string, size = 12, colour = UR_DARK, x = LEFT_X, w = CONTENT_W) => {
    doc.font(URDU).fontSize(size).fillColor(colour);
    line(doc, text, x, y, w, "right");
  };

  /** Urdu prose, wrapped and drawn line by line. */
  const paragraph = (text: string, size = 12, lh = LH, colour = UR_DARK) => {
    doc.font(URDU).fontSize(size).fillColor(colour);
    for (const l of wrapUrdu(doc, text, CONTENT_W)) {
      line(doc, l, LEFT_X, y, CONTENT_W, "right");
      y += lh;
    }
  };

  /** English prose, wrapped by PDFKit — no direction to worry about. */
  const english = (text: string, size = 9.5, colour = UR_SOFT_DARK, bold = false) => {
    doc.font(bold ? LATIN_B : LATIN).fontSize(size).fillColor(colour);
    doc.text(text, LEFT_X, y, { width: CONTENT_W, align: "left" });
    y = doc.y + mm(1.5);
  };

  // ── Masthead: which office this comes from ────────────────────────────────

  doc.font(URDU).fontSize(17).fillColor(UR_DARK);
  line(doc, "از دفتر جنرل سیکریٹری کے کے بی فیز 4 ہاؤسنگ سوسائٹی", LEFT_X, y, CONTENT_W, "center");
  y += mm(15);

  doc.strokeColor(UR_DARK).lineWidth(mm(0.6));
  doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
  y += mm(5);

  // ── Date (right) and letter number (left) ────────────────────────────────

  const dateStr = new Date().toLocaleDateString("en-GB");
  // Each of these is one string rather than a label plus a value in a
  // width-measured box: the Latin run keeps its own order inside an Urdu line,
  // and there is no box to overflow.
  doc.font(URDU).fontSize(11).fillColor(UR_DARK);
  line(doc, `مورخہ: ${dateStr}`, LEFT_X, y, CONTENT_W, "right");
  line(doc, `مراسلہ نمبر: ${noticeNumber}`, LEFT_X, y, CONTENT_W / 2, "right");
  y += mm(12);

  // ── Subject ───────────────────────────────────────────────────────────────

  doc.font(URDU).fontSize(11).fillColor(UR_DARK);
  const subjLabelW = doc.widthOfString(forPdf("عنوان:۔"));
  line(doc, "عنوان:۔", RIGHT_X - subjLabelW, y, subjLabelW, "right");

  doc.font(URDU).fontSize(16).fillColor(UR_DARK);
  const titleW = doc.widthOfString(forPdf("نوٹس"));
  const titleX = (PAGE_W - titleW) / 2;
  doc.text(forPdf("نوٹس"), titleX, y - mm(2), { lineBreak: false });
  // The underline the form always carries beneath the subject.
  doc.strokeColor(UR_DARK).lineWidth(mm(0.4));
  doc.moveTo(titleX - mm(2), y + mm(7)).lineTo(titleX + titleW + mm(2), y + mm(7)).stroke();
  y += mm(16);

  // ── Who this concerns ─────────────────────────────────────────────────────

  const phase = canonicalPhase(plot) || "";
  const owner = plot.ownerName || "";
  paragraph(
    `جناب ${owner} صاحب، پلاٹ نمبر ${plot.plotNumber || "?"}، بلاک ${plot.block || "?"}` +
      `${phase ? `، ${phase}` : ""} کے مالک/قابض ہیں۔`,
  );
  if (plot.ownerPhone) {
    y += mm(3);
    doc.font(URDU).fontSize(11).fillColor(UR_MUTED);
    line(doc, `فون نمبر: ${plot.ownerPhone}`, LEFT_X, y, CONTENT_W, "right");
    y += LH;
  }
  y += mm(5);

  paragraph(
    `آپ کی مینٹیننس فیس مندرجہ ذیل عرصے (${yearLabel}) کی واجب الادا ہے۔ ` +
      `تفصیل درج ذیل ہے:`,
  );
  y += mm(3);

  // ── The dues, stated as lines in both languages ───────────────────────────

  if (!breakdowns.length) {
    paragraph("مذکورہ مدت کے لیے کوئی رقم واجب الادا نہیں ہے۔");
    english("No maintenance dues are outstanding for this period.");
  } else {
    for (const row of breakdowns) {
      const months = row.unpaidMonths.length;
      const amount = row.amountDue.toLocaleString("en-US");

      // Urdu on the right, its English counterpart on the left of the same line.
      doc.font(URDU).fontSize(12).fillColor(UR_DARK);
      const urText =
        months === 12
          ? `سال ${row.year}: پورا سال — ${amount} روپے`
          : `سال ${row.year}: ${months} ماہ — ${amount} روپے`;
      line(doc, urText, PAGE_W / 2 - mm(6), y, CONTENT_W / 2 + mm(16) - mm(6), "right");

      doc.font(LATIN).fontSize(10).fillColor(UR_SOFT_DARK);
      const enText =
        months === 12
          ? `${row.year}: full year — PKR ${amount}`
          : `${row.year}: ${months} month${months === 1 ? "" : "s"} — PKR ${amount}`;
      doc.text(enText, LEFT_X, y + mm(2), { width: CONTENT_W / 2, align: "left", lineBreak: false });

      y += LH_TIGHT + mm(1.5);
    }

    y += mm(2);
    doc.strokeColor(UR_LINE_GREY).lineWidth(mm(0.3));
    doc.moveTo(LEFT_X, y).lineTo(RIGHT_X, y).stroke();
    y += mm(5);

    doc.font(URDU).fontSize(13).fillColor(UR_DARK);
    line(doc, `کل واجب الادا رقم: ${grandTotal.toLocaleString("en-US")} روپے`,
      PAGE_W / 2 - mm(6), y, CONTENT_W / 2 + mm(16) - mm(6), "right");
    doc.font(LATIN_B).fontSize(11).fillColor(UR_DARK);
    doc.text(`Total outstanding: PKR ${grandTotal.toLocaleString("en-US")}`, LEFT_X, y + mm(2), {
      width: CONTENT_W / 2, align: "left", lineBreak: false,
    });
    y += LH + mm(3);
  }

  // ── Deadline ──────────────────────────────────────────────────────────────

  if (paymentDeadline) {
    const deadline = new Date(paymentDeadline).toLocaleDateString("en-GB");
    paragraph(`براہ کرم مذکورہ رقم ${deadline} تک سوسائٹی آفس میں جمع کروائیں۔`);
    y += mm(1);
    english(`Please clear the above amount at the society office by ${deadline}.`);
    y += mm(4);
  }

  // ── Important note, in both languages ─────────────────────────────────────

  y += mm(2);
  doc.font(URDU).fontSize(12.5).fillColor(UR_DARK);
  const noteHeadW = doc.widthOfString(forPdf("اہم نوٹ:۔"));
  line(doc, "اہم نوٹ:۔", RIGHT_X - noteHeadW, y, noteHeadW, "right");
  y += LH;

  paragraph(
    "مقررہ تاریخ تک ادائیگی نہ ہونے کی صورت میں سوسائٹی کی سہولیات معطل کی جا سکتی ہیں۔ " +
      "ادائیگی کے بعد رسید ضرور حاصل کریں، کیونکہ رسید کے بغیر ادائیگی کا اندراج نہیں ہوتا۔",
    11.5,
    mm(9.5),
  );
  y += mm(4);

  doc.font(LATIN_B).fontSize(10).fillColor(UR_DARK);
  doc.text("Important Note:", LEFT_X, y, { width: CONTENT_W, align: "left" });
  y = doc.y + mm(1);
  english(
    "If payment is not received by the date above, society services for this plot may be " +
      "suspended. Always collect a receipt — a payment without a receipt is not recorded.",
  );
  y += mm(4);

  // ── Contact ───────────────────────────────────────────────────────────────

  doc.font(LATIN_B).fontSize(11).fillColor(UR_DARK);
  doc.text(`Whats App No. ${SOCIETY_PHONE}`, LEFT_X, y, { width: CONTENT_W, align: "left" });
  y = doc.y + mm(4);

  // ── Signature, bottom right ───────────────────────────────────────────────

  const sigW = mm(60);
  const sigX = RIGHT_X - sigW;
  const sigImgW = mm(18);
  const sigImgH = sigImgW * SIGNATURE_RATIO;
  // The image sits above the line, so the line has to clear the last line of
  // text by the image's height plus a margin.
  const sigY = Math.max(y + sigImgH + mm(5), PAGE_H - mm(18) - mm(26));

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

  doc.font(URDU).fontSize(11).fillColor(UR_DARK);
  line(doc, "جنرل سیکریٹری", sigX, sigY + mm(3), sigW, "right");
  doc.font(URDU).fontSize(10).fillColor(UR_SOFT_DARK);
  line(doc, "کے کے بی فیز 4 ہاؤسنگ سوسائٹی", sigX, sigY + mm(11), sigW, "right");

  if (process.env.NOTICE_LAYOUT_DEBUG === "1") {
    const asMm = (v: number) => (v / mm(1)).toFixed(1);
    console.log(
      `[notice layout] content ends ${asMm(y)}mm · signature line ${asMm(sigY)}mm` +
        ` · footer ends ${asMm(sigY + mm(16))}mm · page 297mm`,
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
