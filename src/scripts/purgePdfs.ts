/**
 * PDF retention job.  `npm run purge:pdfs` (report only) / `-- --apply`
 * ============================================================================
 *
 * Storage is the one cost in this system that grows forever if nothing removes
 * anything, and it sits on a free hosting tier. Two rules keep it flat:
 *
 *   receipts — keep the PDF 365 days, then delete it. The receipt itself is kept
 *     forever in MongoDB, and `receiptPdfGenerator` rebuilds the slip from that
 *     row alone (it reads no Plot and no Payment), so a purged receipt is a
 *     cache miss: the next request regenerates it, identical to the original.
 *     This is why the regenerate-on-miss path in receipt.controller must be
 *     working before this job is ever run with --apply.
 *
 *   notices — keep the PDF 180 days, then delete it and stamp `pdfsPurgedAt`.
 *     Notices are working paperwork, not financial records. The row stays as the
 *     record that an owner was served, when, and for how much; the letter itself
 *     is NOT reproducible afterwards, because the per-plot dues breakdown it
 *     printed was never stored and dues move as payments arrive. That trade was
 *     made deliberately — see RECEIPTS_NOTICES_PLAN.md.
 *
 * Safety:
 *   - report-only by default; deletes nothing without `--apply`
 *   - batched (`--limit`), idempotent, and safe to interrupt — whatever it does
 *     not reach tonight it reaches tomorrow
 *   - a storage deletion that fails leaves the database untouched, so the row is
 *     retried next run rather than pointing at a file that is still there
 */

import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Receipt from '../models/Receipt';
import Notice from '../models/Notice';
import { deleteFromCloudinary } from '../lib/deleteFromCloudinary';
import { isCloudinaryConfigured } from '../lib/cloudinary';

const RECEIPT_KEEP_DAYS = Number(process.env.RECEIPT_PDF_KEEP_DAYS || 365);
const NOTICE_KEEP_DAYS = Number(process.env.NOTICE_PDF_KEEP_DAYS || 180);

const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10)) : 500;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** Delete one stored object, reporting whether it is now gone. */
async function removeObject(url: string): Promise<boolean> {
  if (!apply) return true;
  try {
    await deleteFromCloudinary(url);
    return true;
  } catch (err: any) {
    // A 404 means it was already gone, which is the state we wanted anyway.
    const notFound = err?.http_code === 404 || /not found/i.test(err?.message || '');
    if (!notFound) console.warn(`   ! ${url}: ${err?.message || err}`);
    return notFound;
  }
}

async function purgeReceipts(): Promise<void> {
  const cutoff = daysAgo(RECEIPT_KEEP_DAYS);
  const due = await Receipt.find({
    createdAt: { $lt: cutoff },
    filePath: { $nin: ['', null] },
  })
    .select('receiptNumber filePath createdAt')
    .sort({ createdAt: 1 })
    .limit(LIMIT);

  const total = await Receipt.countDocuments({
    createdAt: { $lt: cutoff },
    filePath: { $nin: ['', null] },
  });

  console.log(
    `\nreceipts older than ${RECEIPT_KEEP_DAYS} days with a cached PDF: ${total}` +
      (total > due.length ? ` (handling ${due.length} this run)` : ''),
  );

  let cleared = 0;
  for (const receipt of due) {
    const ok = await removeObject(receipt.filePath);
    if (!ok) continue;
    if (apply) {
      // Cleared only after the object is gone, so an interrupted run leaves a
      // row that still points at a real file rather than one that lies.
      await Receipt.updateOne({ _id: receipt._id }, { $set: { filePath: '' } });
    }
    cleared++;
    if (cleared <= 5) console.log(`   ${receipt.receiptNumber} → PDF removed (regenerates on request)`);
  }
  if (cleared > 5) console.log(`   … and ${cleared - 5} more`);
  console.log(`   ${apply ? 'purged' : 'would purge'} ${cleared}`);
}

async function purgeNotices(): Promise<void> {
  const cutoff = daysAgo(NOTICE_KEEP_DAYS);
  const query = { createdAt: { $lt: cutoff }, pdfsPurgedAt: null };
  const due = await Notice.find(query)
    .select('noticeNumber targetLabel pdfPath pdfPaths createdAt')
    .sort({ createdAt: 1 })
    .limit(LIMIT);
  const total = await Notice.countDocuments(query);

  console.log(
    `\nnotices older than ${NOTICE_KEEP_DAYS} days still holding PDFs: ${total}` +
      (total > due.length ? ` (handling ${due.length} this run)` : ''),
  );

  let cleared = 0;
  let files = 0;
  for (const notice of due) {
    const urls = [...new Set([notice.pdfPath, ...(notice.pdfPaths || [])].filter(Boolean))];
    let allGone = true;
    for (const url of urls) {
      const ok = await removeObject(url);
      if (ok) files++;
      else allGone = false;
    }
    if (!allGone) continue;
    if (apply) {
      await Notice.updateOne(
        { _id: notice._id },
        { $set: { pdfPath: '', pdfPaths: [], pdfsPurgedAt: new Date() } },
      );
    }
    cleared++;
    if (cleared <= 5) {
      console.log(
        `   notice ${notice.noticeNumber ?? '—'} (${notice.targetLabel || '?'}) → ` +
          `${urls.length} file(s) removed, row kept`,
      );
    }
  }
  if (cleared > 5) console.log(`   … and ${cleared - 5} more`);
  console.log(`   ${apply ? 'purged' : 'would purge'} ${cleared} notices, ${files} files`);
}

(async () => {
  if (!isCloudinaryConfigured()) {
    console.error('Cloudinary is not configured — nothing to purge from.');
    process.exit(1);
  }

  await connectDB();
  console.log(`database: ${mongoose.connection.name}`);
  console.log(apply ? 'mode: APPLY (files will be deleted)' : 'mode: report only (use --apply to delete)');

  await purgeReceipts();
  await purgeNotices();

  if (!apply) {
    console.log('\nNothing was deleted. Re-run with --apply once the numbers look right.');
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error('purge failed:', err);
  process.exit(1);
});
