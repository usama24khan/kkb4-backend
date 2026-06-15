/**
 * pdfGenerator.ts
 * ================================
 * Generates maintenance-notice PDFs for KKB4 Housing Society.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Language  │  Renderer                                               │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  English   │  PDFKit                                                 │
 * │  Urdu      │  Python (fpdf2 + uharfbuzz + Noto Nastaliq Urdu)        │
 * │            │  HarfBuzz handles OpenType GSUB shaping so the          │
 * │            │  Nastaliq letters join correctly.                       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * One-time server setup (from <backend>/):
 *   npm run setup:urdu     # creates .venv, installs deps, runs self-test
 *
 * Drop NotoNastaliqUrdu-Regular.ttf (or its variable-axis variant) in
 *   backend/scripts/   — or set URDU_FONT_PATH=/absolute/path/to/font.ttf
 *
 * Download font from:
 *   https://fonts.google.com/noto/specimen/Noto+Nastaliq+Urdu
 */

import PDFDocument from 'pdfkit';
import { MONTHS, MONTH_NAMES, getMcRateForYear, BLOCK_PHASE_MAP } from '../config/constants';
import { IPlot } from '../models/Plot';
import { IPaymentMonths } from '../models/Payment';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { uploadToCloudinary } from '../lib/uploadToCloudinary';

/**
 * Return the canonical phase for a plot using the current BLOCK_PHASE_MAP.
 * Falls back to the stored `plot.phase` if the block isn't mapped (which
 * shouldn't happen, but is safe). This makes notices immune to stale phase
 * values left in the DB from before a phase-mapping change — they'll always
 * show the correct phase even if the migration script hasn't been run.
 */
function canonicalPhase(plot: IPlot): string {
  const block = (plot.block || '').toUpperCase();
  return BLOCK_PHASE_MAP[block] || plot.phase || '';
}

const execFileAsync = promisify(execFile);

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
async function uploadNoticeAndCleanup(tmpPath: string, yearLabel: string): Promise<string> {
  try {
    const url = await uploadToCloudinary(tmpPath, noticeKey(path.basename(tmpPath), yearLabel));
    return url;
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

/**
 * Absolute path to the Python notice generator script.
 * If you move the .py file, update this constant.
 */
const PYTHON_SCRIPT = path.join(__dirname, '../../scripts/generate_urdu_notice.py');

// Society signature image (shared with the receipt generator). Optional — if
// missing, the notice falls back to a plain signature line.
const SIGNATURE_PATH = path.join(__dirname, '../../signature/signature.png');
const SIGNATURE_RATIO = 414 / 603; // height / width of signature.png

/**
 * Resolve the Python 3 interpreter to use.
 *
 * Priority order:
 *   1. $PYTHON_BIN env var (explicit override)
 *   2. <backend>/.venv/bin/python3 (project-local venv — recommended)
 *   3. system 'python3' on PATH
 *
 * The project-local venv is the most reliable path because it isolates the
 * Urdu rendering deps (reportlab, arabic-reshaper, python-bidi) from whatever
 * Python the server happens to have on PATH. Run `npm run setup:urdu` to
 * create it.
 */
function resolvePythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython = path.join(__dirname, '../../.venv/bin/python3');
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
}

const PYTHON_BIN = resolvePythonBin();

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
  unpaidMonths: string[];   // ['mar', 'jun', 'sep', 'dec']
  amountDue: number;
}

export interface NoticeInput {
  plot: IPlot;
  payments: PaymentRecordLike[];
  yearFrom: number;
  yearTo: number;
  noticeNumber: number;
  language?: 'en' | 'ur';
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
  return `PKR ${Math.round(n).toLocaleString('en-PK')}`;
}

