import { Router } from 'express';
import { getAnalyticsOverview } from '../controllers/analytics.controller';

const router = Router();

router.get('/overview', getAnalyticsOverview);

export default router;
