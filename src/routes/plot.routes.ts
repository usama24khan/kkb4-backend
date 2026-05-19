import { Router } from 'express';
import { getPlots, getPlotById, createPlot, updatePlot, deletePlot } from '../controllers/plot.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';

const router = Router();

router.get('/', getPlots);
router.get('/:plotId', getPlotById);
router.post('/', authMiddleware, adminOnly, createPlot);
router.put('/:plotId', authMiddleware, adminOnly, updatePlot);
router.delete('/:plotId', authMiddleware, adminOnly, deletePlot);

export default router;
