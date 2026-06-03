import { Request, Response } from 'express';
import { StatsService } from '../services/stats.service';
import { PHASE_BLOCK_MAP, ALL_PHASES } from '../config/constants';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { createPhaseSchema } from '../validations/structure.validation';
import { AuthRequest } from '../middleware/auth.middleware';
import Phase from '../models/Phase';
import AuditLog from '../models/AuditLog';

export const getAllPhases = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;
    const stats = await StatsService.getAllPhaseStats(year, monthFrom, monthTo);
    sendSuccess(res, stats, 'All phases fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch phases', 500, error.message);
  }
};

export const getPhaseDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const phase = req.params.phase; // Now a string like "Phase 1"
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;

    if (!PHASE_BLOCK_MAP[phase]) {
      sendError(res, 'Invalid phase', 400);
      return;
    }

    const stats = await StatsService.getPhaseStats(phase, year, monthFrom, monthTo);
    sendSuccess(res, stats, 'Phase detail fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch phase detail', 500, error.message);
  }
};

/**
 * POST /api/phases — register a new phase.
 *
 * "Ensure exists" semantics: if the phase is already a built-in constant or
 * already saved, it returns the existing one with 200 so the admin create
 * flow (phase → block → plot) is safe to call idempotently.
 */
export const createPhase = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const validation = createPhaseSchema.safeParse(req.body);
    if (!validation.success) {
      sendError(res, 'Validation failed', 400, validation.error.message);
      return;
    }

    const { name } = validation.data;

    if (ALL_PHASES.includes(name)) {
      sendSuccess(res, { name, isActive: true, builtIn: true }, 'Phase already exists (built-in)');
      return;
    }

    const existing = await Phase.findOne({ name });
    if (existing) {
      sendSuccess(res, existing, 'Phase already exists');
      return;
    }

    const phase = await Phase.create({ name });

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'create',
        entity: 'phase',
        entityId: phase._id.toString(),
        changes: { name },
      });
    }

    sendSuccess(res, phase, 'Phase created', 201);
  } catch (error: any) {
    if (error.code === 11000) {
      sendError(res, 'Phase already exists', 409);
      return;
    }
    sendError(res, 'Failed to create phase', 500, error.message);
  }
};

export const getPhaseStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const phase = req.params.phase;
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;

    const stats = await StatsService.getPhaseStats(phase, year, monthFrom, monthTo);
    sendSuccess(res, stats, 'Phase stats fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch phase stats', 500, error.message);
  }
};
