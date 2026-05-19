import { Request, Response } from 'express';
import { PaymentService } from '../services/payment.service';
import { updatePaymentSchema, bulkPaymentSchema } from '../validations/payment.validation';
import { sendSuccess, sendError } from '../utils/responseHelper';
import AuditLog from '../models/AuditLog';
import { AuthRequest } from '../middleware/auth.middleware';

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
    const results = await PaymentService.bulkUpdate(entries, year, month);

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'bulk_update',
        entity: 'payment',
        entityId: `${validation.data.block}_${year}_${month}`,
        changes: { entriesCount: entries.length },
      });
    }

    sendSuccess(res, results, `${results.length} payments updated`);
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
