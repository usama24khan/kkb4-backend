import { Request, Response } from 'express';
import { StatsService } from '../services/stats.service';
import { PHASE_BLOCK_MAP } from '../config/constants';
import { sendSuccess, sendError } from '../utils/responseHelper';

export const getAllPhases = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const stats = await StatsService.getAllPhaseStats(year);
    sendSuccess(res, stats, 'All phases fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch phases', 500, error.message);
  }
};

export const getPhaseDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const phase = parseInt(req.params.phase);
    const year = parseInt(req.query.year as string) || new Date().getFullYear();

    if (!PHASE_BLOCK_MAP[phase]) {
      sendError(res, 'Invalid phase number', 400);
      return;
    }

    const stats = await StatsService.getPhaseStats(phase, year);
    sendSuccess(res, stats, 'Phase detail fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch phase detail', 500, error.message);
  }
};

export const getPhaseStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const phase = parseInt(req.params.phase);
    const year = parseInt(req.query.year as string) || new Date().getFullYear();

    const stats = await StatsService.getPhaseStats(phase, year);
    sendSuccess(res, stats, 'Phase stats fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch phase stats', 500, error.message);
  }
};
