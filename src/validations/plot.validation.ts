import { z } from 'zod';

export const createPlotSchema = z.object({
  srNo: z.number().optional(),
  ownerName: z.string().min(1, 'Owner name is required').trim(),
  plotNumber: z.string().min(1, 'Plot number is required').trim(),
  block: z.string().min(1).max(1).toUpperCase(),
  allotmentStatus: z.enum(['Active', 'Cancelled', 'Unsold', 'Unknown']).default('Active'),
});

export const updatePlotSchema = z.object({
  ownerName: z.string().min(1).trim().optional(),
  plotNumber: z.string().min(1).trim().optional(),
  block: z.string().min(1).max(1).toUpperCase().optional(),
  allotmentStatus: z.enum(['Active', 'Cancelled', 'Unsold', 'Unknown']).optional(),
  isActive: z.boolean().optional(),
});

export type CreatePlotInput = z.infer<typeof createPlotSchema>;
export type UpdatePlotInput = z.infer<typeof updatePlotSchema>;
