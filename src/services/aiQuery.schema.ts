/**
 * KKB4 AI Database Chat — schema whitelist & LLM prompt
 * ============================================================================
 *
 * SAFETY MODEL
 * ------------
 * The LLM never writes a query. It emits JSON naming ONE of four read-only
 * operations plus parameters; this module defines exactly which collections,
 * fields, and operators those parameters may reference. Anything not listed
 * here is rejected before Mongo is touched — the validator is an allowlist,
 * not a denylist, so a new dangerous operator can't slip through by default.
 *
 * Deliberately excluded collections: `admins` (password hashes), `otps`,
 * `devices`, `auditlogs`. There is no code path from this feature to a write —
 * only `find`, `countDocuments`, and aggregation pipelines that THIS FILE'S
 * sibling service builds itself from validated params.
 */

import Plot from '../models/Plot';
import Payment from '../models/Payment';
import Receipt from '../models/Receipt';
import Block from '../models/Block';
import Phase from '../models/Phase';
import Year from '../models/Year';
import MonthlyRate from '../models/MonthlyRate';
import Complaint from '../models/Complaint';
import {
  ALL_BLOCKS,
  ALL_PHASES,
  MONTHS,
  YEARS_WITH_DATA,
  PHASE_BLOCK_MAP,
} from '../config/constants';

/**
 * Phase -> blocks, used to build the prompt's phase rule. Plot records still
 * hold legacy phase strings (Phase 4/5/6) because `npm run migrate:phases`
 * hasn't been run against live data, so the AI must filter by block instead.
 */
const PHASE_BLOCK_MAP_FOR_PROMPT: Record<string, string[]> = PHASE_BLOCK_MAP;

// ── Collections ─────────────────────────────────────────────────────────────

export const COLLECTIONS = {
  plots: Plot,
  payments: Payment,
  receipts: Receipt,
  blocks: Block,
  phases: Phase,
  years: Year,
  monthlyrates: MonthlyRate,
  complaints: Complaint,
} as const;

export type CollectionName = keyof typeof COLLECTIONS;

/** Re-exported so the service can recognise nested month keys. */
export { MONTHS as MONTH_KEYS };

/**
 * Queryable field paths per collection. Dotted paths are allowed only where
 * listed (e.g. `payments.jan`). `_id` is queryable but never LLM-authored in
 * practice; it's here so `sort` and projections can reference it.
 */
export const FIELDS: Record<CollectionName, string[]> = {
  plots: [
    '_id', 'srNo', 'ownerName', 'plotNumber', 'block', 'phase', 'plotBlock',
    'plotCode', 'allotmentStatus', 'isActive', 'ownerPhone', 'ownerCnic',
    'monthlyChargeOverride', 'createdAt', 'updatedAt',
  ],
  payments: [
    '_id', 'plot', 'year', 'mcRate', 'totalReceived', 'totalDue', 'remaining',
    'note', 'createdAt', 'updatedAt',
    ...MONTHS.map((m) => `payments.${m}`),
  ],
  receipts: [
    '_id', 'receiptNumber', 'receiptNumericId', 'year', 'month', 'language',
    'plotRef', 'blockNo', 'plotNo', 'ownerName', 'amount', 'paymentDate',
    'dateFrom', 'dateTo', 'societyName', 'isVerified', 'createdAt', 'updatedAt',
  ],
  blocks: ['_id', 'code', 'phase', 'isActive', 'createdAt', 'updatedAt'],
  phases: ['_id', 'name', 'isActive', 'createdAt', 'updatedAt'],
  years: ['_id', 'year', 'mcRate', 'isActive', 'notes', 'createdAt', 'updatedAt'],
  monthlyrates: ['_id', 'year', 'rate', 'updatedAt'],
  complaints: [
    '_id', 'trackingNumber', 'trackingNumericId', 'year', 'name', 'mobile',
    'message', 'status', 'resolvedAt', 'createdAt', 'updatedAt',
  ],
};

/**
 * Collections holding a reference to a plot, and the local field that holds it.
 * This is what makes `plotFilter` possible without ever using $lookup: we
 * resolve the plot filter to a list of _ids and add `<ref>: { $in: ids }`.
 */
export const PLOT_REF: Partial<Record<CollectionName, string>> = {
  payments: 'plot',
  receipts: 'plotRef',
};

/** Fields a `groupCount` may group by — kept low-cardinality on purpose. */
export const GROUPABLE: Partial<Record<CollectionName, string[]>> = {
  plots: ['block', 'phase', 'allotmentStatus', 'isActive'],
  payments: ['year', 'mcRate'],
  receipts: ['year', 'month', 'blockNo', 'isVerified'],
  complaints: ['status'],
};

