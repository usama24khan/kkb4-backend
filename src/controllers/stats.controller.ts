import { Request, Response } from 'express';
import { StatsService } from '../services/stats.service';
import { sendSuccess, sendError } from '../utils/responseHelper';

export const getOverview = async (req: Request, res: Response): Promise<void> => {
  try {
    const yearParam = req.query.year as string;
    const year = yearParam === 'overall' ? 0 : (parseInt(yearParam) || new Date().getFullYear());
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;
    const overview = await StatsService.getOverview(year, monthFrom, monthTo);
    sendSuccess(res, overview, 'Overview fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch overview', 500, error.message);
  }
};

export const getTopPlots = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const limit = parseInt(req.query.limit as string) || 10;
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;
    const topPlots = await StatsService.getTopPlots(year, limit, monthFrom, monthTo);
    sendSuccess(res, topPlots, 'Top plots fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch top plots', 500, error.message);
  }
};

export const getTopDefaulters = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const limit = parseInt(req.query.limit as string) || 10;
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;
    const topDefaulters = await StatsService.getTopDefaulters(year, limit, monthFrom, monthTo);
    sendSuccess(res, topDefaulters, 'Top defaulters fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch top defaulters', 500, error.message);
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
      phase as string
    );

    sendSuccess(res, data, 'Year range stats fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch year range stats', 500, error.message);
  }
};
