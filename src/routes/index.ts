import { Router } from 'express';
import authRoutes from './auth.routes';
import plotRoutes from './plot.routes';
import paymentRoutes from './payment.routes';
import blockRoutes from './block.routes';
import phaseRoutes from './phase.routes';
import statsRoutes from './stats.routes';
import noticeRoutes from './notice.routes';
import importRoutes from './import.routes';
import analyticsRoutes from './analytics.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/plots', plotRoutes);
router.use('/payments', paymentRoutes);
router.use('/blocks', blockRoutes);
router.use('/phases', phaseRoutes);
router.use('/stats', statsRoutes);
router.use('/notices', noticeRoutes);
router.use('/import', importRoutes);
router.use('/analytics', analyticsRoutes);

// Health check
router.get('/health', (_req, res) => {
  res.json({ success: true, message: 'KKB4 API is running', timestamp: new Date().toISOString() });
});

export default router;
