import Payment from '../models/Payment';
import Plot from '../models/Plot';
import { PHASE_BLOCK_MAP, BLOCK_PHASE_MAP, MONTHS, ALL_BLOCKS } from '../config/constants';

export class StatsService {
  static async getOverview(year: number) {
    const payments = await Payment.find({ year }).populate('plot').lean();
    const totalPlots = await Plot.countDocuments({ isActive: true });

    let totalCollected = 0;
    let totalDue = 0;
    let totalRemaining = 0;
    let paidPlots = 0;
    let defaulterPlots = 0;

    for (const p of payments) {
      totalCollected += p.totalReceived || 0;
      totalDue += p.totalDue || 0;
      totalRemaining += p.remaining || 0;
      if (p.totalReceived > 0) paidPlots++;
      if (p.totalReceived === 0) defaulterPlots++;
    }

    const collectionRate = totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0;

    return {
      year,
      totalPlots,
      totalCollected,
      totalDue,
      totalRemaining,
      collectionRate,
      paidPlots,
      defaulterPlots,
      recordCount: payments.length,
    };
  }

  static async getBlockStats(block: string, year: number) {
    const plots = await Plot.find({ block: block.toUpperCase(), isActive: true }).lean();
    const plotIds = plots.map(p => p._id);

    const payments = await Payment.find({ plot: { $in: plotIds }, year }).lean();

    let totalCollected = 0;
    let totalDue = 0;
    let paidCount = 0;
    let defaulterCount = 0;

    for (const p of payments) {
      totalCollected += p.totalReceived || 0;
      totalDue += p.totalDue || 0;
      if (p.totalReceived > 0) paidCount++;
      else defaulterCount++;
    }

    return {
      block,
      phase: BLOCK_PHASE_MAP[block.toUpperCase()] || 0,
      year,
      totalPlots: plots.length,
      totalCollected,
      totalDue,
      remaining: totalDue - totalCollected,
      collectionRate: totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0,
      paidCount,
      defaulterCount,
    };
  }

  static async getAllBlockStats(year: number) {
    const results = [];
    for (const block of ALL_BLOCKS) {
      const stats = await this.getBlockStats(block, year);
      results.push(stats);
    }
    return results;
  }

  static async getPhaseStats(phase: number, year: number) {
    const blocks = PHASE_BLOCK_MAP[phase] || [];
    let totalCollected = 0;
    let totalDue = 0;
    let totalPlots = 0;
    const blockStats = [];

    for (const block of blocks) {
      const stats = await this.getBlockStats(block, year);
      totalCollected += stats.totalCollected;
      totalDue += stats.totalDue;
      totalPlots += stats.totalPlots;
      blockStats.push(stats);
    }

    return {
      phase,
      year,
      blocks,
      totalPlots,
      totalCollected,
      totalDue,
      remaining: totalDue - totalCollected,
      collectionRate: totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0,
      blockStats,
    };
  }

  static async getAllPhaseStats(year: number) {
    return Promise.all([1, 2, 3].map(phase => this.getPhaseStats(phase, year)));
  }

  static async getTopPlots(year: number, limit: number = 10) {
    const payments = await Payment.find({ year })
      .sort({ totalReceived: -1 })
      .limit(limit)
      .populate('plot')
      .lean();

    return payments.map((p, idx) => ({
      rank: idx + 1,
      plot: p.plot,
      totalReceived: p.totalReceived,
      totalDue: p.totalDue,
      remaining: p.remaining,
      percentage: p.totalDue > 0 ? Math.round((p.totalReceived / p.totalDue) * 100) : 0,
    }));
  }

  static async getTopBlocks(year: number) {
    const allStats = await this.getAllBlockStats(year);
    return allStats
      .filter(s => s.totalPlots > 0)
      .sort((a, b) => b.collectionRate - a.collectionRate)
      .map((s, idx) => ({ ...s, rank: idx + 1 }));
  }

  static async getMonthlyTrend(year: number, block?: string) {
    const filter: any = { year };
    if (block) {
      const plots = await Plot.find({ block: block.toUpperCase(), isActive: true }).lean();
      filter.plot = { $in: plots.map(p => p._id) };
    }

    const payments = await Payment.find(filter).lean();

    const trend = MONTHS.map(month => {
      let total = 0;
      let count = 0;
      for (const p of payments) {
        const val = (p.payments as any)[month];
        if (val !== null && val !== undefined && !isNaN(val)) {
          total += val;
          if (val > 0) count++;
        }
      }
      return { month, total, paidCount: count };
    });

    return trend;
  }

  static async getDefaulters(year: number, block?: string) {
    const plotFilter: any = { isActive: true };
    if (block) plotFilter.block = block.toUpperCase();

    const plots = await Plot.find(plotFilter).lean();
    const plotIds = plots.map(p => p._id);

    const payments = await Payment.find({
      plot: { $in: plotIds },
      year,
      totalReceived: 0,
    }).populate('plot').lean();

    // Also include plots with no payment record
    const paidPlotIds = (await Payment.find({ plot: { $in: plotIds }, year }).lean())
      .map(p => p.plot.toString());

    const plotsWithNoRecord = plots.filter(p => !paidPlotIds.includes(p._id.toString()));

    return {
      zeroPayment: payments,
      noRecord: plotsWithNoRecord,
      totalDefaulters: payments.length + plotsWithNoRecord.length,
    };
  }

  static async getYearRange(from: number, to: number, plotId?: string, block?: string, phase?: number) {
    const filter: any = { year: { $gte: from, $lte: to } };

    if (plotId) {
      filter.plot = plotId;
    } else if (block) {
      const plots = await Plot.find({ block: block.toUpperCase(), isActive: true }).lean();
      filter.plot = { $in: plots.map(p => p._id) };
    } else if (phase) {
      const plots = await Plot.find({ phase, isActive: true }).lean();
      filter.plot = { $in: plots.map(p => p._id) };
    }

    const payments = await Payment.find(filter).lean();

    const yearlyData: Record<number, { collected: number; due: number; remaining: number }> = {};

    for (const p of payments) {
      if (!yearlyData[p.year]) {
        yearlyData[p.year] = { collected: 0, due: 0, remaining: 0 };
      }
      yearlyData[p.year].collected += p.totalReceived || 0;
      yearlyData[p.year].due += p.totalDue || 0;
      yearlyData[p.year].remaining += p.remaining || 0;
    }

    return Object.entries(yearlyData)
      .map(([year, data]) => ({ year: parseInt(year), ...data }))
      .sort((a, b) => a.year - b.year);
  }
}
