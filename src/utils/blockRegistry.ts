/**
 * src/utils/blockRegistry.ts
 *
 * Single source of truth for "which blocks/phases exist" at runtime.
 *
 * Blocks and phases started life as hardcoded constants (config/constants.ts).
 * Admins can now register new ones, stored in the Block / Phase collections.
 * Every reader should go through these helpers so the constants and the
 * DB-backed extensions are always merged consistently. Constants win on
 * conflict (they are the authoritative legacy mapping).
 */

import Block from '../models/Block';
import Phase from '../models/Phase';
import {
  PHASE_BLOCK_MAP,
  BLOCK_PHASE_MAP,
  ALL_PHASES,
} from '../config/constants';

export interface PhaseWithBlocks {
  name: string;
  blocks: string[];
}

export interface BlockEntry {
  code: string;
  phase: string;
}

/**
 * block (uppercase) → phase, merging constants with DB blocks.
 * Constants take precedence so legacy plots never change phase.
 */
export async function getBlockPhaseMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const dbBlocks = await Block.find({ isActive: true }).lean();
  for (const b of dbBlocks) map[b.code.toUpperCase()] = b.phase;
  // Constants are authoritative — apply last so they overwrite any DB collision.
  Object.assign(map, BLOCK_PHASE_MAP);
  return map;
}

/**
 * Resolve the phase for a single block code. Constants first, then DB.
 * Returns '' when the block is unknown.
 */
export async function resolvePhaseForBlock(code: string): Promise<string> {
  const up = code.toUpperCase();
  if (BLOCK_PHASE_MAP[up]) return BLOCK_PHASE_MAP[up];
  const b = await Block.findOne({ code: up, isActive: true }).lean();
  return b?.phase || '';
}

/** True if the block exists in either constants or DB. */
export async function blockExists(code: string): Promise<boolean> {
  const up = code.toUpperCase();
  if (BLOCK_PHASE_MAP[up]) return true;
  return !!(await Block.findOne({ code: up, isActive: true }).lean());
}

/** True if the phase exists in either constants or DB. */
export async function phaseExists(name: string): Promise<boolean> {
  if (ALL_PHASES.includes(name)) return true;
  return !!(await Phase.findOne({ name, isActive: true }).lean());
}

/**
 * The full merged structure used to populate admin dropdowns:
 *   { phases: [{ name, blocks }], blocks: [{ code, phase }] }
 */
export async function getStructure(): Promise<{
  phases: PhaseWithBlocks[];
  blocks: BlockEntry[];
}> {
  const [dbPhases, dbBlocks] = await Promise.all([
    Phase.find({ isActive: true }).lean(),
    Block.find({ isActive: true }).lean(),
  ]);

  // Merged block → phase (constants authoritative)
  const blockPhase: Record<string, string> = {};
  for (const b of dbBlocks) blockPhase[b.code.toUpperCase()] = b.phase;
  Object.assign(blockPhase, BLOCK_PHASE_MAP);

  // All phase names: constants ∪ DB phases ∪ phases referenced by blocks
  const phaseNames = new Set<string>(ALL_PHASES);
  dbPhases.forEach((p) => phaseNames.add(p.name));
  Object.values(blockPhase).forEach((p) => p && phaseNames.add(p));

  // Group blocks by phase
  const blocksByPhase: Record<string, string[]> = {};
  for (const [code, phase] of Object.entries(blockPhase)) {
    (blocksByPhase[phase] ||= []).push(code);
  }
  // Ensure constant phase→block lists are reflected even if empty in blockPhase
  for (const [phase, blocks] of Object.entries(PHASE_BLOCK_MAP)) {
    const set = new Set(blocksByPhase[phase] || []);
    blocks.forEach((b) => set.add(b.toUpperCase()));
    blocksByPhase[phase] = [...set];
  }

  const phases: PhaseWithBlocks[] = [...phaseNames]
    .sort()
    .map((name) => ({ name, blocks: (blocksByPhase[name] || []).sort() }));

  const blocks: BlockEntry[] = Object.entries(blockPhase)
    .map(([code, phase]) => ({ code, phase }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return { phases, blocks };
}
