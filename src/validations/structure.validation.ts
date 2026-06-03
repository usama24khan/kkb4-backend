import { z } from 'zod';

/** Register a new phase (e.g. "Phase 4", "Commercial"). */
export const createPhaseSchema = z.object({
  name: z.string().min(1, 'Phase name is required').trim(),
});

/** Register a new block, linked to a phase (built-in or DB-backed). */
export const createBlockSchema = z.object({
  code: z.string().min(1, 'Block code is required').max(20).trim().toUpperCase(),
  phase: z.string().min(1, 'Phase is required').trim(),
});

export type CreatePhaseInput = z.infer<typeof createPhaseSchema>;
export type CreateBlockInput = z.infer<typeof createBlockSchema>;
