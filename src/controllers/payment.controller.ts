import { Request, Response } from 'express';
import { PaymentService } from '../services/payment.service';
import { updatePaymentSchema, bulkPaymentSchema } from '../validations/payment.validation';
import { sendSuccess, sendError } from '../utils/responseHelper';
import AuditLog from '../models/AuditLog';
import { AuthRequest } from '../middleware/auth.middleware';
import { recordCollection } from '../services/finance.service';

/**
 * How a bulk grid save should be treated by the cash book.
 *
 * `historical` (the default) is pure data entry: month buckets are written and
 * nothing reaches the cash book, which is what backfilling 2012-onwards records
 * requires — that money was collected and spent years ago.
 *
 * `live` means the admin is entering money taken today, so each *increase* in a
 * month bucket also becomes a ledger entry counted in the current month. No
 * receipts are issued here; single payments that need one go through
 * POST /finance/collections instead.
 */
type GridMode = 'historical' | 'live';

const parseGridMode = (value: unknown): GridMode => (value === 'live' ? 'live' : 'historical');

/**
 * Turn the increases reported by a bulk save into cash-book entries.
 * Failures are collected rather than thrown: the dues are already saved, and
 * losing the whole response would leave the admin unsure what landed.
 */
async function recordGridLedger(
  deltas: Array<{ plotId: string; allocations: Array<{ year: number; month: string; amount: number }> }>,
  adminId: string | undefined,
): Promise<{ recorded: number; total: number; failed: number }> {
  let recorded = 0;
  let total = 0;
  let failed = 0;

  for (const delta of deltas) {
    const amount = delta.allocations.reduce((sum, a) => sum + a.amount, 0);
    if (amount <= 0) continue;
    try {
      await recordCollection(
        {
          plotId: delta.plotId,
          amount,
          allocations: delta.allocations,
          entryType: 'live',
          // The grid already wrote the month buckets; only the ledger row is needed.
          applyToDues: false,
          generateReceipt: false,
          note: 'Recorded via payments grid',
        },
        adminId,
      );
      recorded += 1;
      total += amount;
    } catch (err) {
      failed += 1;
      console.warn('[payments] grid ledger entry failed:', (err as Error).message);
    }
  }

  return { recorded, total, failed };
}

export const getPaymentByPlotYear = async (req: Request, res: Response): Promise<void> => {
  try {
    const { plotId, year } = req.query;

    if (!plotId || !year) {
      sendError(res, 'plotId and year are required', 400);
      return;
    }

    const payment = await PaymentService.getByPlotAndYear(
      plotId as string,
      parseInt(year as string)
    );

    if (!payment) {
      sendSuccess(res, null, 'No payment record found');
      return;
    }

    sendSuccess(res, payment, 'Payment fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch payment', 500, error.message);
  }
};

export const getPaymentsByPlot = async (req: Request, res: Response): Promise<void> => {
  try {
    const { plotId } = req.params;
    const payments = await PaymentService.getAllByPlot(plotId);
    sendSuccess(res, payments, 'Payments fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch payments', 500, error.message);
  }
};

export const updatePayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentId } = req.params;
    const validation = updatePaymentSchema.safeParse(req.body);

    if (!validation.success) {
      sendError(res, 'Validation failed', 400, validation.error.message);
      return;
    }

    const payment = await PaymentService.update(paymentId, validation.data as any);
    if (!payment) {
      sendError(res, 'Payment not found', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'update',
        entity: 'payment',
        entityId: paymentId,
        changes: validation.data,
      });
    }

    sendSuccess(res, payment, 'Payment updated');
  } catch (error: any) {
    sendError(res, 'Failed to update payment', 500, error.message);
  }
};

export const bulkUpdatePayments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const validation = bulkPaymentSchema.safeParse(req.body);

    if (!validation.success) {
      sendError(res, 'Validation failed', 400, validation.error.message);
      return;
    }

    const { year, month, entries } = validation.data;
    const mode = parseGridMode(req.body?.mode);
    const { results, deltas } = await PaymentService.bulkUpdate(entries, year, month);

    const ledger = mode === 'live' ? await recordGridLedger(deltas, req.admin?.id) : null;

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'bulk_update',
        entity: 'payment',
        entityId: `${validation.data.block}_${year}_${month}`,
        changes: { entriesCount: entries.length, mode, ledger },
      });
    }

    sendSuccess(
      res,
      results,
      ledger
        ? `${results.length} payments updated · PKR ${ledger.total} added to this month's income`
        : `${results.length} payments updated`,
    );
  } catch (error: any) {
    sendError(res, 'Failed to bulk update payments', 500, error.message);
  }
};

