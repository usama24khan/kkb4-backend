import { Router } from 'express';
import { generateForPlot, generateForBlock, generateForPhase, getNoticeHistory, downloadNotice } from '../controllers/notice.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';

const router = Router();

router.post('/plot/:plotId', authMiddleware, adminOnly, generateForPlot);
router.post('/block/:block', authMiddleware, adminOnly, generateForBlock);
router.post('/phase/:phase', authMiddleware, adminOnly, generateForPhase);
router.get('/history', authMiddleware, getNoticeHistory);
router.get('/download/:fileName', downloadNotice);

export default router;
