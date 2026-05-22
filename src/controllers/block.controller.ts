import { Request, Response } from 'express';
import { PlotService } from '../services/plot.service';
import { StatsService } from '../services/stats.service';
import { ALL_BLOCKS, BLOCK_PHASE_MAP, getMcRateForYear } from '../config/constants';
import { sendSuccess, sendError } from '../utils/responseHelper';
import Payment from '../models/Payment';

export const getAllBlocks = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;
    const stats = await StatsService.getAllBlockStats(year, monthFrom, monthTo);
    sendSuccess(res, stats, 'All blocks fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch blocks', 500, error.message);
  }
};

export const getBlockDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { block } = req.params;
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;

    const plots = await PlotService.getPlotsByBlock(block);
    const plotIds = plots.map(p => p._id);
    const payments = await Payment.find({ plot: { $in: plotIds }, year }).lean();
    const paymentsMap = new Map(payments.map(p => [p.plot.toString(), p]));

    const mcRate = getMcRateForYear(year);

    const plotsWithPayments = plots.map(p => {
      const pay = paymentsMap.get(p._id.toString());
      return {
        ...p,
        plotCode: `${p.plotNumber}-${p.block}`,
        paid: pay ? pay.totalReceived : 0,
        due: pay ? pay.totalDue : mcRate * 12,
        remaining: pay ? pay.remaining : mcRate * 12,
        paymentId: pay ? pay._id.toString() : null,
        payments: pay ? pay.payments : {
          jan: null, feb: null, mar: null, apr: null, may: null, jun: null,
          jul: null, aug: null, sep: null, oct: null, nov: null, dec: null
        }
      };
    });

    const stats = await StatsService.getBlockStats(block, year, monthFrom, monthTo);

    sendSuccess(res, { plots: plotsWithPayments, stats }, 'Block detail fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch block detail', 500, error.message);
  }
};

export const getBlockStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const { block } = req.params;
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;

    const stats = await StatsService.getBlockStats(block, year, monthFrom, monthTo);
    sendSuccess(res, stats, 'Block stats fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch block stats', 500, error.message);
  }
};
