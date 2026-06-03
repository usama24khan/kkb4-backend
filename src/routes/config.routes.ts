import { Router, Request, Response } from 'express';
import { RATE_SCHEDULE } from '../config/constants';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { getStructure } from '../utils/blockRegistry';

const router = Router();

/**
 * GET /api/config/rates — Returns the maintenance rate schedule
 */
router.get('/rates', (_req, res) => {
  sendSuccess(res, { rates: RATE_SCHEDULE }, 'Rate schedule fetched');
});

/**
 * GET /api/config/phases — Returns the phase→block mapping (constants ∪ DB)
 */
router.get('/phases', async (_req: Request, res: Response) => {
  try {
    const { phases } = await getStructure();
    sendSuccess(
      res,
      { phases: phases.map((p) => ({ phase: p.name, blocks: p.blocks })) },
      'Phase configuration fetched'
    );
  } catch (error: any) {
    sendError(res, 'Failed to fetch phase configuration', 500, error.message);
  }
});

/**
 * GET /api/config/structure — Full merged phases + blocks for admin dropdowns
 */
router.get('/structure', async (_req: Request, res: Response) => {
  try {
    const structure = await getStructure();
    sendSuccess(res, structure, 'Structure fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch structure', 500, error.message);
  }
});

export default router;
