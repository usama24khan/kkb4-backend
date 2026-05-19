import { z } from 'zod';

const monthValue = z.number().nullable().optional();

export const updatePaymentSchema = z.object({
  mcRate: z.number().positive().optional(),
  payments: z.object({
    jan: monthValue, feb: monthValue, mar: monthValue,
    apr: monthValue, may: monthValue, jun: monthValue,
    jul: monthValue, aug: monthValue, sep: monthValue,
    oct: monthValue, nov: monthValue, dec: monthValue,
  }).optional(),
  note: z.string().optional(),
});

export const bulkPaymentSchema = z.object({
  block: z.string().min(1).max(1).toUpperCase(),
  year: z.number().min(2012).max(2030),
  month: z.enum(['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']),
  entries: z.array(z.object({
    plotId: z.string().min(1),
    amount: z.number().min(0),
  })),
});

export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;
export type BulkPaymentInput = z.infer<typeof bulkPaymentSchema>;
