import { Router } from 'express';
import {
  generateNotices,
  generateForPlot,
  generateForBlock,
  generateForPhase,
  getNoticeHistory,
  downloadNotice,
  previewNotices,
} from '../controllers/notice.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';

const router = Router();

router.post('/preview', authMiddleware, adminOnly, previewNotices);
router.post('/generate', authMiddleware, adminOnly, generateNotices);
router.post('/plot/:plotId', authMiddleware, adminOnly, generateForPlot);
router.post('/block/:block', authMiddleware, adminOnly, generateForBlock);
router.post('/phase/:phase', authMiddleware, adminOnly, generateForPhase);
router.get('/history', authMiddleware, getNoticeHistory);
router.get('/download/:fileName', downloadNotice);

export default router;
