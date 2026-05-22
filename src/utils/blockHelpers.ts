/**
 * src/utils/blockHelpers.ts
 *
 * The Excel sheet uses a "block header" convention:
 *   - The FIRST plot of each block is written as  "374 A"  (number + space + letter)
 *   - All following plots in that block are plain numbers:  375, 376, 377 …
 *   - The last plot of each block is also written as  "396 A"  (number + space + letter)
 *   - The first plot of the next block resets the current block:  "347 B"
 *   - Section headers like "Block A" are also handled and used to update the tracker
 *
 * So the block must be carried forward ("inherited") row by row.
 * Use `createBlockTracker()` in the parser loop instead of calling
 * `extractBlockFromPlotStr()` per row in isolation.
 */

import { ALL_BLOCKS } from "../config/constants";

const BLOCK_LETTERS = new Set(ALL_BLOCKS.map((b) => b.toUpperCase()));

// ── Low-level helpers ─────────────────────────────────────────────────────────

/**
 * Returns the block letter embedded in a string like:
 *   "374 A"   → "A"
 *   "292 C"   → "C"
 *   "Block A" → "A"
 *   "374"     → null  (plain number, inherit from tracker)
 *   "374A"    → "A"   (no space variant — also handled)
 */
export function extractBlockFromPlotStr(raw: string): string | null {
  const s = raw.trim();

  // Format 1: "374 A" — number, optional space, letter(s)
  const m1 = s.match(/^(\d+)\s+([A-Za-z]+)\s*$/);
  if (m1) {
    const letter = m1[2].toUpperCase();
    return BLOCK_LETTERS.has(letter) ? letter : null;
  }

  // Format 2: "374A" — number immediately followed by letter (no space)
  const m2 = s.match(/^(\d+)([A-Za-z]+)$/);
  if (m2) {
    const letter = m2[2].toUpperCase();
    return BLOCK_LETTERS.has(letter) ? letter : null;
  }

  // Format 3: "Block A" or "BLOCK B" — section header rows
  const m3 = s.match(/^[Bb][Ll][Oo][Cc][Kk]\s+([A-Za-z]+)$/);
  if (m3) {
    const letter = m3[1].toUpperCase();
    return BLOCK_LETTERS.has(letter) ? letter : null;
  }

  return null;
}

/**
 * Extracts just the numeric plot number from strings like:
 *   "374 A" → "374"
 *   "374"   → "374"
 *   374     → "374"
 *   "374A"  → "374"
 */
export function extractPlotNumber(raw: string | number): string {
  const s = String(raw).trim();
  const m = s.match(/^(\d+)/);
  return m ? m[1] : s;
}

/**
 * Returns true if this raw cell value is a block section header row
 * (e.g. "Block A", "BLOCK B") — used to skip it from data output
 * while still updating the tracker.
 */
export function isBlockHeaderRow(raw: string): boolean {
  return /^[Bb][Ll][Oo][Cc][Kk]\s+[A-Za-z]+$/.test(raw.trim());
}

// ── Stateful tracker ──────────────────────────────────────────────────────────

/**
 * Call once before iterating rows of a sheet, then call `.resolve(plotBlockRaw)`
 * for every data row. Returns { plotNumber, block } with block always filled in.
 *
 * Usage:
 *   const tracker = createBlockTracker();
 *   for (const row of dataRows) {
 *     const { plotNumber, block } = tracker.resolve(row[pbCol]);
 *   }
 */
export function createBlockTracker() {
  let currentBlock: string = ""; // empty until first block letter seen

  return {
    resolve(raw: unknown): { plotNumber: string; block: string } {
      const s = String(raw ?? "").trim();
      const embeddedBlock = extractBlockFromPlotStr(s);

      if (embeddedBlock) {
        // This row explicitly declares a block — update tracker
        currentBlock = embeddedBlock;
      }
      // Otherwise keep currentBlock as-is (inherited from previous row)

      return {
        plotNumber: extractPlotNumber(s),
        block: currentBlock,
      };
    },

    /** Read the currently tracked block without advancing */
    get currentBlock() {
      return currentBlock;
    },

    /** Reset the tracker (useful between sheets) */
    reset() {
      currentBlock = "";
    },
  };
}
