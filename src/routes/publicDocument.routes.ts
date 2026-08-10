import { Router } from 'express';
import { getPublicDocument } from '../controllers/publicDocument.controller';
import { generalLimiter } from '../middleware/rateLimiter';

const router = Router();

// Public and rate-limited: WhatsApp's crawler and the resident both fetch this
// without credentials. Access is gated by knowing the document's ObjectId.
router.get('/documents/:kind/:id', generalLimiter, getPublicDocument);

export default router;
