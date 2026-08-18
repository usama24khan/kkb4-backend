/**
 * Writing the audit trail.
 *
 * An audit entry is only worth keeping if it can be read later without the
 * reader knowing the code. The old entries stored the request body verbatim, so
 * a grid save came out as `entriesCount: 23, mode: live, ledger: [object
 * Object]` — a record that something happened, with no way to tell what.
 *
 * Every entry written through here carries three things instead: the plot it
 * concerns, a sentence saying what happened, and a list of the fields that moved
 * with their before and after. The raw request stays in `changes` underneath as
 * the evidence.
 */
import AuditLog, { IAuditChange } from '../models/AuditLog';
import { MONTHS } from '../config/constants';

export interface AuditInput {
  admin?: string | null;
  action: string;
  entity: string;
  entityId: string;
  plot?: string | null;
  summary: string;
  diffs?: IAuditChange[];
  changes?: Record<string, any>;
}

/**
 * Record one entry. Never throws: an audit write failing must not fail the
 * action it was describing, which has already happened.
 */
export async function logAudit(input: AuditInput): Promise<void> {
  if (!input.admin) return;
  try {
    await AuditLog.create({
      admin: input.admin,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      plot: input.plot || null,
      summary: input.summary,
      diffs: input.diffs || [],
      changes: input.changes || {},
    });
  } catch (err) {
    console.warn('[audit] could not record entry:', (err as Error).message);
  }
}

/** "Aug 2026" — month names as written, so a diff reads without decoding. */
export function monthLabel(month: string | number, year: number): string {
  const key = typeof month === 'number' ? MONTHS[month - 1] : String(month).toLowerCase();
  const pretty = key ? key.charAt(0).toUpperCase() + key.slice(1) : String(month);
  return `${pretty} ${year}`;
}

/**
 * Field names as a person would say them.
 *
 * The stored name is the machine one — that is what makes the record precise —
 * but a summary written for reading should not say `ownerName`.
 */
const FIELD_LABELS: Record<string, string> = {
  srNo: 'serial number',
  ownerName: 'owner',
  plotNumber: 'plot number',
  block: 'block',
  phase: 'phase',
  plotBlock: 'plot',
  plotCode: 'plot code',
  allotmentStatus: 'allotment status',
  isActive: 'active',
  ownerPhone: 'phone',
  ownerCnic: 'CNIC',
  monthlyChargeOverride: 'monthly charge',
  amount: 'amount',
  title: 'title',
  categoryName: 'category',
  paidTo: 'paid to',
  method: 'method',
  note: 'note',
  expenseDate: 'expense date',
  openingBalance: 'opening balance',
};

export function fieldLabel(field: string): string {
  if (field.startsWith('payments.')) {
    const month = field.slice('payments.'.length);
    return month.charAt(0).toUpperCase() + month.slice(1);
  }
  return FIELD_LABELS[field] || field;
}

/** PKR with thousands separators, for summaries. */
export function money(amount: number): string {
  return `PKR ${Math.round(amount || 0).toLocaleString('en-US')}`;
}

/**
 * The fields that actually differ between two objects, ignoring the ones that
 * only describe the request rather than the record.
 */
export function diffFields(
  before: Record<string, any>,
  after: Record<string, any>,
  fields: string[],
): IAuditChange[] {
  const diffs: IAuditChange[] = [];
  for (const field of fields) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (String(from ?? '') === String(to ?? '')) continue;
    diffs.push({ field, from, to });
  }
  return diffs;
}

/** Month-by-month movement in a year's payment record. */
export function diffMonths(
  before: Record<string, any> | undefined,
  after: Record<string, any> | undefined,
): IAuditChange[] {
  const diffs: IAuditChange[] = [];
  for (const month of MONTHS) {
    const from = Number(before?.[month]) || 0;
    const to = Number(after?.[month]) || 0;
    if (from === to) continue;
    diffs.push({ field: `payments.${month}`, from, to });
  }
  return diffs;
}
