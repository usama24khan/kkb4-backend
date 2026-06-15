import { Router } from 'express';
import { login, verifyOtp, getDevices, refresh, logout, getMe } from '../controllers/auth.controller';
import { authLimiter } from '../middleware/rateLimiter';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/login', authLimiter, login);
router.post('/verify-otp', authLimiter, verifyOtp);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', authMiddleware, getMe);
router.get('/devices', authMiddleware, getDevices);

export default router;
