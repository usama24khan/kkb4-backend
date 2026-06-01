import { Router } from 'express';
import { residentLogin, residentMe, residentNotices } from '../controllers/residentAuth.controller';
import { residentAuthMiddleware } from '../middleware/residentAuth.middleware';
import { authLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/login', authLimiter, residentLogin);
router.get('/me', residentAuthMiddleware, residentMe);
router.get('/notices', residentAuthMiddleware, residentNotices);

export default router;
