/**
 * Stress test for Urdu PDF rendering — covers edge cases that production data
 * might trigger but the basic test doesn't:
 *   - Urdu owner names
 *   - Empty owner / phone
 *   - Unusual allotment status
 *   - Single-year notices
 *   - Notices with no outstanding dues
 *   - Long owner names
 */
import { generatePlotNotice } from '../utils/pdfGenerator';

const mkPayments = (year: number, mcRate: number, paid: string[] = []) => ({
  year,
  mcRate,
  payments: {
    jan: paid.includes('jan') ? mcRate : null,
    feb: paid.includes('feb') ? mcRate : null,
    mar: paid.includes('mar') ? mcRate : null,
    apr: paid.includes('apr') ? mcRate : null,
    may: paid.includes('may') ? mcRate : null,
    jun: paid.includes('jun') ? mcRate : null,
    jul: paid.includes('jul') ? mcRate : null,
    aug: paid.includes('aug') ? mcRate : null,
    sep: paid.includes('sep') ? mcRate : null,
    oct: paid.includes('oct') ? mcRate : null,
    nov: paid.includes('nov') ? mcRate : null,
    dec: paid.includes('dec') ? mcRate : null,
  },
});

const cases: Array<{ label: string; plot: any; payments: any[]; yf: number; yt: number }> = [
  {
    label: 'Urdu owner name',
    plot: { plotNumber: '101', block: 'B', phase: 'Phase 6', plotBlock: '101 B', ownerName: 'محمد احمد خان', ownerPhone: '0300-1111111', allotmentStatus: 'Active' },
    payments: [mkPayments(2025, 400, [])],
    yf: 2025, yt: 2025,
  },
  {
    label: 'empty ownerName + ownerPhone',
    plot: { plotNumber: '202', block: 'C', phase: 'Phase 5', plotBlock: '202 C', ownerName: '', ownerPhone: '', allotmentStatus: 'Unknown' },
    payments: [mkPayments(2024, 400, ['jan', 'feb'])],
    yf: 2024, yt: 2024,
  },
  {
    label: 'unusual allotmentStatus value',
    plot: { plotNumber: '303', block: 'D', phase: 'Phase 5', plotBlock: '303 D', ownerName: 'Test Person', allotmentStatus: 'PendingTransfer' },
    payments: [mkPayments(2026, 400, [])],
    yf: 2026, yt: 2026,
  },
  {
    label: 'no outstanding dues (fully paid)',
    plot: { plotNumber: '404', block: 'E', phase: 'Phase 4', plotBlock: '404 E', ownerName: 'Paid Up Owner', allotmentStatus: 'Active' },
    payments: [mkPayments(2026, 400, ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'])],
    yf: 2026, yt: 2026,
  },
  {
    label: 'long owner name',
    plot: { plotNumber: '505', block: 'F', phase: 'Phase 4', plotBlock: '505 F', ownerName: 'Khurram Hussain Abdul Rahman Al-Pakistani Junior The Third', allotmentStatus: 'Active' },
    payments: [mkPayments(2025, 400, []), mkPayments(2026, 400, ['jan'])],
    yf: 2025, yt: 2026,
  },
  {
    label: 'name with special chars (apostrophe, slash)',
    plot: { plotNumber: '606', block: 'G', phase: 'Phase 3', plotBlock: '606 G', ownerName: "M. O'Brien / Khan", allotmentStatus: 'Active' },
    payments: [mkPayments(2025, 400, [])],
    yf: 2025, yt: 2025,
  },
];

async function main() {
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 15);

  let n = 9100;
  for (const tc of cases) {
    try {
      const r = await generatePlotNotice({
        plot: tc.plot,
        payments: tc.payments,
        yearFrom: tc.yf,
        yearTo: tc.yt,
        noticeNumber: n++,
        language: 'ur',
        paymentDeadline: deadline,
      });
      console.log(`✓ ${tc.label}\n  → ${r.pdfPath}`);
    } catch (err: any) {
      console.error(`✗ ${tc.label}\n  ${err?.message || err}`);
    }
  }
}

main();
