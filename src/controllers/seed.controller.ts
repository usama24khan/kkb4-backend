import MonthlyRate from '../models/MonthlyRate';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import { YEARS_WITH_DATA, getMcRateForYear, MONTHS } from '../config/constants';
import { env } from '../config/env';

/**
 * Ensure the MonthlyRate collection is populated with defaults.
 * Runs on startup for both test and production.
 */
export const ensureDefaultRates = async (): Promise<void> => {
  try {
    const count = await MonthlyRate.countDocuments();
    if (count === 0) {
      const docs = YEARS_WITH_DATA.map((year) => ({
        year,
        rate: getMcRateForYear(year),
      }));
      await MonthlyRate.insertMany(docs);
      console.log(`✅ Seeded ${docs.length} monthly rate records`);
    }
  } catch (error) {
    console.error('Error seeding monthly rates:', error);
  }
};

/**
 * Fetch all rates from DB as a map { year → rate }.
 * Falls back to constants if DB is unavailable.
 */
export const getRatesFromDB = async (): Promise<Record<number, number>> => {
  const docs = await MonthlyRate.find().lean();
  const map: Record<number, number> = {};
  for (const doc of docs) {
    map[doc.year] = doc.rate;
  }
  // fill any gaps with constant fallback
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
