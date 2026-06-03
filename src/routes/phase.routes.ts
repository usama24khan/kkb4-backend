import { Router } from 'express';
import { getAllPhases, getPhaseDetail, getPhaseStats, createPhase } from '../controllers/phase.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';

const router = Router();

router.get('/', getAllPhases);
router.post('/', authMiddleware, adminOnly, createPhase);
router.get('/:phase', getPhaseDetail);
router.get('/:phase/stats', getPhaseStats);

export default router;