/**
 * POST /payments/bulk-all
 * Body: { block?, year, entries: [{ plotId, payments: { jan..dec } }] }
 *
 * Saves the full month map for many plots at once (the "All months" grid).
 */
export const bulkUpdateAllMonths = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { year, entries, block } = req.body || {};
    if (!year || !Array.isArray(entries) || entries.length === 0) {
      sendError(res, 'year and a non-empty entries[] are required', 400);
      return;
    }

    const mode = parseGridMode(req.body?.mode);
    const { results, deltas } = await PaymentService.bulkUpsertMonths(entries, parseInt(year));

    const ledger = mode === 'live' ? await recordGridLedger(deltas, req.admin?.id) : null;

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'bulk_update',
        entity: 'payment',
        entityId: `${block || 'multi'}_${year}_all`,
        changes: { entriesCount: entries.length, scope: 'all-months', mode, ledger },
      });
    }

    sendSuccess(
      res,
      results,
      ledger
        ? `${results.length} payments updated · PKR ${ledger.total} added to this month's income`
        : `${results.length} payments updated`,
    );
  } catch (error: any) {
    sendError(res, 'Failed to bulk update payments', 500, error.message);
  }
};

export const createOrUpdatePayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { plotId, year } = req.body;

    if (!plotId || !year) {
      sendError(res, 'plotId and year are required', 400);
      return;
    }

    const payment = await PaymentService.upsert(plotId, year, req.body);

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'upsert',
        entity: 'payment',
        entityId: payment._id.toString(),
        changes: req.body,
      });
    }

    sendSuccess(res, payment, 'Payment saved');
  } catch (error: any) {
    sendError(res, 'Failed to save payment', 500, error.message);
  }
};

export const deletePayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentId } = req.params;
    const deleted = await PaymentService.deletePayment(paymentId);
    if (!deleted) {
      sendError(res, 'Payment not found', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'delete',
        entity: 'payment',
        entityId: paymentId,
        changes: { deleted: true },
      });
    }

    sendSuccess(res, null, 'Payment record deleted');
  } catch (error: any) {
    sendError(res, 'Failed to delete payment', 500, error.message);
  }
};

/**
 * POST /payments/:paymentId/void
 * Body: { month: 'jan'..'dec', reason?: string }
 *
 * Soft-deletes the recorded amount for one month. The amount is preserved in
 * the payment's `voidedEntries` so it can be restored later via /restore.
 */
export const voidPaymentMonth = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentId } = req.params;
    const { month, reason } = req.body || {};
    if (!month) {
      sendError(res, 'month is required', 400);
      return;
    }

    const result = await PaymentService.voidMonth(paymentId, month, req.admin?.id, reason);
    if (!result) {
      sendError(res, 'Nothing to void (no payment / invalid month / month already empty)', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'void',
        entity: 'payment',
        entityId: paymentId,
        changes: { month, voidedAmount: result.voidedAmount, reason: reason || '' },
      });
    }

    sendSuccess(res, result.payment, `${month} voided (PKR ${result.voidedAmount})`);
  } catch (error: any) {
    sendError(res, 'Failed to void payment', 500, error.message);
  }
};

/**
 * POST /payments/:paymentId/restore
 * Body: { month: 'jan'..'dec' }
 *
 * Restores the most-recent unrestored void for a month. Idempotent across
 * historical voids — calling restore twice picks up the next-oldest void.
 */
export const restorePaymentMonth = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentId } = req.params;
    const { month } = req.body || {};
    if (!month) {
      sendError(res, 'month is required', 400);
      return;
    }

    const result = await PaymentService.restoreMonth(paymentId, month, req.admin?.id);
    if (!result) {
      sendError(res, 'Nothing to restore for this month', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'restore',
        entity: 'payment',
        entityId: paymentId,
        changes: { month, restoredAmount: result.restoredAmount },
      });
    }

    sendSuccess(res, result.payment, `${month} restored (PKR ${result.restoredAmount})`);
  } catch (error: any) {
    sendError(res, 'Failed to restore payment', 500, error.message);
  }
};
