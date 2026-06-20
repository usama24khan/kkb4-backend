import { Request, Response } from 'express';
import { PlotService } from '../services/plot.service';
import { StatsService } from '../services/stats.service';
import { ALL_BLOCKS, BLOCK_PHASE_MAP, getMcRateForYear } from '../config/constants';
import { sendSuccess, sendError } from '../utils/responseHelper';
import Payment from '../models/Payment';
import Block from '../models/Block';
import Phase from '../models/Phase';
import AuditLog from '../models/AuditLog';
import { createBlockSchema } from '../validations/structure.validation';
import { phaseExists } from '../utils/blockRegistry';
import { AuthRequest } from '../middleware/auth.middleware';

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
    const now = new Date();
    // For the current year, only count months that have elapsed (Jan → current month).
    // For past years, the full 12 months are due.
    const monthsElapsed = year === now.getFullYear() ? now.getMonth() + 1 : 12;
    const MONTH_KEYS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

    const plotsWithPayments = plots.map(p => {
      const pay = paymentsMap.get(p._id.toString());
      // Sum only months up to monthsElapsed so "paid" matches the dues window
      let paidInWindow = 0;
      if (pay) {
        for (let i = 0; i < monthsElapsed; i++) {
          const val = (pay.payments as any)[MONTH_KEYS[i]];
          if (val !== null && val !== undefined && !isNaN(val)) paidInWindow += val;
        }
      }
      const due = mcRate * monthsElapsed;
      return {
        ...p,
        plotCode: `${p.plotNumber}-${p.block}`,
        paid: paidInWindow,
        due,
        remaining: Math.max(0, due - paidInWindow),
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

/**
 * POST /api/blocks — register a new block linked to a phase.
 *
 * "Ensure exists" semantics: a block that already exists (built-in constant or
 * already saved) is returned with 200. If the target phase does not yet exist,
 * it is auto-created so the admin can define a brand-new phase + block in one
 * step.
 */
export const createBlock = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const validation = createBlockSchema.safeParse(req.body);
    if (!validation.success) {
      sendError(res, 'Validation failed', 400, validation.error.message);
      return;
    }

    const { code, phase } = validation.data;

    // Built-in constant block — nothing to persist, return its fixed mapping.
    if (BLOCK_PHASE_MAP[code]) {
      sendSuccess(
        res,
        { code, phase: BLOCK_PHASE_MAP[code], isActive: true, builtIn: true },
        'Block already exists (built-in)'
      );
      return;
    }

    const existing = await Block.findOne({ code });
    if (existing) {
      sendSuccess(res, existing, 'Block already exists');
      return;
    }

    // Auto-register the phase if it is brand new (not a constant, not in DB).
    if (!(await phaseExists(phase))) {
      await Phase.create({ name: phase });
    }

    const block = await Block.create({ code, phase });

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'create',
        entity: 'block',
        entityId: block._id.toString(),
        changes: { code, phase },
      });
    }

    sendSuccess(res, block, 'Block created', 201);
  } catch (error: any) {
    if (error.code === 11000) {
      sendError(res, 'Block already exists', 409);
      return;
    }
    sendError(res, 'Failed to create block', 500, error.message);
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
