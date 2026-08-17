import { Router } from 'express';
import {
  getOverview,
  getMonthSummary,
  getYearSummary,
  getYearlySummary,
  listCollections,
  getPlotDues,
  previewAllocation,
  createCollection,
  voidCollectionEntry,
  listExpenses,
  createExpense,
  updateExpense,
  voidExpense,
  copyMonthExpenses,
  listCategories,
  createCategory,
  updateCategory,
  getFinanceSettings,
  updateFinanceSettings,
  getPlotLedger,
} from '../controllers/finance.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';
import { anyAuthMiddleware } from '../middleware/anyAuth.middleware';

const router = Router();

/**
 * Finance routes — the society cash book.
 *
 * Reads go through `anyAuthMiddleware` because the committee and the residents
 * are shown the same accounts; the controller trims admin-only fields (bill
 * attachments, who recorded what) for resident tokens.
 *
 * Every write is admin-only and audit-logged.
 */

// ── Reads (admin app + resident portal) ──────────────────────────────────────
router.get('/overview', anyAuthMiddleware, getOverview);
router.get('/summary', anyAuthMiddleware, getMonthSummary);
router.get('/year', anyAuthMiddleware, getYearSummary);
router.get('/yearly', anyAuthMiddleware, getYearlySummary);
router.get('/collections', anyAuthMiddleware, listCollections);
router.get('/expenses', anyAuthMiddleware, listExpenses);
router.get('/categories', anyAuthMiddleware, listCategories);
router.get('/settings', anyAuthMiddleware, getFinanceSettings);
router.get('/plot/:plotId/ledger', anyAuthMiddleware, getPlotLedger);

// ── Money in (admin) ─────────────────────────────────────────────────────────
router.get('/dues/:plotId', authMiddleware, adminOnly, getPlotDues);
router.post('/allocation-preview', authMiddleware, adminOnly, previewAllocation);
router.post('/collections', authMiddleware, adminOnly, createCollection);
router.post('/collections/:id/void', authMiddleware, adminOnly, voidCollectionEntry);

// ── Money out (admin) ────────────────────────────────────────────────────────
router.post('/expenses', authMiddleware, adminOnly, createExpense);
router.post('/expenses/copy-month', authMiddleware, adminOnly, copyMonthExpenses);
router.put('/expenses/:id', authMiddleware, adminOnly, updateExpense);
router.post('/expenses/:id/void', authMiddleware, adminOnly, voidExpense);

// ── Configuration (admin) ────────────────────────────────────────────────────
router.post('/categories', authMiddleware, adminOnly, createCategory);
router.put('/categories/:id', authMiddleware, adminOnly, updateCategory);
router.put('/settings', authMiddleware, adminOnly, updateFinanceSettings);

export default router;
