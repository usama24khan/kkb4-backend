import { Router } from 'express';
import { getOverview, getTopPlots, getTopBlocks, getMonthlyTrend, getDefaulters, getYearRange } from '../controllers/stats.controller';

const router = Router();

router.get('/overview', getOverview);
router.get('/top-plots', getTopPlots);
router.get('/top-blocks', getTopBlocks);
router.get('/monthly', getMonthlyTrend);
router.get('/defaulters', getDefaulters);
router.get('/year-range', getYearRange);

export default router;
