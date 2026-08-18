import MonthlyRate from '../models/MonthlyRate';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import { YEARS_WITH_DATA, getMcRateForYear, getMcRateForMonth, RATE_CHANGES, MONTHS } from '../config/constants';
import { env } from '../config/env';

/**
 * Ensure the MonthlyRate collection is populated with defaults.
 * Runs on startup for both test and production.
 */
export const ensureDefaultRates = async (): Promise<void> => {
  try {
    const count = await MonthlyRate.countDocuments();
    if (count === 0) {
      // One document per year, plus an extra at each mid-year change so the
      // month the rate moved is recorded rather than lost to the year average.
      const docs: Array<{ year: number; fromMonth: number; rate: number }> = [];
      for (const year of YEARS_WITH_DATA) {
        docs.push({ year, fromMonth: 1, rate: getMcRateForMonth(year, 1) });
        for (const change of RATE_CHANGES) {
          if (change.year === year && change.month > 1) {
            docs.push({ year, fromMonth: change.month, rate: change.rate });
          }
        }
      }
      await MonthlyRate.insertMany(docs);
      console.log(`✅ Seeded ${docs.length} monthly rate records`);
    }
  } catch (error) {
    console.error('Error seeding monthly rates:', error);
  }
};

/**
 * Every rate period on record, oldest first, gaps filled from the constants.
 *
 * A period rather than a year: the charge rose in May 2022, so 2022 has two
 * entries and any consumer showing one rate per year would misprice four months
 * of it.
 */
export const getRatePeriodsFromDB = async (): Promise<
  Array<{ year: number; fromMonth: number; rate: number }>
> => {
  const docs = await MonthlyRate.find().select('year fromMonth rate').lean();
  const periods = docs.map((d: any) => ({
    year: d.year,
    fromMonth: Number(d.fromMonth) || 1,
    rate: d.rate,
  }));
  const seen = new Set(periods.map((p) => `${p.year}-${p.fromMonth}`));

  for (const year of YEARS_WITH_DATA) {
    if (!seen.has(`${year}-1`)) periods.push({ year, fromMonth: 1, rate: getMcRateForMonth(year, 1) });
    for (const change of RATE_CHANGES) {
      if (change.year === year && change.month > 1 && !seen.has(`${year}-${change.month}`)) {
        periods.push({ year, fromMonth: change.month, rate: change.rate });
      }
    }
  }

  return periods.sort((a, b) => a.year - b.year || a.fromMonth - b.fromMonth);
};

/**
 * Rates as a map { year → prevailing (December) rate }.
 * Kept for callers that can only hold one figure per year.
 */
export const getRatesFromDB = async (): Promise<Record<number, number>> => {
  const periods = await getRatePeriodsFromDB();
  const map: Record<number, number> = {};
  for (const p of periods) map[p.year] = p.rate; // sorted, so the last wins
  for (const year of YEARS_WITH_DATA) {
    if (map[year] === undefined) map[year] = getMcRateForYear(year);
  }
  return map;
};

/**
 * Seed test data (plots + payments) for the development/test environment.
 * Only runs when NODE_ENV !== "production".
 */
export const ensureTestData = async (): Promise<void> => {
  if (env.NODE_ENV === 'production') return;

  try {
    const existing = await Plot.countDocuments();
    if (existing > 0) return; // already seeded

    const plotDefs = [
      { srNo: 1, ownerName: 'Ahmad Khan', plotNumber: '1', block: 'A', allotmentStatus: 'Active' as const, ownerPhone: '03001234567' },
      { srNo: 2, ownerName: 'Sara Malik', plotNumber: '2', block: 'A', allotmentStatus: 'Active' as const, ownerPhone: '03009876543' },
      { srNo: 3, ownerName: 'Bilal Ahmed', plotNumber: '3', block: 'B', allotmentStatus: 'Active' as const, ownerPhone: '03211111111' },
      { srNo: 4, ownerName: 'Fatima Noor', plotNumber: '4', block: 'B', allotmentStatus: 'Active' as const, ownerPhone: '03452222222' },
      { srNo: 5, ownerName: 'Usman Ali', plotNumber: '1', block: 'C', allotmentStatus: 'Cancelled' as const, ownerPhone: '' },
    ];

    const plots = await Plot.insertMany(plotDefs);
    console.log(`✅ Seeded ${plots.length} test plots`);

    // Add payment records for 2022 and 2023 for the first two plots
    const rateMap = await getRatesFromDB();
    for (const plot of plots.slice(0, 2)) {
      for (const year of [2022, 2023]) {
        const rate = rateMap[year] ?? 400;
        await Payment.create({
          plot: plot._id,
          year,
          mcRate: rate,
          payments: {
            jan: rate, feb: rate, mar: rate,
            apr: null, may: null, jun: null,
            jul: null, aug: null, sep: null,
            oct: null, nov: null, dec: null,
          },
          totalReceived: rate * 3,
          totalDue: rate * 12,
          remaining: rate * 9,
        });
      }
    }
    console.log('✅ Seeded test payment records');
  } catch (error) {
    console.error('Error seeding test data:', error);
  }
};
