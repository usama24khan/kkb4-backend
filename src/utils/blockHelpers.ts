import { BLOCK_PHASE_MAP } from '../config/constants';

/**
 * Extract block letter from a plot+block string
 * "374 A" → "A", "293 C" → "C", "375" → "UNKNOWN"
 */
export function extractBlockFromPlotStr(plotBlock: string): string {
  if (!plotBlock) return 'UNKNOWN';
  const str = plotBlock.toString().trim();
  const match = str.match(/\s+([A-L])$/i);
  if (match) return match[1].toUpperCase();
  // Try last character
  const lastChar = str.slice(-1).toUpperCase();
  if (/[A-L]/.test(lastChar) && str.length > 1) {
    return lastChar;
  }
  return 'UNKNOWN';
}

/**
 * Extract plot number from a plot+block string
 * "374 A" → "374", "293 C" → "293"
 */
export function extractPlotNumber(plotBlock: string): string {
  if (!plotBlock) return '';
  const str = plotBlock.toString().trim();
  const match = str.match(/^(\d+)/);
  return match ? match[1] : str;
}

/**
 * Get phase number from block letter
 */
export function getPhaseFromBlock(block: string): number {
  return BLOCK_PHASE_MAP[block.toUpperCase()] ?? 0;
}
