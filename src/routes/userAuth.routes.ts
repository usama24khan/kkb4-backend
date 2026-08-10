import { Router } from 'express';
import { userLogin, userMe, userNotices } from '../controllers/userAuth.controller';
import { userAuthMiddleware } from '../middleware/userAuth.middleware';
import { authLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/login', authLimiter, userLogin);
router.get('/me', userAuthMiddleware, userMe);
router.get('/notices', userAuthMiddleware, userNotices);

export default router;