function formatUnpaidMonthsEn(months: string[]): string {
  if (months.length === 0) return '—';
  if (months.length === 12) return 'All 12 months';
  const indexes = months.map((m) => MONTHS.indexOf(m as any));
  const isRun =
    indexes.length > 1 &&
    indexes.every((v, i) => i === 0 || v === indexes[i - 1] + 1);
  if (isRun) {
    return `${MONTH_NAMES[months[0]].slice(0, 3)}–${MONTH_NAMES[months[months.length - 1]].slice(0, 3)} (${months.length})`;
  }
  return months.map((m) => MONTH_NAMES[m].slice(0, 3)).join(', ');
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
  doc.fontSize(20).font('Helvetica-Bold').text('KKB4 Housing Society', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text('Maintenance Fee Collection Office', { align: 'center' });
  doc.text('Contact: admin@kkb4.com', { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown();

  doc.fontSize(14).font('Helvetica-Bold').text('MAINTENANCE DUE NOTICE', { align: 'center' });
  doc.moveDown(0.5);

  doc.fontSize(10).font('Helvetica');
  doc.text(`Notice No: ${noticeNumber}`);
  doc.text(`Date: ${new Date().toLocaleDateString('en-GB')}`);
  doc.text(`Covering: ${yearLabel}`);
  doc.moveDown();

  doc.fontSize(11).font('Helvetica-Bold').text('Owner Details:');
  doc.fontSize(10).font('Helvetica');
  doc.text(`Name: ${plot.ownerName || '—'}`);
  doc.text(`Plot Number: ${plot.plotNumber} | Block: ${plot.block} | Phase: ${canonicalPhase(plot) || '—'}`);
  if (plot.ownerPhone) doc.text(`Phone: ${plot.ownerPhone}`);
  doc.text(`Status: ${plot.allotmentStatus}`);
  doc.moveDown();

  doc.fontSize(11).font('Helvetica-Bold').text('Outstanding Dues');
  doc.moveDown(0.4);

  const tableLeft = 50;
  const tableRight = 545;
  const colWidths = [60, 230, 80, 105];
  const headers = ['Year', 'Months Unpaid', 'Rate/Mo', 'Amount Due'];

  const headerY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold');
  let xPos = tableLeft;
  headers.forEach((h, i) => {
    doc.text(h, xPos, headerY, { width: colWidths[i] });
    xPos += colWidths[i];
  });
  doc.moveTo(tableLeft, headerY + 16).lineTo(tableRight, headerY + 16).stroke();

  doc.font('Helvetica');
  let yPos = headerY + 22;

  if (breakdowns.length === 0) {
    doc.fillColor('#059669').text('No outstanding dues for the selected period.', tableLeft, yPos);
    doc.fillColor('black');
    yPos += 24;
  } else {
    for (const row of breakdowns) {
      xPos = tableLeft;
      doc.text(String(row.year), xPos, yPos, { width: colWidths[0] });
      xPos += colWidths[0];
      doc.text(formatUnpaidMonthsEn(row.unpaidMonths), xPos, yPos, { width: colWidths[1] });
      xPos += colWidths[1];
      doc.text(formatPKR(row.mcRate), xPos, yPos, { width: colWidths[2] });
      xPos += colWidths[2];
      doc.text(formatPKR(row.amountDue), xPos, yPos, { width: colWidths[3] });
      yPos += 18;
      if (yPos > 720) { doc.addPage(); yPos = 50; }
    }
  }

  doc.moveTo(tableLeft, yPos).lineTo(tableRight, yPos).stroke();
  yPos += 10;

  doc.fontSize(12).font('Helvetica-Bold');
  doc.text('TOTAL OUTSTANDING', tableLeft, yPos, {
    width: colWidths[0] + colWidths[1] + colWidths[2],
  });
  doc.text(formatPKR(grandTotal), tableLeft + colWidths[0] + colWidths[1] + colWidths[2], yPos, {
    width: colWidths[3],
  });
  yPos += 24;

  if (paymentDeadline) {
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text(
      `Please clear all outstanding dues by: ${new Date(paymentDeadline).toLocaleDateString('en-GB')}`,
      tableLeft, yPos,
    );
    yPos += 16;
    doc.fontSize(9).font('Helvetica').fillColor('#64748b');
    doc.text('Failure to pay may result in suspension of society services for your plot.', tableLeft, yPos);
    doc.fillColor('black');
    yPos += 20;
  }

  doc.y = yPos + 6;
  doc.fontSize(11).font('Helvetica-Bold').text('Payment Instructions:');
  doc.fontSize(10).font('Helvetica');
  doc.text('Please deposit your maintenance fee at the KKB4 Society Office.');
  doc.text('Office Hours: Monday–Saturday, 9:00 AM – 5:00 PM');
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
  doc.fillColor('black').fontSize(10).font('Helvetica');
  doc.text('_________________________', 350, doc.y, { align: 'right' });
  doc.text('Secretary / Chairman', 350, doc.y + 5, { align: 'right' });
  doc.text('KKB4 Housing Society', 350, doc.y + 5, { align: 'right' });
}

// ─── English PDF generator ───────────────────────────────────────────────────

function generateEnglishPDF(input: NoticeInput): Promise<NoticeResult> {
  const { plot, payments, yearFrom, yearTo, noticeNumber, paymentDeadline } = input;
  const { breakdowns, grandTotal } = computeBreakdown(payments, yearFrom, yearTo);
  const yearLabel = yearFrom === yearTo ? `${yearFrom}` : `${yearFrom}-${yearTo}`;
  const fileName = `notice_${noticeNumber}_${plot.plotBlock.replace(/\s/g, '_')}_${yearLabel}.pdf`;
  const tmpPath = path.join(NOTICES_DIR, fileName);

  // Render to the temp file first…
  const renderToTmp = new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(tmpPath);
    doc.pipe(stream);
    renderEnglish(doc, plot, breakdowns, grandTotal, yearLabel, noticeNumber, paymentDeadline);
    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });

  // …then upload to Cloudinary and clean up the temp file.
  return renderToTmp.then(async () => {
    const url = await uploadNoticeAndCleanup(tmpPath, yearLabel);
    return { pdfPath: url, amountDue: grandTotal, breakdowns };
  });
}

// ─── Urdu PDF generator (Python subprocess) ──────────────────────────────────

/**
 * Build the JSON payload for the Python script and invoke it.
 * The Python script writes the PDF and prints the output path to stdout.
 */
async function generateUrduPDF(input: NoticeInput): Promise<NoticeResult> {
  const { plot, payments, yearFrom, yearTo, noticeNumber, paymentDeadline } = input;
  const { breakdowns, grandTotal } = computeBreakdown(payments, yearFrom, yearTo);
  const yearLabel = yearFrom === yearTo ? `${yearFrom}` : `${yearFrom}-${yearTo}`;
  const fileName = `notice_${noticeNumber}_${plot.plotBlock.replace(/\s/g, '_')}_${yearLabel}_ur.pdf`;
  const filePath = path.join(NOTICES_DIR, fileName);

  const payload = {
    outputPath: filePath,
    noticeNumber,
    yearLabel,
    date: new Date().toLocaleDateString('en-GB'),
    paymentDeadline: paymentDeadline
      ? new Date(paymentDeadline).toLocaleDateString('en-GB')
      : null,
    plot: {
      ownerName:        plot.ownerName   || '',
      plotNumber:       String(plot.plotNumber),
      block:            plot.block,
      phase:            canonicalPhase(plot) || '—',
      ownerPhone:       plot.ownerPhone   || '',
      allotmentStatus:  plot.allotmentStatus,
    },
    breakdowns: breakdowns.map((b) => ({
      year:          b.year,
      mcRate:        b.mcRate,
      unpaidMonths:  b.unpaidMonths,
      amountDue:     b.amountDue,
    })),
    grandTotal,
    signaturePath: fs.existsSync(SIGNATURE_PATH) ? SIGNATURE_PATH : '',
  };

  // Sanity-check the Python script is on disk before spawning. This catches the
  // common "I haven't pulled the new files" / "wrong cwd" failure with a clear
  // error message instead of an obscure ENOENT from execFile.
  if (!fs.existsSync(PYTHON_SCRIPT)) {
    throw new Error(
      `Urdu generator script not found at ${PYTHON_SCRIPT}. ` +
      `Make sure backend/scripts/generate_urdu_notice.py exists.`,
    );
  }

  // Write payload to a temp file so we don't worry about shell escaping
  const payloadPath = path.join(NOTICES_DIR, `_payload_${noticeNumber}_${Date.now()}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf-8');

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_BIN,
      [PYTHON_SCRIPT, '--file', payloadPath],
      { timeout: 60_000 },
    );

    if (stderr?.trim()) {
      // Python prints warnings to stderr; only treat DEPENDENCY_ERROR as fatal
      if (stderr.includes('DEPENDENCY_ERROR')) {
        throw new Error(`Urdu generator: ${stderr.trim()}`);
      }
      console.warn('[pdfGenerator] Python stderr:', stderr.trim());
    }

    const outPath = stdout.trim() || filePath;

    // Verify the PDF was actually written — Python could have exited 0 with no
    // output if it silently aborted.
    if (!fs.existsSync(outPath)) {
      throw new Error(
        `Urdu generator finished but no PDF was written at ${outPath}. ` +
        `stderr: ${stderr?.trim() || '(none)'}`,
      );
    }

    // Upload the Python-rendered PDF to Cloudinary and remove the local temp copy.
    const url = await uploadNoticeAndCleanup(outPath, yearLabel);
    return { pdfPath: url, amountDue: grandTotal, breakdowns };
  } catch (err: any) {
    // Re-throw with the subprocess's stderr included — execFile's default
    // error message truncates it and the controller's 500 response becomes
    // useless without context.
    if (err && (err.stderr || err.stdout)) {
      const detail = [err.stderr, err.stdout].filter(Boolean).join('\n').trim();
      const reason = detail || err.message || 'Unknown error';
      // ENOENT on spawn typically means python3 isn't on PATH.
      if (err.code === 'ENOENT') {
        throw new Error(
          `Cannot spawn '${PYTHON_BIN}'. Install Python 3 or set PYTHON_BIN env var. ${reason}`,
        );
      }
      throw new Error(`Urdu generator failed: ${reason}`);
    }
    throw err;
  } finally {
    // Clean up temp payload file
    fs.unlink(payloadPath, () => {});
  }
}

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * Run the Python Urdu pipeline's self-test. Useful as a startup pre-flight
 * so the admin knows immediately whether Urdu notice generation will work.
 *
 * Returns an `ok` flag and a one-line status string suitable for logging.
 */
export async function urduPipelineHealth(): Promise<{ ok: boolean; status: string }> {
  if (!fs.existsSync(PYTHON_SCRIPT)) {
    return { ok: false, status: `script missing at ${PYTHON_SCRIPT}` };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_BIN,
      [PYTHON_SCRIPT, '--self-test'],
      { timeout: 30_000 },
    );
    if (stderr?.trim() && !stdout.includes('OK')) {
      return { ok: false, status: stderr.trim().split('\n')[0] };
    }
    const fontLine = stdout.split('\n').find((l) => l.includes('Font:')) || '';
    return { ok: true, status: fontLine.trim() || 'OK' };
  } catch (err: any) {
    const detail =
      (err?.stderr && err.stderr.trim()) ||
      err?.message ||
      'Unknown error';
    if (err?.code === 'ENOENT') {
      return { ok: false, status: `cannot spawn '${PYTHON_BIN}' (Python 3 not on PATH)` };
    }
    return { ok: false, status: detail.split('\n')[0] };
  }
}

/**
 * Generate a maintenance-notice PDF for a single plot.
 *
 * - English  → rendered by PDFKit (fast, no extra deps).
 * - Urdu     → rendered by Python (properly shaped Nastaliq Urdu).
 */
export async function generatePlotNotice(input: NoticeInput): Promise<NoticeResult> {
  if (input.language === 'ur') {
    return generateUrduPDF(input);
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
  language: 'en' | 'ur' = 'en',
  paymentDeadline?: Date | null,
): Promise<NoticeResult[]> {
  // For Urdu notices run 3 at a time (Python processes are heavier than PDFKit).
  const CONCURRENCY = language === 'ur' ? 3 : plotsWithPayments.length;

  const results: NoticeResult[] = [];
  for (let i = 0; i < plotsWithPayments.length; i += CONCURRENCY) {
    const batch = plotsWithPayments.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((item, idx) =>
        generatePlotNotice({
          plot:          item.plot,
          payments:      item.payments,
          yearFrom,
          yearTo,
          noticeNumber:  startNoticeNumber + i + idx,
          language,
          paymentDeadline,
        }),
      ),
    );
    results.push(...batchResults);
  }
  return results;
}