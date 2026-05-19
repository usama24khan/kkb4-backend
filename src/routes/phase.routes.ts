import { Router } from 'express';
import { getAllPhases, getPhaseDetail, getPhaseStats } from '../controllers/phase.controller';

const router = Router();

router.get('/', getAllPhases);
router.get('/:phase', getPhaseDetail);
router.get('/:phase/stats', getPhaseStats);

export default router;
