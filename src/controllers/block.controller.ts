import { Request, Response } from 'express';
import { PlotService } from '../services/plot.service';
import { StatsService } from '../services/stats.service';
import { ALL_BLOCKS, BLOCK_PHASE_MAP } from '../config/constants';
import { sendSuccess, sendError } from '../utils/responseHelper';

export const getAllBlocks = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const stats = await StatsService.getAllBlockStats(year);
    sendSuccess(res, stats, 'All blocks fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch blocks', 500, error.message);
  }
};

export const getBlockDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { block } = req.params;
    const year = parseInt(req.query.year as string) || new Date().getFullYear();

    const plots = await PlotService.getPlotsByBlock(block);
    const stats = await StatsService.getBlockStats(block, year);

    sendSuccess(res, { plots, stats }, 'Block detail fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch block detail', 500, error.message);
  }
};

export const getBlockStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const { block } = req.params;
    const year = parseInt(req.query.year as string) || new Date().getFullYear();

    const stats = await StatsService.getBlockStats(block, year);
    sendSuccess(res, stats, 'Block stats fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch block stats', 500, error.message);
  }
};
