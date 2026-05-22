import { Router } from 'express';
import { login, refresh, logout, getMe } from '../controllers/auth.controller';
import { authLimiter } from '../middleware/rateLimiter';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/login', authLimiter, login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', authMiddleware, getMe);

export default router;
