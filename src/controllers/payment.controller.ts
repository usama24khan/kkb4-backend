import { Request, Response } from 'express';
import { PaymentService, LedgerBackedError, type MonthMovement } from '../services/payment.service';
import { updatePaymentSchema, bulkPaymentSchema } from '../validations/payment.validation';
import { sendSuccess, sendError } from '../utils/responseHelper';
import Payment from '../models/Payment';
import { logAudit, monthLabel, money, diffMonths } from '../utils/auditTrail';
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

/**
 * Explains any month the grid refused to reduce. Those months are backed by a
 * recorded payment — income in the cash book and, usually, a receipt in the
 * owner's hand — so the grid leaves them alone and points at the one action that
 * unwinds all three consistently.
 */
function describeBlocked(blocked: Array<{ plotId: string; year: number; month: string; keptAmount: number }>): string {
  if (blocked.length === 0) return '';
  const first = blocked
    .slice(0, 3)
    .map((b) => `${b.month} ${b.year}`)
    .join(', ');
  const more = blocked.length > 3 ? ` and ${blocked.length - 3} more` : '';
  return (
    ` · ${blocked.length} month(s) left unchanged (${first}${more}): a recorded payment covers them. ` +
    `Void that payment in Accounts to reverse the dues, the income and the receipt together.`
  );
}

const parseGridMode = (value: unknown): GridMode => (value === 'live' ? 'live' : 'historical');

/**
 * A refusal to unpick a recorded payment is the caller's mistake to correct, not a
 * server fault — 409 with the reason, so the UI can show it as guidance.
 */
function sendLedgerBacked(res: Response, error: unknown): boolean {
  if (error instanceof LedgerBackedError) {
    sendError(res, error.message, 409);
    return true;
  }
  return false;
}

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

/**
 * Record a grid save as one entry per plot whose months actually moved.
 *
 * A single roll-up entry ("23 plots updated") is not something anyone can check
 * later. Per plot, with each month's before and after, is: a plot's own history
 * then shows the money changes made against it, which is what an audit trail is
 * opened for.
 */
