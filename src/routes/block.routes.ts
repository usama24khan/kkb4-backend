import { Router } from 'express';
import { getAllBlocks, getBlockDetail, getBlockStats, createBlock } from '../controllers/block.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';

const router = Router();

router.get('/', getAllBlocks);
router.post('/', authMiddleware, adminOnly, createBlock);
router.get('/:block', getBlockDetail);
router.get('/:block/stats', getBlockStats);

export default router;
