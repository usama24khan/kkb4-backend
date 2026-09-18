import { Router } from 'express';
import authRoutes from './auth.routes';
import plotRoutes from './plot.routes';
import paymentRoutes from './payment.routes';
import blockRoutes from './block.routes';
import phaseRoutes from './phase.routes';
import statsRoutes from './stats.routes';
import noticeRoutes from './notice.routes';
import receiptRoutes from './receipt.routes';
import importRoutes from './import.routes';
import analyticsRoutes from './analytics.routes';
import configRoutes from './config.routes';
import auditLogRoutes from './auditLog.routes';
import userAuthRoutes from './userAuth.routes';
import complaintRoutes from './complaint.routes';
import aiQueryRoutes from './aiQuery.routes';
import publicDocumentRoutes from './publicDocument.routes';
import financeRoutes from './finance.routes';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { isCloudinaryConfigured } from '../lib/cloudinary';

const router = Router();

router.use('/auth', authRoutes);
router.use('/plots', plotRoutes);
router.use('/payments', paymentRoutes);
router.use('/blocks', blockRoutes);
router.use('/phases', phaseRoutes);
router.use('/stats', statsRoutes);
router.use('/notices', noticeRoutes);
router.use('/receipts', receiptRoutes);
router.use('/import', importRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/config', configRoutes);
router.use('/audit-log', auditLogRoutes);
router.use('/user-auth', userAuthRoutes);
router.use('/complaints', complaintRoutes);
router.use('/ai', aiQueryRoutes);
router.use('/public', publicDocumentRoutes);
router.use('/finance', financeRoutes);

/**
 * Health check, including which optional integrations this deployment can
 * actually reach.
 *
 * Environment variables are per-environment on Vercel and their values are
 * hidden in the dashboard, so "is storage configured in production?" was a
 * question nobody could answer by looking — and the honest answer matters:
 * without storage, receipts are recorded but their PDFs cannot be stored or
 * regenerated. Booleans only. No names, no values, nothing that helps anyone
 * who should not have them.
 */
router.get('/health', (_req, res) => {
  const configured = {
    // 1 = connected, per mongoose's readyState.
    database: mongoose.connection.readyState === 1,
    // PDF storage for receipts and notices.
    storage: isCloudinaryConfigured(),
    // The AI database chat.
    ai: Boolean(env.GROQ_API_KEY),
    // OTP delivery for admin sign-in.
    email: Boolean(env.EMAIL_FROM && env.EMAIL_APP_PASSWORD),
  };

  res.json({
    success: true,
    message: 'KKB4 API is running',
    environment: env.NODE_ENV,
    database: mongoose.connection.name || null,
    configured,
    timestamp: new Date().toISOString(),
  });
});

export default router;
