/**
 * Smoke test for Urdu PDF rendering. Run with:
 *   npx ts-node src/scripts/testUrduPdf.ts
 *
 * Produces a sample notice in notices/ and prints the path. Inspect visually
 * to verify Nastaliq letter joining and column alignment look right.
 */
import { generatePlotNotice } from '../utils/pdfGenerator';

async function main() {
  // Minimal fixture — only the fields the renderer actually reads.
  const plot = {
    plotNumber: '374',
    block: 'A',
    phase: 'Phase 6',
    plotBlock: '374 A',
    plotCode: '374-A',
    ownerName: 'Muhammad Ahmed Khan',
    ownerPhone: '0300-1234567',
    allotmentStatus: 'Active',
    isActive: true,
  } as any;

  // Mixed paid / unpaid months across multiple years
  const mk = (year: number, mcRate: number, paidMonths: string[] = []) => ({
    year,
    mcRate,
    payments: {
      jan: paidMonths.includes('jan') ? mcRate : null,
      feb: paidMonths.includes('feb') ? mcRate : null,
      mar: paidMonths.includes('mar') ? mcRate : null,
      apr: paidMonths.includes('apr') ? mcRate : null,
      may: paidMonths.includes('may') ? mcRate : null,
      jun: paidMonths.includes('jun') ? mcRate : null,
      jul: paidMonths.includes('jul') ? mcRate : null,
      aug: paidMonths.includes('aug') ? mcRate : null,
      sep: paidMonths.includes('sep') ? mcRate : null,
      oct: paidMonths.includes('oct') ? mcRate : null,
      nov: paidMonths.includes('nov') ? mcRate : null,
      dec: paidMonths.includes('dec') ? mcRate : null,
    },
  });

  const payments = [
    mk(2023, 400, ['jan', 'feb', 'apr', 'may', 'jul', 'aug', 'oct', 'nov']), // mar/jun/sep/dec unpaid
    mk(2024, 400, ['jul', 'aug', 'sep', 'oct', 'nov', 'dec']),               // jan–jun unpaid
    mk(2025, 400, []),                                                       // all 12 unpaid
    mk(2026, 400, []),                                                       // jan/feb unpaid (only those two months exist by current date)
  ];

  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 15);

  console.log('Rendering Urdu notice...');
  const urdu = await generatePlotNotice({
    plot,
    payments,
    yearFrom: 2023,
    yearTo: 2026,
    noticeNumber: 9001,
    language: 'ur',
    paymentDeadline: deadline,
  });
  console.log('  → ', urdu.pdfPath);

  console.log('Rendering English notice...');
  const eng = await generatePlotNotice({
    plot,
    payments,
    yearFrom: 2023,
    yearTo: 2026,
    noticeNumber: 9002,
    language: 'en',
    paymentDeadline: deadline,
  });
  console.log('  → ', eng.pdfPath);

  console.log('\nGrand total (both):', urdu.amountDue, 'PKR');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
