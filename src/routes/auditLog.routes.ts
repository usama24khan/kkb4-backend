import { Router } from 'express';
import { getAuditLog } from '../controllers/auditLog.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';

const router = Router();

router.get('/', authMiddleware, adminOnly, getAuditLog);

export default router;
