/**
 * migratePhases.ts
 * ================
 * Re-derives the `phase` field on every Plot document from the current
 * BLOCK_PHASE_MAP. Run this once after the phase mapping changes (e.g. when
 * Phase 1-6 was consolidated to Phase 1-3).
 *
 * Usage:
 *   npx ts-node src/scripts/migratePhases.ts          # actually update
 *   npx ts-node src/scripts/migratePhases.ts --dry    # preview only
 *
 * The script reports counts per phase and per-plot changes. It uses bulk
 * writes for efficiency on the ~270-plot dataset.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Plot from '../models/Plot';
import { BLOCK_PHASE_MAP } from '../config/constants';

async function main() {
  const dryRun = process.argv.includes('--dry');

  await connectDB();
  console.log(`\nKKB4 — Plot.phase migration${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const plots = await Plot.find({}).lean();
  console.log(`Total plots: ${plots.length}\n`);

  const ops: { updateOne: { filter: any; update: any } }[] = [];
  const changes: Array<{ plotBlock: string; from: string; to: string }> = [];
  const phaseCount: Record<string, number> = {};

  for (const plot of plots) {
    const block = (plot.block || '').toUpperCase();
    const expected = BLOCK_PHASE_MAP[block] || '';
    phaseCount[expected || '(empty)'] = (phaseCount[expected || '(empty)'] || 0) + 1;

    if ((plot.phase || '') !== expected) {
      changes.push({
        plotBlock: plot.plotBlock || `${plot.plotNumber} ${block}`,
        from: plot.phase || '(empty)',
        to: expected || '(empty)',
      });
      ops.push({
        updateOne: {
          filter: { _id: plot._id },
          update: { $set: { phase: expected } },
        },
      });
    }
  }

  console.log('Phase distribution under NEW mapping:');
  for (const [phase, count] of Object.entries(phaseCount).sort()) {
    console.log(`  ${phase.padEnd(12)} ${count} plots`);
  }
  console.log();

  console.log(`Plots requiring update: ${changes.length}`);
  if (changes.length > 0) {
    // Group by (from → to) so the log isn't 200 lines.
    const summary: Record<string, number> = {};
    for (const c of changes) {
      const key = `${c.from} → ${c.to}`;
      summary[key] = (summary[key] || 0) + 1;
    }
    for (const [key, count] of Object.entries(summary).sort()) {
      console.log(`  ${key.padEnd(28)} ${count} plots`);
    }
    console.log();
  }

  if (dryRun) {
    console.log('Dry run — no changes written. Re-run without --dry to apply.\n');
  } else if (ops.length > 0) {
    const result = await Plot.bulkWrite(ops);
    console.log(`✓ Wrote ${result.modifiedCount} updates.\n`);
  } else {
    console.log('✓ Already up to date.\n');
  }

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
