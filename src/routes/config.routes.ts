import { Router } from 'express';
import { RATE_SCHEDULE, PHASE_BLOCK_MAP, ALL_PHASES } from '../config/constants';
import { sendSuccess } from '../utils/responseHelper';

const router = Router();

/**
 * GET /api/config/rates — Returns the maintenance rate schedule
 */
router.get('/rates', (_req, res) => {
  sendSuccess(res, { rates: RATE_SCHEDULE }, 'Rate schedule fetched');
});

/**
 * GET /api/config/phases — Returns the phase-block mapping
 */
router.get('/phases', (_req, res) => {
  const phases = ALL_PHASES.map(phase => ({
    phase,
    blocks: PHASE_BLOCK_MAP[phase] || [],
  }));
  sendSuccess(res, { phases }, 'Phase configuration fetched');
});

export default router;
