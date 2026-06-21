import { Router, Request, Response } from 'express';
import { YEARS_WITH_DATA, getMcRateForYear } from '../config/constants';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { getStructure } from '../utils/blockRegistry';
import { authMiddleware } from '../middleware/auth.middleware';
import { getRatesFromDB } from '../controllers/seed.controller';
import MonthlyRate from '../models/MonthlyRate';
import { env } from '../config/env';

const router = Router();

/**
 * GET /api/config/app-mode
 * Returns whether the backend is in "test" or "production" mode.
 * Frontends use this to show/hide the TEST indicator in the header.
 */
router.get('/app-mode', (_req, res) => {
  const mode = env.NODE_ENV === 'production' ? 'production' : 'test';
  sendSuccess(res, { mode }, `Running in ${mode} mode`);
});

/**
 * GET /api/config/rates — Returns the maintenance rate schedule from DB
 */
router.get('/rates', async (_req, res) => {
  try {
    const rateMap = await getRatesFromDB();
    const rates = Object.entries(rateMap)
      .map(([year, rate]) => ({ year: Number(year), rate }))
      .sort((a, b) => a.year - b.year);
    sendSuccess(res, { rates }, 'Rate schedule fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch rates', 500, error.message);
  }
});

/**
 * PUT /api/config/rates/:year — Update a specific year's monthly rate (admin only)
 */
router.put('/rates/:year', authMiddleware, async (req: Request, res: Response) => {
  try {
    const year = parseInt(req.params.year, 10);
    const { rate } = req.body;

    if (isNaN(year) || year < 2000 || year > 2100) {
      sendError(res, 'Invalid year', 400);
      return;
    }
    if (typeof rate !== 'number' || rate < 0) {
      sendError(res, 'rate must be a non-negative number', 400);
      return;
    }

    const doc = await MonthlyRate.findOneAndUpdate(
      { year },
      { rate },
      { upsert: true, new: true }
    );
    sendSuccess(res, { year: doc.year, rate: doc.rate }, 'Rate updated');
  } catch (error: any) {
    sendError(res, 'Failed to update rate', 500, error.message);
  }
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
