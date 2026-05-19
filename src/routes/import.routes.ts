import { Router } from 'express';
import { importExcel, getImportStatus, upload } from '../controllers/import.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';
import { importLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/excel', authMiddleware, adminOnly, importLimiter, upload.single('file'), importExcel);
router.get('/status', authMiddleware, getImportStatus);

export default router;