// ── Operators ───────────────────────────────────────────────────────────────

/** The ONLY `$`-prefixed keys permitted anywhere in an LLM-supplied filter. */
export const ALLOWED_OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
  '$in', '$nin', '$and', '$or', '$nor', '$not',
  '$exists', '$regex', '$options', '$size', '$all', '$elemMatch',
]);

/**
 * Explicitly named as forbidden. The allowlist above already blocks these —
 * this set is defence in depth, so an accidental widening of the allowlist
 * still can't reach code execution or a write stage.
 */
export const FORBIDDEN_OPERATORS = new Set([
  '$where', '$function', '$accumulator', '$expr', '$jsonSchema',
  '$out', '$merge', '$lookup', '$graphLookup', '$unionWith', '$facet',
  '$set', '$unset', '$inc', '$push', '$pull', '$rename', '$mul',
  '$currentDate', '$setOnInsert', '$bit', '$addFields', '$replaceRoot',
]);

// ── Limits ──────────────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;
/** Max nesting depth of an LLM filter — blocks pathological $and/$or nesting. */
export const MAX_FILTER_DEPTH = 6;
/** Max characters in a $regex value — crude but effective ReDoS guard. */
export const MAX_REGEX_LENGTH = 100;
/** Server-side query timeout. */
export const QUERY_TIMEOUT_MS = 8000;
/** Cap on plot _ids a plotFilter may resolve to before we refuse the join. */
export const MAX_JOIN_IDS = 5000;

// ── LLM prompt ──────────────────────────────────────────────────────────────

/**
 * Schema description handed to the LLM. Written from the actual Mongoose
 * models — if a model changes, update this and FIELDS above together.
 */
