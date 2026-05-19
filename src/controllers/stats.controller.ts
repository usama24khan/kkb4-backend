import { Request, Response } from 'express';
import { StatsService } from '../services/stats.service';
import { sendSuccess, sendError } from '../utils/responseHelper';

export const getOverview = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const overview = await StatsService.getOverview(year);
    sendSuccess(res, overview, 'Overview fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch overview', 500, error.message);
  }
};

export const getTopPlots = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const limit = parseInt(req.query.limit as string) || 10;
    const topPlots = await StatsService.getTopPlots(year, limit);
    sendSuccess(res, topPlots, 'Top plots fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch top plots', 500, error.message);
  }
};

export const getTopBlocks = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const topBlocks = await StatsService.getTopBlocks(year);
    sendSuccess(res, topBlocks, 'Top blocks fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch top blocks', 500, error.message);
  }
};

export const getMonthlyTrend = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const block = req.query.block as string | undefined;
    const trend = await StatsService.getMonthlyTrend(year, block);
    sendSuccess(res, trend, 'Monthly trend fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch monthly trend', 500, error.message);
  }
};

export const getDefaulters = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const block = req.query.block as string | undefined;
    const defaulters = await StatsService.getDefaulters(year, block);
    sendSuccess(res, defaulters, 'Defaulters fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch defaulters', 500, error.message);
  }
};

export const getYearRange = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseInt(req.query.from as string) || 2012;
    const to = parseInt(req.query.to as string) || new Date().getFullYear();
    const { plotId, block, phase } = req.query;

    const data = await StatsService.getYearRange(
      from, to,
      plotId as string,
      block as string,
      phase ? parseInt(phase as string) : undefined
    );

    sendSuccess(res, data, 'Year range stats fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch year range stats', 500, error.message);
  }
};
