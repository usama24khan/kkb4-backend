import { Router } from 'express';
import { aiQuery, aiCapabilities } from '../controllers/aiQuery.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';
import { aiQueryLimiter } from '../middleware/rateLimiter';

const router = Router();

// Admin-only throughout — reuses the same auth chain as every other admin
// route. `adminOnly` also excludes the `viewer` role.
router.get('/capabilities', authMiddleware, adminOnly, aiCapabilities);
router.post('/query', authMiddleware, adminOnly, aiQueryLimiter, aiQuery);

export default router;
