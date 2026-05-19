import { Request, Response } from 'express';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import Year from '../models/Year';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { BLOCK_PHASE_MAP, ALL_BLOCKS, MC_RATE_BY_YEAR, DEFAULT_MC_RATE } from '../config/constants';

const MONTH_ORDER = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export const getAnalyticsOverview = async (req: Request, res: Response): Promise<void> => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;
    const block = req.query.block as string | undefined;
    const phase = req.query.phase as string | undefined;

    // Resolve month range (inclusive)
    const startIndex = monthFrom ? MONTH_ORDER.indexOf(monthFrom.toLowerCase()) : 0;
    const endIndex = monthTo ? MONTH_ORDER.indexOf(monthTo.toLowerCase()) : 11;
    const monthsInRange = MONTH_ORDER.slice(
      startIndex === -1 ? 0 : startIndex,
      endIndex === -1 ? 11 : endIndex + 1
    );

    // Build Plot query
    const plotQuery: any = { isActive: true };
    if (block) {
      plotQuery.block = block.toUpperCase();
    }
    if (phase) {
      plotQuery.phase = parseInt(phase);
    }

    const plots = await Plot.find(plotQuery).lean();
    const totalPlots = plots.length;
    const activePlots = plots.filter(p => p.allotmentStatus === 'Active').length;
    const cancelledPlots = plots.filter(p => p.allotmentStatus === 'Cancelled').length;

    // Get live maintenance rate for year
    let yearMcRate = MC_RATE_BY_YEAR[year] || DEFAULT_MC_RATE;
    const yearDoc = await Year.findOne({ year, isActive: true }).lean();
    if (yearDoc) {
      yearMcRate = yearDoc.mcRate;
    }

    // Query all payment records for these plots in the selected year
    const plotIds = plots.map(p => p._id);
    const payments = await Payment.find({ plot: { $in: plotIds }, year }).lean();
    const paymentsMap = new Map(payments.map(p => [p.plot.toString(), p]));

    // Calculate individual plot metrics
    const plotStats = plots.map(plot => {
      const payDoc = paymentsMap.get(plot._id.toString());
      const mcRate = payDoc ? payDoc.mcRate : yearMcRate;

      let plotDue = 0;
      let plotReceived = 0;

      monthsInRange.forEach(m => {
        plotDue += mcRate;
        if (payDoc && payDoc.payments) {
          const val = (payDoc.payments as any)[m];
          if (val !== null && val !== undefined && !isNaN(val)) {
            plotReceived += val;
          }
        }
      });

      return {
        plot,
        mcRate,
        due: plotDue,
        received: plotReceived,
        remaining: plotDue - plotReceived,
      };
    });

    // Sum global range statistics
    const sumDue = plotStats.reduce((acc, curr) => acc + curr.due, 0);
    const sumReceived = plotStats.reduce((acc, curr) => acc + curr.received, 0);
    const sumRemaining = sumDue - sumReceived;
    const collectionRate = sumDue > 0 ? Math.round((sumReceived / sumDue) * 1000) / 10 : 0;

    // Per-month breakdown
    const perMonthBreakdown = monthsInRange.map(m => {
      let monthDue = 0;
      let monthReceived = 0;

      plotStats.forEach(ps => {
        monthDue += ps.mcRate;
        const payDoc = paymentsMap.get(ps.plot._id.toString());
        if (payDoc && payDoc.payments) {
          const val = (payDoc.payments as any)[m];
          if (val !== null && val !== undefined && !isNaN(val)) {
            monthReceived += val;
          }
        }
      });

      const monthRemaining = monthDue - monthReceived;
      const monthCollectionRate = monthDue > 0 ? Math.round((monthReceived / monthDue) * 100) : 0;

      return {
        month: m,
        due: monthDue,
        received: monthReceived,
        remaining: monthRemaining,
        collectionRate: monthCollectionRate,
      };
    });

    // Per-block breakdown
    let blocksList = ALL_BLOCKS;
    if (phase) {
      const targetPhase = parseInt(phase);
      blocksList = ALL_BLOCKS.filter(b => BLOCK_PHASE_MAP[b] === targetPhase);
    }
    if (block) {
      blocksList = blocksList.filter(b => b === block.toUpperCase());
    }

    const perBlockBreakdown = blocksList.map(b => {
      const blockPhase = BLOCK_PHASE_MAP[b] || 0;
      const blockPlotStats = plotStats.filter(ps => ps.plot.block === b);

      const bPlots = blockPlotStats.length;
      const bDue = blockPlotStats.reduce((acc, curr) => acc + curr.due, 0);
      const bReceived = blockPlotStats.reduce((acc, curr) => acc + curr.received, 0);
      const bRemaining = bDue - bReceived;
      const bRate = bDue > 0 ? Math.round((bReceived / bDue) * 100) : 0;

      return {
        block: b,
        phase: blockPhase,
        totalPlots: bPlots,
        received: bReceived,
        due: bDue,
        remaining: bRemaining,
        collectionRate: bRate,
      };
    }).filter(b => b.totalPlots > 0);

    // Defaulters (Top 10 outstanding balance)
    const topDefaulters = plotStats
      .filter(ps => ps.remaining > 0)
      .sort((a, b) => b.remaining - a.remaining)
      .slice(0, 10)
      .map(ps => ({
        ownerName: ps.plot.ownerName,
        plotBlock: ps.plot.plotBlock,
        remaining: ps.remaining,
      }));

    // Payers (Top 10 fully/most paid)
    const topPayers = plotStats
      .filter(ps => ps.received > 0)
      .sort((a, b) => b.received - a.received)
      .slice(0, 10)
      .map(ps => ({
        ownerName: ps.plot.ownerName,
        plotBlock: ps.plot.plotBlock,
        totalReceived: ps.received,
      }));

    sendSuccess(
      res,
      {
        totalPlots,
        activePlots,
        cancelledPlots,
        totalDue: sumDue,
        totalReceived: sumReceived,
        totalRemaining: sumRemaining,
        collectionRate,
        perMonthBreakdown,
        perBlockBreakdown,
        topDefaulters,
        topPayers,
      },
      'Analytics fetched successfully'
    );
  } catch (error: any) {
    sendError(res, 'Failed to fetch analytics', 500, error.message);
  }
};
