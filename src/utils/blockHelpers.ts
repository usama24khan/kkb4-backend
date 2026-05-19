/**
 * src/utils/blockHelpers.ts
 *
 * The Excel sheet uses a "block header" convention:
 *   - The FIRST plot of each block is written as  "374 A"  (number + letter)
 *   - All following plots in that block are plain numbers:  375, 376, 377 …
 *   - The last plot of each block is also written as  "396 A"  (number + letter)
 *   - The first plot of the next block resets the current block:  "347 B"
 *
 * So the block must be carried forward ("inherited") row by row.
 * Use `createBlockTracker()` in the parser loop instead of calling
 * `extractBlockFromPlotStr()` per row in isolation.
 */

import { ALL_BLOCKS } from "../config/constants";

const BLOCK_LETTERS = new Set(ALL_BLOCKS.map((b) => b.toUpperCase()));

// ── Low-level helpers (still exported for any one-off use) ────────────────────

/**
 * Returns the block letter embedded in a string like "374 A", "292 C", "34  L".
 * Returns null when the string is a plain number with no letter.
 */
export function extractBlockFromPlotStr(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(/^(\d+)\s+([A-Za-z]+)\s*$/);
  if (!m) return null;
  const letter = m[2].toUpperCase();
  return BLOCK_LETTERS.has(letter) ? letter : null;
}

/**
 * Extracts just the numeric plot number from strings like "374 A", "374", 374.
 */
export function extractPlotNumber(raw: string | number): string {
  const s = String(raw).trim();
  const m = s.match(/^(\d+)/);
  return m ? m[1] : s;
}

// ── Stateful tracker (use this in the parser) ─────────────────────────────────

/**
 * Call once before iterating rows, then call `.resolve(plotBlockRaw)` for
 * every data row. Returns { plotNumber, block } with block always filled in.
 *
 * Usage:
 *   const tracker = createBlockTracker();
 *   for (const row of dataRows) {
 *     const { plotNumber, block } = tracker.resolve(row[pbCol]);
 *   }
 */
export function createBlockTracker() {
  let currentBlock: string = "A"; // safe default; overwritten on first real header

  return {
    resolve(raw: unknown): { plotNumber: string; block: string } {
      const s = String(raw ?? "").trim();
      const embeddedBlock = extractBlockFromPlotStr(s);

      if (embeddedBlock) {
        // This row explicitly declares a block — update and use it
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
  };
}
