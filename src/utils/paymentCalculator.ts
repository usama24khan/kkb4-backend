import { MONTHS } from '../config/constants';
import { IPaymentMonths } from '../models/Payment';

/**
 * Calculate total received from monthly payments
 */
export function calculateTotalReceived(payments: IPaymentMonths): number {
  let total = 0;
  for (const month of MONTHS) {
    const val = payments[month];
    if (val !== null && val !== undefined && !isNaN(val)) {
      total += val;
    }
  }
  return total;
}

/**
 * Calculate remaining balance
 */
export function calculateRemaining(mcRate: number, totalReceived: number): number {
  return (mcRate * 12) - totalReceived;
}

/**
 * Calculate payment percentage
 */
export function calculatePaymentPercentage(totalReceived: number, totalDue: number): number {
  if (totalDue === 0) return 0;
  return Math.min(100, Math.round((totalReceived / totalDue) * 100));
}

/**
 * Get overdue months (months with no payment)
 */
export function getOverdueMonths(payments: IPaymentMonths): string[] {
  const overdue: string[] = [];
  for (const month of MONTHS) {
    if (payments[month] === null || payments[month] === 0) {
      overdue.push(month);
    }
  }
  return overdue;
}

/**
 * Calculate subtotal for a month range
 */
export function calculateMonthRangeTotal(
  payments: IPaymentMonths,
  fromMonth: string,
  toMonth: string
): number {
  const fromIdx = MONTHS.indexOf(fromMonth as any);
  const toIdx = MONTHS.indexOf(toMonth as any);
  if (fromIdx === -1 || toIdx === -1) return 0;
  
  let total = 0;
  for (let i = fromIdx; i <= toIdx; i++) {
    const val = payments[MONTHS[i]];
    if (val !== null && val !== undefined && !isNaN(val)) {
      total += val;
    }
  }
  return total;
}
