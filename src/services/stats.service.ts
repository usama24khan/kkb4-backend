import Payment from '../models/Payment';
import Plot from '../models/Plot';
import { PHASE_BLOCK_MAP, BLOCK_PHASE_MAP, MONTHS, ALL_BLOCKS, ALL_PHASES, getMcRateForYear } from '../config/constants';

export class StatsService {
  /**
   * Get overview stats for a year (or all years if year === 0 / "overall")
   */
  static async getOverview(year: number, monthFrom?: string, monthTo?: string) {
    const isOverall = year === 0;
    const paymentFilter: any = isOverall ? {} : { year };
    const payments = await Payment.find(paymentFilter).populate('plot').lean();
    const totalPlots = await Plot.countDocuments({ isActive: true });

    const startIdx = monthFrom ? MONTHS.indexOf(monthFrom as any) : 0;
    const endIdx = monthTo ? MONTHS.indexOf(monthTo as any) : 11;
    const monthsInRange = MONTHS.slice(
      startIdx === -1 ? 0 : startIdx,
      (endIdx === -1 ? 11 : endIdx) + 1
    );

    let totalCollected = 0;
    let totalDue = 0;
    let paidPlots = 0;
    let defaulterPlots = 0;

    for (const p of payments) {
      if (isOverall) {
        // For overall, use full year data
        totalCollected += p.totalReceived || 0;
        totalDue += p.totalDue || 0;
      } else {
        // For specific year with month range
        let received = 0;
        for (const m of monthsInRange) {
          const val = (p.payments as any)[m];
          if (val !== null && val !== undefined && !isNaN(val)) {
            received += val;
          }
        }
        totalCollected += received;
        totalDue += p.mcRate * monthsInRange.length;
      }
      if (p.totalReceived > 0) paidPlots++;
      if (p.totalReceived === 0) defaulterPlots++;
    }

    const totalRemaining = totalDue - totalCollected;
    const collectionRate = totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0;

    return {
      year: isOverall ? 'overall' : year,
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

  static async getBlockStats(block: string, year: number, monthFrom?: string, monthTo?: string) {
    const isOverall = year === 0;
    const plots = await Plot.find({ block: block.toUpperCase(), isActive: true }).lean();
    const plotIds = plots.map(p => p._id);

    const paymentFilter: any = { plot: { $in: plotIds } };
    if (!isOverall) paymentFilter.year = year;
    const payments = await Payment.find(paymentFilter).lean();

    const startIdx = monthFrom ? MONTHS.indexOf(monthFrom as any) : 0;
    const endIdx = monthTo ? MONTHS.indexOf(monthTo as any) : 11;
    const monthsInRange = MONTHS.slice(
      startIdx === -1 ? 0 : startIdx,
      (endIdx === -1 ? 11 : endIdx) + 1
    );

    let totalCollected = 0;
    let totalDue = 0;
    let paidCount = 0;
    let defaulterCount = 0;

    for (const p of payments) {
      if (isOverall) {
        totalCollected += p.totalReceived || 0;
        totalDue += p.totalDue || 0;
      } else {
        let received = 0;
        for (const m of monthsInRange) {
          const val = (p.payments as any)[m];
          if (val !== null && val !== undefined && !isNaN(val)) {
            received += val;
          }
        }
        totalCollected += received;
        totalDue += p.mcRate * monthsInRange.length;
      }
      if (p.totalReceived > 0) paidCount++;
      else defaulterCount++;
    }

    return {
      block,
      phase: BLOCK_PHASE_MAP[block.toUpperCase()] || '',
      year: isOverall ? 'overall' : year,
      totalPlots: plots.length,
      totalCollected,
      totalDue,
      remaining: totalDue - totalCollected,
      collectionRate: totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0,
      paidCount,
      defaulterCount,
    };
  }

  static async getAllBlockStats(year: number, monthFrom?: string, monthTo?: string) {
    const results = [];
    for (const block of ALL_BLOCKS) {
      const stats = await this.getBlockStats(block, year, monthFrom, monthTo);
      if (stats.totalPlots > 0) {
        results.push(stats);
      }
    }
    return results;
  }

  static async getPhaseStats(phase: string, year: number, monthFrom?: string, monthTo?: string) {
    const blocks = PHASE_BLOCK_MAP[phase] || [];
    let totalCollected = 0;
    let totalDue = 0;
    let totalPlots = 0;
    let paidCount = 0;
    let defaulterCount = 0;
    const blockStats = [];

    for (const block of blocks) {
      const stats = await this.getBlockStats(block, year, monthFrom, monthTo);
      totalCollected += stats.totalCollected;
      totalDue += stats.totalDue;
      totalPlots += stats.totalPlots;
      paidCount += stats.paidCount;
      defaulterCount += stats.defaulterCount;
      blockStats.push(stats);
    }

    return {
      phase,
      year: year === 0 ? 'overall' : year,
      blocks,
      totalPlots,
      totalCollected,
      totalDue,
      remaining: totalDue - totalCollected,
      collectionRate: totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0,
      paidCount,
      defaulterCount,
      blockStats,
    };
  }

  static async getAllPhaseStats(year: number, monthFrom?: string, monthTo?: string) {
    return Promise.all(
      ALL_PHASES.map(phase => this.getPhaseStats(phase, year, monthFrom, monthTo))
    );
  }

  static async getTopPlots(year: number, limit: number = 10, monthFrom?: string, monthTo?: string) {
    const startIdx = monthFrom ? MONTHS.indexOf(monthFrom as any) : 0;
    const endIdx = monthTo ? MONTHS.indexOf(monthTo as any) : 11;
    const monthsInRange = MONTHS.slice(
      startIdx === -1 ? 0 : startIdx,
      (endIdx === -1 ? 11 : endIdx) + 1
    );

    const payments = await Payment.find({ year })
      .populate('plot')
      .lean();

    // Calculate received within month range
    const ranked = payments.map(p => {
      let received = 0;
      for (const m of monthsInRange) {
        const val = (p.payments as any)[m];
        if (val !== null && val !== undefined && !isNaN(val)) {
          received += val;
        }
      }
      const due = p.mcRate * monthsInRange.length;
      const plot = p.plot as any;
      return {
        plot,
        plotCode: plot ? `${plot.plotNumber}-${plot.block}` : '',
        ownerName: plot?.ownerName || '',
        block: plot?.block || '',
        phase: plot?.phase || '',
        totalPaid: received,
        totalDue: due,
        balance: due - received,
      };
    });

    // Sort by totalPaid descending
    ranked.sort((a, b) => b.totalPaid - a.totalPaid);

    return ranked.slice(0, limit).map((item, idx) => ({
      rank: idx + 1,
      ...item,
    }));
  }

  static async getTopDefaulters(year: number, limit: number = 10, monthFrom?: string, monthTo?: string) {
    const startIdx = monthFrom ? MONTHS.indexOf(monthFrom as any) : 0;
    const endIdx = monthTo ? MONTHS.indexOf(monthTo as any) : 11;
    const monthsInRange = MONTHS.slice(
      startIdx === -1 ? 0 : startIdx,
      (endIdx === -1 ? 11 : endIdx) + 1
    );

    const payments = await Payment.find({ year })
      .populate('plot')
      .lean();

    const ranked = payments.map(p => {
      let received = 0;
      for (const m of monthsInRange) {
        const val = (p.payments as any)[m];
        if (val !== null && val !== undefined && !isNaN(val)) {
          received += val;
        }
      }
      const due = p.mcRate * monthsInRange.length;
      const plot = p.plot as any;
      return {
        plot,
        plotCode: plot ? `${plot.plotNumber}-${plot.block}` : '',
        ownerName: plot?.ownerName || '',
        block: plot?.block || '',
        phase: plot?.phase || '',
        totalPaid: received,
        totalDue: due,
        balance: due - received,
      };
    });

    // Sort by balance descending (highest outstanding first)
    ranked.sort((a, b) => b.balance - a.balance);

    return ranked
      .filter(item => item.balance > 0)
      .slice(0, limit)
      .map((item, idx) => ({
        rank: idx + 1,
        ...item,
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

  static async getYearRange(from: number, to: number, plotId?: string, block?: string, phase?: string) {
    const filter: any = { year: { $gte: from, $lte: to } };

    if (plotId) {
      filter.plot = plotId;
    } else if (block) {
      const plots = await Plot.find({ block: block.toUpperCase(), isActive: true }).lean();
      filter.plot = { $in: plots.map(p => p._id) };
    } else if (phase) {
      const blocks = PHASE_BLOCK_MAP[phase] || [];
      const plots = await Plot.find({ block: { $in: blocks }, isActive: true }).lean();
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