async function auditMonthMovements(
  movements: MonthMovement[],
  adminId: string | undefined,
  context: { block?: string; mode: GridMode; ledgerTotal?: number },
): Promise<void> {
  for (const move of movements) {
    const net = move.months.reduce((sum, m) => sum + (m.to - m.from), 0);
    const monthNames = move.months.map((m) => monthLabel(m.month, move.year)).join(', ');
    const direction = net > 0 ? 'increased' : net < 0 ? 'reduced' : 'changed';
    await logAudit({
      admin: adminId,
      action: 'update',
      entity: 'payment',
      entityId: `${move.plotId}_${move.year}`,
      plot: move.plotId,
      summary:
        `Payments ${direction} by ${money(Math.abs(net))} for ${monthNames}` +
        (context.mode === 'live'
          ? ' — recorded as money received today and added to this month\'s income'
          : ' — entered as an old record, not counted as income'),
      diffs: move.months.map((m) => ({
        field: `payments.${m.month}`,
        from: m.from,
        to: m.to,
      })),
      changes: { year: move.year, block: context.block, mode: context.mode, net },
    });
  }
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

    // Read the record first so the entry can say what the values were.
    const before: any = await Payment.findById(paymentId).select('plot year payments').lean();
    const payment = await PaymentService.update(paymentId, validation.data as any);
    if (!payment) {
      sendError(res, 'Payment not found', 404);
      return;
    }

    const diffs = diffMonths(before?.payments, (payment as any).payments);
    await logAudit({
      admin: req.admin?.id,
      action: 'update',
      entity: 'payment',
      entityId: paymentId,
      plot: String(before?.plot || (payment as any).plot),
      summary: diffs.length
        ? `Edited ${(payment as any).year} payments: ` +
          diffs
            .map(
              (d) =>
                `${monthLabel(d.field.replace('payments.', ''), (payment as any).year)} ` +
                `${money(d.from)} → ${money(d.to)}`,
            )
            .join(', ')
        : `Saved ${(payment as any).year} payments with no month changed`,
      diffs,
      changes: validation.data,
    });

    sendSuccess(res, payment, 'Payment updated');
  } catch (error: any) {
    if (sendLedgerBacked(res, error)) return;
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
    const { results, deltas, blocked, movements } = await PaymentService.bulkUpdate(entries, year, month);

    const ledger = mode === 'live' ? await recordGridLedger(deltas, req.admin?.id) : null;

    await auditMonthMovements(movements, req.admin?.id, {
      block: validation.data.block,
      mode,
      ledgerTotal: ledger?.total,
    });

    sendSuccess(
      res,
      results,
      (ledger
        ? `${results.length} payments updated · PKR ${ledger.total} added to this month's income`
        : `${results.length} payments updated`) + describeBlocked(blocked),
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
    const { results, deltas, blocked, movements } = await PaymentService.bulkUpsertMonths(
      entries,
      parseInt(year),
    );

    const ledger = mode === 'live' ? await recordGridLedger(deltas, req.admin?.id) : null;

    await auditMonthMovements(movements, req.admin?.id, { block, mode, ledgerTotal: ledger?.total });

    sendSuccess(
      res,
      results,
      (ledger
        ? `${results.length} payments updated · PKR ${ledger.total} added to this month's income`
        : `${results.length} payments updated`) + describeBlocked(blocked),
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

    const before: any = await Payment.findOne({ plot: plotId, year }).select('payments').lean();
    const payment = await PaymentService.upsert(plotId, year, req.body);

    const diffs = diffMonths(before?.payments, (payment as any).payments);
    await logAudit({
      admin: req.admin?.id,
      action: before ? 'update' : 'create',
      entity: 'payment',
      entityId: payment._id.toString(),
      plot: plotId,
      summary: diffs.length
        ? `${before ? 'Updated' : 'Created'} ${year} payments: ` +
          diffs
            .map((d) => `${monthLabel(d.field.replace('payments.', ''), year)} ${money(d.from)} → ${money(d.to)}`)
            .join(', ')
        : `${before ? 'Saved' : 'Created'} the ${year} payment record with no month changed`,
      diffs,
      changes: req.body,
    });

    sendSuccess(res, payment, 'Payment saved');
  } catch (error: any) {
    if (sendLedgerBacked(res, error)) return;
    sendError(res, 'Failed to save payment', 500, error.message);
  }
};

export const deletePayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { paymentId } = req.params;
    const before: any = await Payment.findById(paymentId).select('plot year payments totalReceived').lean();
    const deleted = await PaymentService.deletePayment(paymentId);
    if (!deleted) {
      sendError(res, 'Payment not found', 404);
      return;
    }

    await logAudit({
      admin: req.admin?.id,
      action: 'delete',
      entity: 'payment',
      entityId: paymentId,
      plot: String(before?.plot || ''),
      summary:
        `Deleted the whole ${before?.year} payment record` +
        (before?.totalReceived ? `, which held ${money(before.totalReceived)}` : ' (it was empty)'),
      diffs: diffMonths(before?.payments, {}),
      changes: { year: before?.year, totalReceived: before?.totalReceived },
    });

    sendSuccess(res, null, 'Payment record deleted');
  } catch (error: any) {
    if (sendLedgerBacked(res, error)) return;
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

    await logAudit({
      admin: req.admin?.id,
      action: 'void',
      entity: 'payment',
      entityId: paymentId,
      plot: String((result.payment as any)?.plot || ''),
      summary:
        `Voided ${monthLabel(month, (result.payment as any)?.year)} — ${money(result.voidedAmount)} taken off the record` +
        (reason ? `. Reason: ${reason}` : ''),
      diffs: [{ field: `payments.${String(month).toLowerCase()}`, from: result.voidedAmount, to: 0 }],
      changes: { month, voidedAmount: result.voidedAmount, reason: reason || '' },
    });

    sendSuccess(res, result.payment, `${month} voided (PKR ${result.voidedAmount})`);
  } catch (error: any) {
    if (sendLedgerBacked(res, error)) return;
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

    await logAudit({
      admin: req.admin?.id,
      action: 'restore',
      entity: 'payment',
      entityId: paymentId,
      plot: String((result.payment as any)?.plot || ''),
      summary: `Restored ${monthLabel(month, (result.payment as any)?.year)} — ${money(result.restoredAmount)} put back on the record`,
      diffs: [{ field: `payments.${String(month).toLowerCase()}`, from: 0, to: result.restoredAmount }],
      changes: { month, restoredAmount: result.restoredAmount },
    });

    sendSuccess(res, result.payment, `${month} restored (PKR ${result.restoredAmount})`);
  } catch (error: any) {
    sendError(res, 'Failed to restore payment', 500, error.message);
  }
};

/**
 * POST /payments/removal-check
 * Body: { year, entries: [{ plotId, payments: { jan..dec } }] }
 *
 * Answers, before anything is written, which of the intended changes would take
 * money off a month the cash book has already banked. Each one is returned with
 * the detail the admin needs to recognise it — the owner, the month, what is
 * recorded, what they are about to make it, the receipt number and when the
 * money came in — so the confirmation they see names the actual payment rather
 * than warning in the abstract.
 */
export const checkPaymentRemovals = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { year, entries } = req.body || {};
    if (!year || !Array.isArray(entries)) {
      sendError(res, 'year and entries[] are required', 400);
      return;
    }

    const conflicts = await PaymentService.findRemovalConflicts(entries, parseInt(year));
    sendSuccess(
      res,
      { conflicts },
      conflicts.length === 0
        ? 'No recorded payments are affected'
        : `${conflicts.length} month(s) are covered by a recorded payment`,
    );
  } catch (error: any) {
    sendError(res, 'Failed to check payments', 500, error.message);
  }
};
