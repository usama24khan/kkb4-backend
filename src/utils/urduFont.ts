/**
 * urduFont.ts
 * ================================
 * Manages the Noto Nastaliq Urdu font for PDFKit-based Urdu PDF rendering.
 *
 * The font is loaded from backend/scripts/ (same location the Python scripts
 * used). Prefer the static variant (smaller, no variable-axis overhead) and
 * fall back to the regular file.
 *
 * Usage:
 *   import { registerUrduFont, URDU_FONT_FAMILY } from './urduFont';
 *   const doc = new PDFDocument();
 *   registerUrduFont(doc);
 *   doc.font(URDU_FONT_FAMILY).fontSize(20).text('سلام');
 */

import path from 'path';
import fs from 'fs';

/** Font family name used with doc.font(). */
export const URDU_FONT_FAMILY = 'NotoNastaliq';

const SCRIPT_DIR = path.join(__dirname, '../../scripts');

/** Candidate filenames, checked in order of preference. */
const FONT_CANDIDATES = [
  'NotoNastaliqUrdu-Static.ttf',
  'NotoNastaliqUrdu-Regular.ttf',
];

/** Cached result so we only scan the filesystem once. */
let cachedFontPath: string | null | undefined;

/**
 * Resolve the absolute path to a usable Noto Nastaliq Urdu TTF.
 *
 * Resolution order:
 *   1. $URDU_FONT_PATH  (explicit env-var override)
 *   2. <backend>/scripts/NotoNastaliqUrdu-Static.ttf
 *   3. <backend>/scripts/NotoNastaliqUrdu-Regular.ttf
 *
 * Returns `null` when no font file is found (caller decides whether to throw).
 */
export function findUrduFontPath(): string | null {
  if (cachedFontPath !== undefined) return cachedFontPath;

  // 1. Env-var override
  const envPath = process.env.URDU_FONT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    cachedFontPath = envPath;
    return cachedFontPath;
  }

  // 2–3. Script-dir candidates
  for (const name of FONT_CANDIDATES) {
    const p = path.join(SCRIPT_DIR, name);
    if (fs.existsSync(p)) {
      cachedFontPath = p;
      return cachedFontPath;
    }
  }

  // 4. Glob fallback — any NotoNastaliqUrdu*.ttf in the scripts dir
  try {
    const files = fs.readdirSync(SCRIPT_DIR);
    const match = files.find(
      (f) => f.startsWith('NotoNastaliqUrdu') && f.endsWith('.ttf'),
    );
    if (match) {
      cachedFontPath = path.join(SCRIPT_DIR, match);
      return cachedFontPath;
    }
  } catch {
    // scripts dir may not exist in some test environments
  }

  cachedFontPath = null;
  return null;
}

/**
 * Register the Noto Nastaliq Urdu font on a PDFKit document.
 * After calling this, use `doc.font(URDU_FONT_FAMILY)` to switch to the font.
 *
 * Throws if the font file cannot be found.
 */
export function registerUrduFont(doc: PDFKit.PDFDocument): void {
  const fontPath = findUrduFontPath();
  if (!fontPath) {
    throw new Error(
      'Noto Nastaliq Urdu font not found. ' +
        'Place NotoNastaliqUrdu-Regular.ttf (or -Static.ttf) in backend/scripts/. ' +
        'Download from: https://fonts.google.com/noto/specimen/Noto+Nastaliq+Urdu',
    );
  }
  doc.registerFont(URDU_FONT_FAMILY, fontPath);
}
