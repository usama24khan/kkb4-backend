import { Router } from 'express';
import { getAllBlocks, getBlockDetail, getBlockStats } from '../controllers/block.controller';

const router = Router();

router.get('/', getAllBlocks);
router.get('/:block', getBlockDetail);
router.get('/:block/stats', getBlockStats);

export default router;
