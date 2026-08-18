import { Router } from 'express';
import {
  getPaymentByPlotYear,
  getPaymentsByPlot,
  updatePayment,
  bulkUpdatePayments,
  bulkUpdateAllMonths,
  createOrUpdatePayment,
  deletePayment,
  voidPaymentMonth,
  restorePaymentMonth,
  checkPaymentRemovals,
} from '../controllers/payment.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';

const router = Router();

router.get('/', getPaymentByPlotYear);
router.get('/plot/:plotId', getPaymentsByPlot);
router.put('/:paymentId', authMiddleware, adminOnly, updatePayment);
router.delete('/:paymentId', authMiddleware, adminOnly, deletePayment);
// Read-only pre-flight: what a save would contradict, before it is written.
router.post('/removal-check', authMiddleware, adminOnly, checkPaymentRemovals);
router.post('/bulk', authMiddleware, adminOnly, bulkUpdatePayments);
router.post('/bulk-all', authMiddleware, adminOnly, bulkUpdateAllMonths);
router.post('/:paymentId/void', authMiddleware, adminOnly, voidPaymentMonth);
router.post('/:paymentId/restore', authMiddleware, adminOnly, restorePaymentMonth);
router.post('/', authMiddleware, adminOnly, createOrUpdatePayment);

export default router;
