/**
 * backfillComplaintTracking.ts
 * ============================
 * Assigns `trackingNumber` / `trackingNumericId` to Complaint documents created
 * before tracking numbers existed, and seeds `statusHistory` for them.
 *
 * Run once per environment after deploying the tracking-number change. Complaints
 * without a tracking number can't be looked up by residents, and because
 * `trackingNumber` carries a unique index, more than one document with a null
 * value will block that index from building.
 *
 * Usage:
 *   npx ts-node src/scripts/backfillComplaintTracking.ts        # apply
 *   npx ts-node src/scripts/backfillComplaintTracking.ts --dry  # preview only
 *
 * Numbering is assigned oldest-first within each year, continuing from the
 * highest existing id for that year, so already-numbered complaints keep theirs.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Complaint from '../models/Complaint';
import Counter from '../models/Counter';

async function main() {
  const dryRun = process.argv.includes('--dry');

  await connectDB();
  console.log(`\nKKB4 — Complaint tracking-number backfill${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Bypass the model so the pre-validate hook doesn't interfere, and so we can
  // see documents whose trackingNumber is missing entirely.
  const raw = mongoose.connection.collection('complaints');

  const pending = await raw
    .find({ $or: [{ trackingNumber: { $exists: false } }, { trackingNumber: null }, { trackingNumber: '' }] })
    .sort({ createdAt: 1 })
    .toArray();

  console.log(`Complaints needing a tracking number: ${pending.length}`);
  if (pending.length === 0) {
    console.log('Nothing to do.\n');
    await mongoose.disconnect();
    return;
  }

  // Highest already-used id per year, so we continue rather than collide.
  const nextIdByYear = new Map<number, number>();
  for (const doc of pending) {
    const year: number = doc.year || new Date(doc.createdAt || Date.now()).getFullYear();
    if (!nextIdByYear.has(year)) {
      const last = await raw
        .find({ year, trackingNumericId: { $type: 'number' } })
        .sort({ trackingNumericId: -1 })
        .limit(1)
        .toArray();
      nextIdByYear.set(year, (last[0]?.trackingNumericId ?? 0) + 1);
    }
  }

  const ops: any[] = [];
  for (const doc of pending) {
    const year: number = doc.year || new Date(doc.createdAt || Date.now()).getFullYear();
    const nextId = nextIdByYear.get(year)!;
    nextIdByYear.set(year, nextId + 1);

    const trackingNumber = `CMP-${year}-${String(nextId).padStart(4, '0')}`;
    const set: Record<string, any> = { trackingNumber, trackingNumericId: nextId, year };

    // Seed a history entry so the resident's tracking view isn't blank.
    if (!Array.isArray(doc.statusHistory) || doc.statusHistory.length === 0) {
      set.statusHistory = [
        { status: doc.status || 'pending', at: doc.createdAt || new Date() },
      ];
    }

    console.log(`  ${doc.name || '(no name)'} — ${trackingNumber}`);
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
  }

  if (dryRun) {
    console.log(`\nDRY RUN — would update ${ops.length} complaint(s).\n`);
  } else {
    const result = await raw.bulkWrite(ops);
    console.log(`\nUpdated ${result.modifiedCount} complaint(s).`);

    // Point each year's atomic counter at the new maximum, so freshly submitted
    // complaints continue the sequence instead of colliding from 1.
    for (const [year] of nextIdByYear) {
      const last = await raw
        .find({ year, trackingNumericId: { $type: 'number' } })
        .sort({ trackingNumericId: -1 })
        .limit(1)
        .toArray();
      const maxId = last[0]?.trackingNumericId ?? 0;
      await Counter.updateOne(
        { _id: `complaint-${year}` },
        { $set: { seq: maxId } },
        { upsert: true },
      );
      console.log(`Counter complaint-${year} set to ${maxId}.`);
    }

    // Ensure the unique index exists now that every document has a value.
    await Complaint.syncIndexes();
    console.log('Indexes synced.\n');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
