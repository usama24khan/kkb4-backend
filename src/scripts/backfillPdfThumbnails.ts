/**
 * backfillPdfThumbnails.ts
 * ========================
 * Creates the `image`-type companion copy for PDFs that were uploaded before
 * link-preview thumbnails existed, so their landing pages can show a real page-1
 * `og:image` instead of the placeholder.
 *
 * Cloudinary will not apply image transformations to a `raw` asset — requesting
 * `/image/upload/<raw id>.jpg` answers "Resource not found" — so each PDF needs a
 * second upload under the same public_id with resource_type=image. See
 * lib/cloudinary.ts (THUMBNAIL_RESOURCE_TYPE).
 *
 * Usage:
 *   npx ts-node src/scripts/backfillPdfThumbnails.ts        # apply
 *   npx ts-node src/scripts/backfillPdfThumbnails.ts --dry  # preview only
 *
 * Safe to re-run: uploads use overwrite:true, and assets that already have a
 * working thumbnail are skipped.
 */
import https from 'https';
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Receipt from '../models/Receipt';
import Notice from '../models/Notice';
import { uploadPdfThumbnailSource } from '../lib/uploadToCloudinary';
import { buildPdfThumbnailUrl, publicIdFromUrl } from '../lib/cloudinary';

/** HEAD-ish check: does this URL already deliver a real image? */
function deliversImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        res.resume();
        const type = String(res.headers['content-type'] || '');
        // Cloudinary answers errors with a 1x1 image/gif placeholder.
        resolve(res.statusCode === 200 && type.startsWith('image/') && type !== 'image/gif');
      })
      .on('error', () => resolve(false));
  });
}

/** Download the PDF bytes so we can re-upload them under the image namespace. */
function fetchBytes(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} -> ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry');

  await connectDB();
  console.log(`\nKKB4 — PDF thumbnail backfill${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const cloudinaryHosted = { $regex: 'res\\.cloudinary\\.com' };

  const [receipts, notices] = await Promise.all([
    Receipt.find({ filePath: cloudinaryHosted }).select('receiptNumber filePath').lean(),
    Notice.find({ pdfPath: cloudinaryHosted }).select('targetLabel pdfPath').lean(),
  ]);

  const targets = [
    ...receipts.map((r) => ({ label: r.receiptNumber || '(receipt)', url: r.filePath as string })),
    ...notices.map((n) => ({ label: `notice ${n.targetLabel || ''}`.trim(), url: n.pdfPath as string })),
  ];

  // Local-path notices predate the Cloudinary migration; their files aren't
  // reachable, so no thumbnail is possible and their pages use the placeholder.
  const skippedLocal = await Notice.countDocuments({ pdfPath: { $regex: '^/' } });

  console.log(`Cloudinary-hosted PDFs found: ${targets.length}`);
  console.log(`  receipts: ${receipts.length}`);
  console.log(`  notices:  ${notices.length}`);
  if (skippedLocal) {
    console.log(`Skipping ${skippedLocal} notice(s) stored as local filesystem paths (no Cloudinary asset).`);
  }
  console.log('');

  // De-duplicate: the same PDF can be referenced by more than one record.
  const byPublicId = new Map<string, { label: string; url: string }>();
  for (const t of targets) {
    const id = publicIdFromUrl(t.url);
    if (id && !byPublicId.has(id)) byPublicId.set(id, t);
  }

  let created = 0;
  let already = 0;
  let failed = 0;

  for (const [publicId, { label }] of byPublicId) {
    const thumbUrl = buildPdfThumbnailUrl(publicId);
    if (!thumbUrl) {
      console.log(`  ⚠️  ${label}: could not derive a thumbnail URL — skipped`);
      failed++;
      continue;
    }

    if (await deliversImage(thumbUrl)) {
      already++;
      continue;
    }

    if (dryRun) {
      console.log(`  would upload image copy: ${publicId}`);
      created++;
      continue;
    }

    try {
      const bytes = await fetchBytes(
        `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/${publicId}`,
      );
      const ok = await uploadPdfThumbnailSource(bytes, publicId);
      if (!ok) throw new Error('upload returned false');

      const works = await deliversImage(thumbUrl);
      console.log(`  ${works ? '✅' : '⚠️ '} ${label} → ${works ? 'thumbnail live' : 'uploaded but not delivering yet'}`);
      works ? created++ : failed++;
    } catch (err) {
      console.log(`  ❌ ${label}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log('\n───────────────────────────────────────────────────────────');
  console.log(`${dryRun ? 'Would create' : 'Created'}: ${created}   already had one: ${already}   failed: ${failed}`);
  console.log('Records with no Cloudinary asset keep the placeholder og:image.\n');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
