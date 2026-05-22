import { Request, Response } from 'express';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import Year from '../models/Year';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { BLOCK_PHASE_MAP, ALL_BLOCKS, MC_RATE_BY_YEAR, DEFAULT_MC_RATE, MONTHS, PHASE_BLOCK_MAP, ALL_PHASES, getMcRateForYear } from '../config/constants';

const MONTH_ORDER = MONTHS;

export const getAnalyticsOverview = async (req: Request, res: Response): Promise<void> => {
  try {
    const yearParam = req.query.year as string;
    const isOverall = yearParam === 'overall' || yearParam === '0';
    const year = isOverall ? 0 : (parseInt(yearParam) || new Date().getFullYear());
    const monthFrom = req.query.monthFrom as string | undefined;
    const monthTo = req.query.monthTo as string | undefined;
    const block = req.query.block as string | undefined;
    const phase = req.query.phase as string | undefined;

    // Resolve month range (inclusive)
    const startIndex = monthFrom ? MONTH_ORDER.indexOf(monthFrom.toLowerCase() as any) : 0;
    const endIndex = monthTo ? MONTH_ORDER.indexOf(monthTo.toLowerCase() as any) : 11;
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
      const phaseBlocks = PHASE_BLOCK_MAP[phase];
      if (phaseBlocks) {
        plotQuery.block = { $in: phaseBlocks };
      }
    }

    const plots = await Plot.find(plotQuery).lean();
    const totalPlots = plots.length;
    const activePlots = plots.filter(p => p.allotmentStatus === 'Active').length;
    const cancelledPlots = plots.filter(p => p.allotmentStatus === 'Cancelled').length;

    // Query payment records
    const plotIds = plots.map(p => p._id);
    const paymentFilter: any = { plot: { $in: plotIds } };
    if (!isOverall) paymentFilter.year = year;
    const payments = await Payment.find(paymentFilter).lean();

    // Build a map: plotId → [payments]
    const paymentsMapByPlot = new Map<string, any[]>();
    for (const p of payments) {
      const key = p.plot.toString();
      if (!paymentsMapByPlot.has(key)) paymentsMapByPlot.set(key, []);
      paymentsMapByPlot.get(key)!.push(p);
    }

    // Calculate individual plot metrics
    const plotStats = plots.map(plot => {
      const plotPayments = paymentsMapByPlot.get(plot._id.toString()) || [];

      let plotDue = 0;
      let plotReceived = 0;

      if (isOverall) {
        // Sum across all years
        for (const payDoc of plotPayments) {
          plotDue += payDoc.totalDue || 0;
          plotReceived += payDoc.totalReceived || 0;
        }
      } else {
        const payDoc = plotPayments.find((p: any) => p.year === year);
        const mcRate = payDoc ? payDoc.mcRate : getMcRateForYear(year);
        
        monthsInRange.forEach(m => {
          plotDue += mcRate;
          if (payDoc && payDoc.payments) {
            const val = (payDoc.payments as any)[m];
            if (val !== null && val !== undefined && !isNaN(val)) {
              plotReceived += val;
            }
          }
        });
      }

      return {
        plot,
        mcRate: isOverall ? 0 : (plotPayments.find((p: any) => p.year === year)?.mcRate || getMcRateForYear(year)),
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

    // Per-month breakdown (only for specific year, not overall)
    let perMonthBreakdown: any[] = [];
    if (!isOverall) {
      perMonthBreakdown = monthsInRange.map(m => {
        let monthDue = 0;
        let monthReceived = 0;

        plotStats.forEach(ps => {
          monthDue += ps.mcRate;
          const plotPayments = paymentsMapByPlot.get(ps.plot._id.toString()) || [];
          const payDoc = plotPayments.find((p: any) => p.year === year);
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
    }

    // Per-block breakdown
    let blocksList = [...ALL_BLOCKS];
    if (phase) {
      const phaseBlocks = PHASE_BLOCK_MAP[phase];
      if (phaseBlocks) blocksList = phaseBlocks;
    }
    if (block) {
      blocksList = blocksList.filter(b => b === block.toUpperCase());
    }

    const perBlockBreakdown = blocksList.map(b => {
      const blockPhase = BLOCK_PHASE_MAP[b] || '';
      const blockPlotStats = plotStats.filter(ps => ps.plot.block === b);

      const bPlots = blockPlotStats.length;
      const bDue = blockPlotStats.reduce((acc, curr) => acc + curr.due, 0);
      const bReceived = blockPlotStats.reduce((acc, curr) => acc + curr.received, 0);
      const bRemaining = bDue - bReceived;
      const bRate = bDue > 0 ? Math.round((bReceived / bDue) * 100) : 0;
      const bPaidCount = blockPlotStats.filter(ps => ps.received > 0).length;
      const bDefaulterCount = blockPlotStats.filter(ps => ps.received === 0).length;

      return {
        block: b,
        phase: blockPhase,
        totalPlots: bPlots,
        received: bReceived,
        due: bDue,
        remaining: bRemaining,
        collectionRate: bRate,
        paidCount: bPaidCount,
        defaulterCount: bDefaulterCount,
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
        plotCode: `${ps.plot.plotNumber}-${ps.plot.block}`,
        block: ps.plot.block,
        phase: ps.plot.phase,
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
        plotCode: `${ps.plot.plotNumber}-${ps.plot.block}`,
        block: ps.plot.block,
        phase: ps.plot.phase,
        totalReceived: ps.received,
      }));

    sendSuccess(
      res,
      {
        year: isOverall ? 'overall' : year,
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
