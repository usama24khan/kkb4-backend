/**
 * Receipt durability checks.  `npm run check:receipts`
 * ============================================================================
 *
 * The retention plan (RECEIPTS_NOTICES_PLAN.md) keeps receipt PDFs for a year
 * and then deletes them, on the claim that the database alone can reproduce the
 * slip. These checks hold that claim to account, plus the numbering guarantee it
 * depends on:
 *
 *   1. numbering is atomic — twenty receipts created at once get twenty distinct
 *      consecutive numbers, with no duplicate-key failures
 *   2. numbering continues an existing series rather than restarting
 *   3. a purged receipt regenerates, and the regenerated slip is the SAME
 *      document — compared byte for byte, with only the PDF's own creation
 *      timestamp and file id masked out
 *   4. voiding stamps the slip, so the paper cannot disagree with the record
 *
 * It creates receipts and deletes them again, so it refuses to run against
 * production.
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Plot from '../models/Plot';
import Receipt from '../models/Receipt';
import Counter from '../models/Counter';
import { fetchOrRebuildReceiptPdf } from '../utils/receiptPdfGenerator';
import { deleteFromCloudinary } from '../lib/deleteFromCloudinary';
import { isCloudinaryConfigured } from '../lib/cloudinary';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** Read a stream into a buffer. */
async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Fingerprint a PDF's *content*, ignoring what legitimately differs between two
 * renders of the same document: when it was rendered.
 *
 * PDFKit writes that timestamp as its own indirect object — `15 0 obj
 * (D:20260917214205Z)` — not as an inline `/CreationDate`, so the date string
 * itself is what has to be masked. Its length is fixed, so masking does not
 * shift the byte offsets the xref table records.
 */
function contentHash(pdf: Buffer): string {
  const masked = pdf
    .toString('latin1')
    .replace(/\(D:\d{14}Z?\)/g, '(D:MASKED)')
    .replace(/\/ID\s*\[[^\]]*\]/g, '/ID [MASKED]');
  return crypto.createHash('sha256').update(masked, 'latin1').digest('hex');
}

const TEST_YEAR = 2099; // far from real data, so the counter and rows are ours

(async () => {
  if (!isCloudinaryConfigured()) {
    console.error('Cloudinary is not configured — the regeneration check needs it.');
    process.exit(1);
  }

  await connectDB();
  const dbName = mongoose.connection.name;
  if (process.env.NODE_ENV === 'production' || /prod/i.test(dbName)) {
    console.error(`Refusing to run against "${dbName}": these checks create and delete receipts.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`database: ${dbName}\n`);

  const plot: any = await Plot.findOne({ isActive: true }).lean();
  const made: any[] = [];

  const base = () => ({
    year: TEST_YEAR,
    month: 'January',
    language: 'en' as const,
    plotRef: plot._id,
    blockNo: plot.block,
    plotNo: plot.plotNumber,
    ownerName: plot.ownerName,
    amount: 4800,
    paymentDate: new Date('2099-01-14'),
    coveredMonths: [{ year: TEST_YEAR, month: 'jan' }],
    societyName: 'KKB Housing Society',
  });

  try {
    // ── 1 + 2. numbering under concurrency
    const first = await Receipt.create(base());
    made.push(first);
    check('a receipt gets a number', /^KKB-2099-\d{4}$/.test(first.receiptNumber), first.receiptNumber);

    const concurrent = await Promise.allSettled(
      Array.from({ length: 20 }, () => Receipt.create(base())),
    );
    const created = concurrent
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);
    made.push(...created);
    const rejected = concurrent.filter((r) => r.status === 'rejected');

    check('20 concurrent receipts all succeed', rejected.length === 0,
      `${created.length} created, ${rejected.length} failed`);

    const ids = created.map((r) => r.receiptNumericId).sort((a, b) => a - b);
    check('every number is distinct', new Set(ids).size === ids.length,
      `${new Set(ids).size} distinct of ${ids.length}`);
    check('numbers are consecutive', ids.every((n, i) => i === 0 || n === ids[i - 1] + 1),
      `${ids[0]}…${ids[ids.length - 1]}`);
    check('the series continued from the first receipt',
      ids[0] === first.receiptNumericId + 1,
      `first ${first.receiptNumericId}, then ${ids[0]}`);

    // ── 3. a purged receipt comes back identical
    const subject = made[0];
    const original = await fetchOrRebuildReceiptPdf(subject);
    const originalBytes = await drain(original.object.body);
    const originalHash = contentHash(originalBytes);
    check('the slip renders', originalBytes.length > 1000 &&
      originalBytes.subarray(0, 4).toString() === '%PDF', `${originalBytes.length} bytes`);

    // An unreachable object, database untouched. Pointed at a public_id that
    // does not exist rather than deleting the real one: a just-deleted
    // Cloudinary object can still be served from CDN cache for a while, which
    // would make this check pass or fail depending on timing.
    const stored = subject.filePath;
    await Receipt.updateOne(
      { _id: subject._id },
      { $set: { filePath: stored.replace(/\.pdf$/, '__missing.pdf') } },
    );
    const orphaned: any = await Receipt.findById(subject._id);
    const again = await fetchOrRebuildReceiptPdf(orphaned);
    const againBytes = await drain(again.object.body);

    check('an unreachable PDF is rebuilt, not reported as an error',
      again.rebuilt && againBytes.length > 1000,
      `rebuilt=${again.rebuilt}, ${againBytes.length} bytes`);
    check('the regenerated slip is the same document',
      contentHash(againBytes) === originalHash,
      contentHash(againBytes) === originalHash
        ? 'identical apart from the render timestamp'
        : `${originalHash.slice(0, 12)} vs ${contentHash(againBytes).slice(0, 12)}`);

    // What the retention job actually leaves behind: no cached path at all.
    await Receipt.updateOne({ _id: subject._id }, { $set: { filePath: '' } });
    const cleared: any = await Receipt.findById(subject._id);
    const fromCleared = await fetchOrRebuildReceiptPdf(cleared);
    const clearedBytes = await drain(fromCleared.object.body);
    check('a receipt with no cached path regenerates',
      contentHash(clearedBytes) === originalHash,
      `${clearedBytes.length} bytes`);

    // ── 4. voiding changes the paper too
    const toVoid: any = await Receipt.findById(made[1]._id);
    const beforeVoid = contentHash(await drain((await fetchOrRebuildReceiptPdf(toVoid)).object.body));
    toVoid.isVoided = true;
    toVoid.voidReason = 'Durability check';
    toVoid.filePath = '';
    await toVoid.save();
    const afterVoid = contentHash(await drain((await fetchOrRebuildReceiptPdf(toVoid)).object.body));
    check('a voided slip renders differently from a valid one', beforeVoid !== afterVoid);
  } catch (err: any) {
    // Surfaced rather than thrown: an opaque unhandled rejection here tells
    // nobody which check broke.
    check('checks ran to completion', false, err?.message || JSON.stringify(err).slice(0, 300));
  } finally {
    // ── cleanup: remove the test receipts, their PDFs, and the test counter
    for (const r of made) {
      const fresh: any = await Receipt.findById(r._id).lean();
      if (fresh?.filePath) await deleteFromCloudinary(fresh.filePath).catch(() => {});
      await Receipt.deleteOne({ _id: r._id });
    }
    await Counter.deleteOne({ _id: `receipt-${TEST_YEAR}` });
    console.log(`\ncleaned up ${made.length} test receipts`);
    console.log(`${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
  }

  process.exit(fail ? 1 : 0);
})();
