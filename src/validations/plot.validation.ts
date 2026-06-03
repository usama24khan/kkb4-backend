import { z } from 'zod';

export const createPlotSchema = z.object({
  srNo: z.number().optional(),
  ownerName: z.string().min(1, 'Owner name is required').trim(),
  plotNumber: z.string().min(1, 'Plot number is required').trim(),
  block: z.string().min(1, 'Block is required').max(20).trim().toUpperCase(),
  // Phase is normally derived from the block on the server. It is accepted here
  // only as an optional hint for custom (DB-backed) blocks; the service
  // re-resolves it through the block registry when omitted.
  phase: z.string().trim().optional(),
  allotmentStatus: z.enum(['Active', 'Cancelled', 'Unsold', 'Unknown']).default('Active'),
  ownerPhone: z.string().trim().optional(),
  ownerCnic: z.string().trim().optional(),
  monthlyChargeOverride: z.number().nullable().optional(),
});

export const updatePlotSchema = z.object({
  ownerName: z.string().min(1).trim().optional(),
  plotNumber: z.string().min(1).trim().optional(),
  block: z.string().min(1).max(20).toUpperCase().optional(),
  allotmentStatus: z.enum(['Active', 'Cancelled', 'Unsold', 'Unknown']).optional(),
  isActive: z.boolean().optional(),
  ownerPhone: z.string().trim().optional(),
  ownerCnic: z.string().trim().optional(),
  monthlyChargeOverride: z.number().nullable().optional(),
});

export type CreatePlotInput = z.infer<typeof createPlotSchema>;
export type UpdatePlotInput = z.infer<typeof updatePlotSchema>;