export const SCHEMA_PROMPT = `You translate an admin's question about the KKB4 housing-society database into a single read-only query plan, returned as JSON.

## Collections and fields

### plots — one document per plot (the property register)
- ownerName (string) — registered owner
- plotNumber (string) e.g. "374"; block (string, one of ${ALL_BLOCKS.join(', ')})
- phase (string) — **UNRELIABLE, see the phase rule below.** Stored values in
  live data include legacy "Phase 4"/"Phase 5"/"Phase 6" from an older scheme
  that has not been migrated yet.
- plotBlock (string) "374 A"; plotCode (string) "374-A"
- allotmentStatus (string) "Active" | "Cancelled" | "Unsold" | "Unknown"
- isActive (boolean) — false means soft-deleted. **In live data every
  isActive:false plot is exactly the set of allotmentStatus:"Cancelled" plots.**
  So add isActive:true for general questions about current plots, but do NOT add
  it when the admin asks about cancelled / inactive / removed plots — that
  combination always returns zero.
- ownerPhone, ownerCnic (string); monthlyChargeOverride (number|null)
- createdAt, updatedAt (date)

### payments — ONE DOCUMENT PER PLOT PER YEAR (maintenance dues)
- plot (ObjectId -> plots), year (number, data exists ${YEARS_WITH_DATA[0]}–${YEARS_WITH_DATA[YEARS_WITH_DATA.length - 1]})
- mcRate (number) monthly charge, 200 for years <= 2021, 400 from 2022
- payments.jan … payments.dec (number OR null) — amount paid that month.
  **null means NOT PAID.** Use { "payments.mar": null } to find unpaid March.
  \`payments\` is an EMBEDDED OBJECT, **not an array**. Never use $elemMatch,
  $size, or $all on it, and never nest month keys under it. Always use the
  dotted path. To test several months, use $or over dotted paths:
    { "$or": [ { "payments.jan": null }, { "payments.feb": null } ] }
- totalReceived (number) sum paid that year
- totalDue (number) = mcRate * 12 for that year
- remaining (number) = totalDue - totalReceived, i.e. dues **for that one year only**
  (so a single document's remaining can never exceed 4800)
- note (string)

### receipts — issued payment receipts
- plotRef (ObjectId -> plots), receiptNumber, year, month (English name e.g. "January")
- blockNo, plotNo, ownerName (denormalised strings), amount (number)
- paymentDate (date), isVerified (boolean)

### Lookup collections
- blocks: code, phase, isActive
- phases: name, isActive
- years: year, mcRate, isActive, notes
- monthlyrates: year, rate
- complaints: trackingNumber ("CMP-2026-0001"), name, mobile, message,
  status ("pending"|"in_progress"|"resolved"), resolvedAt, createdAt

## Operations — pick exactly one

1. **find** — read documents from one collection.
   { "op": "find", "collection": "<name>", "filter": {...}, "sort": {"field": -1},
     "limit": 25, "projection": ["field", ...], "plotFilter": {...}, "populatePlot": true }

2. **count** — how many documents match.
   { "op": "count", "collection": "<name>", "filter": {...}, "plotFilter": {...} }

3. **sumDuesByPlot** — total dues per plot SUMMED ACROSS YEARS, joined to owner
   details. Use this whenever dues are compared to a number above 4800, or when
   the question says "total dues" / "overall outstanding" without naming a year.
   { "op": "sumDuesByPlot", "yearFrom": 2012, "yearTo": 2026,
     "minTotalRemaining": 10000,
     "plotFilter": {...}, "sortDir": -1, "limit": 25 }
   OMIT minTotalRemaining/maxTotalRemaining entirely when there is no such
   bound. Never send 0 to mean "no limit" — 0 means literally zero rupees.

4. **groupCount** — counts grouped by one low-cardinality field.
   { "op": "groupCount", "collection": "plots", "groupBy": "block", "filter": {...}, "limit": 25 }

## Rules

### Phase rule — IMPORTANT
Never filter on the \`phase\` field. Live plot records still carry legacy values
("Phase 4", "Phase 5", "Phase 6") from a superseded numbering scheme, so
filtering by phase silently misses records. The block a plot sits in is
authoritative. To filter by phase, filter by that phase's BLOCKS instead:
${ALL_PHASES.map((p) => `- ${p} -> { "block": { "$in": ${JSON.stringify(PHASE_BLOCK_MAP_FOR_PROMPT[p] || [])} } }`).join('\n')}
When you do this, set "reinterpreted" to note that the phase was resolved via
its blocks. You MAY still return \`phase\` in a projection for display.

### Data coverage
Payment data does not exist for every year in every block — some blocks only
have early years (e.g. 2012–2014). Zero results for a recent year usually means
no data was recorded, not that everyone paid. If a question names "this month"
or "this year" and returns nothing, that is a legitimate empty result.

- \`plotFilter\` applies ONLY on payments and receipts. It filters the related
  plot (block, phase, ownerName, allotmentStatus, plotNumber, isActive) and is
  the ONLY way to join. Never attempt $lookup, $expr, $where, or aggregation stages.
- \`populatePlot: true\` on payments/receipts attaches the plot's ownerName,
  plotBlock, block and phase to each row. Turn it on whenever the admin asks
  "who" — otherwise rows show only ObjectIds.
- Allowed filter operators: $eq $ne $gt $gte $lt $lte $in $nin $and $or $nor
  $not $exists $regex $options $size $all $elemMatch. Nothing else.
- For name searches use case-insensitive regex: {"ownerName": {"$regex": "khan", "$options": "i"}}
- **There is NO per-month payment timestamp in this schema.** For questions
  about "last N days/months" of payment activity, either use unpaid months of
  the relevant year (payments.<month>: null), or receipts.paymentDate if the
  admin explicitly means receipts. Set "reinterpreted" to a short note saying
  which you chose, so the admin is told what was actually measured.
- Default limit 25, maximum ${MAX_LIMIT}. Prefer isActive: true on plots unless
  asked otherwise.

Return ONLY JSON, with this envelope:
{ "plan": { ...one operation above... },
  "reinterpreted": "optional short note if you changed the meaning of the question",
  "unsupported": "set ONLY if the schema genuinely cannot answer this; then omit plan" }`;

/**
 * Today's date, as a second system message. Built per request rather than baked
 * into SCHEMA_PROMPT, because the server process outlives the day — without this
 * the model guesses the current year and silently queries the wrong one.
 */
export function buildDateContext(now = new Date()): string {
  const monthKey = MONTHS[now.getMonth()];
  return [
    `Today's date is ${now.toISOString().slice(0, 10)}.`,
    `The current year is ${now.getFullYear()} and the current month is "${monthKey}".`,
    `So "this month" means { "payments.${monthKey}": null } on year ${now.getFullYear()},`,
    `and "this year" means year ${now.getFullYear()}. Never guess the date.`,
  ].join(' ');
}

/** Compact reference echoed to the client so the UI can show what's queryable. */
export const CAPABILITIES = {
  collections: Object.keys(COLLECTIONS),
  operations: ['find', 'count', 'sumDuesByPlot', 'groupCount'],
  maxLimit: MAX_LIMIT,
  readOnly: true,
};
