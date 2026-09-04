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
import CashCollection from '../models/Collection';
import Expense from '../models/Expense';
import ExpenseCategory from '../models/ExpenseCategory';
import FinanceSettings from '../models/FinanceSettings';
import Notice from '../models/Notice';
import {
  ALL_BLOCKS,
  ALL_PHASES,
  MONTHS,
  YEARS_WITH_DATA,
  PHASE_BLOCK_MAP,
  BLOCK_PHASE_MAP,
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
  // Cash book + notices. `collections` is imported as CashCollection to avoid
  // shadowing the COLLECTIONS map itself.
  collections: CashCollection,
  expenses: Expense,
  expensecategories: ExpenseCategory,
  financesettings: FinanceSettings,
  notices: Notice,
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
  // `allocations` is deliberately omitted: it is an array of subdocuments, and
  // the pre-computed arrears/current/advance split already answers the
  // analytical questions without exposing $elemMatch to the model.
  collections: [
    '_id', 'plot', 'amount', 'method', 'receivedDate', 'bookYear', 'bookMonth',
    'bookOrdinal', 'arrearsAmount', 'currentAmount', 'advanceAmount',
    'unallocatedAmount', 'entryType', 'countInCashBook', 'receiptRef', 'note',
    'isVoided', 'voidedAt', 'voidReason', 'createdAt', 'updatedAt',
  ],
  // `attachmentUrl` omitted — a raw bill-image URL has no analytical use.
  expenses: [
    '_id', 'title', 'category', 'categoryName', 'amount', 'expenseDate',
    'bookYear', 'bookMonth', 'bookOrdinal', 'paidTo', 'method', 'note',
    'isVoided', 'voidedAt', 'voidReason', 'createdAt', 'updatedAt',
  ],
  expensecategories: [
    '_id', 'name', 'nameUr', 'monthlyBudget', 'isActive', 'sortOrder',
    'createdAt', 'updatedAt',
  ],
  financesettings: [
    '_id', 'key', 'openingBalance', 'openingAsOf', 'note', 'createdAt', 'updatedAt',
  ],
  // `pdfPath`/`pdfPaths` omitted — file paths, not data. `generatedBy` omitted
  // because it is an admin ObjectId the model can do nothing useful with.
  notices: [
    '_id', 'type', 'targetId', 'targetLabel', 'year', 'yearFrom', 'yearTo',
    'monthFrom', 'monthTo', 'language', 'paymentDeadline', 'minDuesThreshold',
    'plotCount', 'totalDue', 'createdAt', 'updatedAt',
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
  collections: 'plot',
};

/** Fields a `groupCount` may group by — kept low-cardinality on purpose. */
export const GROUPABLE: Partial<Record<CollectionName, string[]>> = {
  plots: ['block', 'phase', 'allotmentStatus', 'isActive'],
  payments: ['year', 'mcRate'],
  receipts: ['year', 'month', 'blockNo', 'isVerified'],
  complaints: ['status'],
  collections: ['bookYear', 'bookMonth', 'method', 'entryType', 'countInCashBook', 'isVoided'],
  expenses: ['bookYear', 'bookMonth', 'categoryName', 'method', 'isVoided'],
  expensecategories: ['isActive'],
  notices: ['type', 'language', 'year', 'yearTo'],
};

/**
 * Plot attributes a payments/receipts/collections query may be grouped BY, via
 * `plotGroupBy`. This is the group-by counterpart of `plotFilter`: the cash book
 * carries no block of its own, so "which block collected least" is only
 * answerable by folding rows up through their plot. Resolved in the service from
 * a plot _id -> value map, never a $lookup.
 *
 * `phase` is derived from the plot's block through BLOCK_PHASE_MAP rather than
 * read off the plot, because stored phase values are unmigrated legacy strings.
 */
export const PLOT_GROUPABLE = ['block', 'phase', 'allotmentStatus'] as const;

export type PlotGroupField = (typeof PLOT_GROUPABLE)[number];

/** Derive the grouping label for one plot, phase coming from its block. */
export function plotGroupValue(plot: any, field: string): string {
  if (field === 'phase') return BLOCK_PHASE_MAP[String(plot?.block)] || 'Unknown';
  const v = plot?.[field];
  return v === undefined || v === null || v === '' ? 'Unknown' : String(v);
}

/**
 * The complete set of buckets for a plot grouping, where one exists. Needed
 * because a "lowest"/"least" question is wrong without it: a block that
 * collected nothing produces no aggregation row at all, so the true minimum
 * would be silently skipped in favour of the smallest non-zero block.
 */
export function plotGroupDomain(field: string): string[] | null {
  if (field === 'block') return [...ALL_BLOCKS];
  if (field === 'phase') return [...ALL_PHASES];
  return null;
}

/**
 * Numeric fields a `sumAmount` may total. Separate from FIELDS because summing a
 * non-monetary number (a year, an ordinal, an _id) is never a sensible answer
 * and would produce confident nonsense.
 */
export const SUMMABLE: Partial<Record<CollectionName, string[]>> = {
  collections: [
    'amount', 'arrearsAmount', 'currentAmount', 'advanceAmount', 'unallocatedAmount',
  ],
  expenses: ['amount'],
  payments: ['totalReceived', 'totalDue', 'remaining'],
  receipts: ['amount'],
  notices: ['totalDue', 'plotCount'],
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

### collections — THE CASH BOOK: one row per payment actually received
Do not confuse this with \`payments\`. The distinction matters:
- \`payments\` records **what the money is for** (which months of dues are cleared).
- \`collections\` records **when the cash physically arrived**.
A payment handed over in March 2026 clearing 2015 dues sits in bookYear 2026 /
bookMonth 3 here, and in year 2015 in \`payments\`. So:
  * "how much did we collect in <period>" -> collections, on bookYear/bookMonth
  * "which months are unpaid for this plot" -> payments
- plot (ObjectId -> plots), amount (number), method ("cash"|"bank"|"online"|"cheque"|"other")
- receivedDate (date); bookYear (number), bookMonth (number 1-12) — the period
  the cash landed in; bookOrdinal (number) = bookYear*12 + bookMonth, for ranges
- arrearsAmount / currentAmount / advanceAmount (number) — the part of \`amount\`
  paying for months before / during / after the book period
- unallocatedAmount (number) — part not tied to any month (donation, fine)
- entryType ("live"|"historical"), countInCashBook (boolean)
- isVoided (boolean), voidedAt, voidReason
**Two filters are almost always required on this collection:**
  { "isVoided": false, "countInCashBook": true }
\`isVoided: true\` rows are reversed mistakes. \`countInCashBook: false\` rows are
historical backfill from money collected AND spent years ago — including them
inflates income badly. Omit \`countInCashBook\` only if the admin explicitly asks
about historical or archival entries.

### expenses — money the society paid out
- title (string), categoryName (string) — the spending heading, snapshotted at
  write time (e.g. sweeper salary, petrol, sewerage); category (ObjectId)
- amount (number), paidTo (string), method (same five values as collections)
- expenseDate (date); bookYear, bookMonth, bookOrdinal — same meaning as above
- note (string); isVoided (boolean), voidedAt, voidReason
**Always add { "isVoided": false }** unless the admin asks about voided entries.

### expensecategories — the spending headings
- name, nameUr (string), monthlyBudget (number|null, a soft warning only,
  never enforced), isActive (boolean), sortOrder (number)

### financesettings — a SINGLE configuration document (key: "default")
- openingBalance (number) — cash carried forward from before the system existed.
  Every running-savings figure starts from it.
- openingAsOf (date) — the period that balance is stated at. Month reports before
  it are historical archive; from it onwards is live bookkeeping.
- note (string)

### notices — dues notices generated for owners
- type ("plot"|"block"|"phase"), targetId (string), targetLabel (string) — a
  readable label like "374 A", "374 A +4 more", "A", or "Phase 1"
- year, yearFrom, yearTo (number); monthFrom, monthTo ("jan".."dec")
- language ("en"|"ur"), paymentDeadline (date|null)
- minDuesThreshold (number) — the dues cut-off the batch was generated at
- plotCount (number) — plots covered by this notice
- totalDue (number) — total dues the notice was issued for
There is **no plot reference** on notices; use targetId / targetLabel, which hold
strings. So plotFilter does not work here.

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

4. **groupCount** — counts grouped by one field.
   { "op": "groupCount", "collection": "plots", "groupBy": "block", "filter": {...},
     "sortDir": -1, "limit": 25 }
   Group by EITHER "groupBy" (a field on the collection itself) OR "plotGroupBy"
   (an attribute of the related plot — see the plot grouping rule below).
   - "how many payment records per block" -> { "op": "groupCount",
       "collection": "payments", "plotGroupBy": "block", "sortDir": -1 }
   - "how many cash entries per phase in 2026" -> { "op": "groupCount",
       "collection": "collections", "plotGroupBy": "phase",
       "filter": { "bookYear": 2026, "isVoided": false, "countInCashBook": true } }

5. **sumAmount** — TOTAL a money field, optionally broken down by one field.
   Use this for every "how much" question about income or spending; never fetch
   rows and expect the admin to add them up.
   { "op": "sumAmount", "collection": "expenses", "field": "amount",
     "filter": {...}, "groupBy": "categoryName", "plotGroupBy": null,
     "plotFilter": {...}, "sortDir": -1, "limit": 25 }
   OMIT groupBy/plotGroupBy for a single grand total. Summable fields:
   - collections: amount, arrearsAmount, currentAmount, advanceAmount, unallocatedAmount
   - expenses: amount
   - payments: totalReceived, totalDue, remaining
   - receipts: amount
   - notices: totalDue, plotCount
   Worked examples:
   - "total spent in 2025" -> { "op": "sumAmount", "collection": "expenses",
       "field": "amount", "filter": { "bookYear": 2025, "isVoided": false } }
   - "spending by category last year" -> same, plus "groupBy": "categoryName"
   - "how much did we collect in 2026" -> { "op": "sumAmount",
       "collection": "collections", "field": "amount",
       "filter": { "bookYear": 2026, "isVoided": false, "countInCashBook": true } }
   - "which block has the lowest collection in 2026" -> { "op": "sumAmount",
       "collection": "collections", "field": "amount", "plotGroupBy": "block",
       "sortDir": 1, "filter": { "bookYear": 2026, "isVoided": false,
       "countInCashBook": true } }
   - "which block owes the most in 2025" -> { "op": "sumAmount",
       "collection": "payments", "field": "remaining", "plotGroupBy": "block",
       "sortDir": -1, "filter": { "year": 2025 } }

### sortDir — "highest" vs "lowest"
Both groupCount and sumAmount accept "sortDir": -1 (largest first, the default)
or 1 (smallest first). ALWAYS send "sortDir": 1 when the question asks for the
lowest / least / smallest / fewest / worst-performing, and leave it at -1 for
highest / most / top / best. Never answer a "lowest" question with a
largest-first list.

### Plot grouping rule — how to break any question down by block or phase
\`collections\`, \`payments\` and \`receipts\` do not store a block, phase or owner of
their own; those live on the related plot. Set "plotGroupBy" to fold the rows up
through their plot. It is accepted by **both groupCount and sumAmount**, on
collections, payments and receipts, and takes exactly one of:
block, phase, allotmentStatus.
Counting per block and totalling per block are equally supported — grouping a
count by a plot attribute is NOT a limitation of this API.
- "plotGroupBy": "phase" is resolved through each plot's BLOCK, so it is safe
  despite the unmigrated phase field — you do NOT need to expand phases into
  blocks yourself when grouping.
- Blocks or phases with no matching rows come back with a total of 0 (unless a
  plotFilter narrowed the question), so a "lowest" answer is not skewed by a
  block that collected nothing.
- Use "groupBy" for a field on the collection itself and "plotGroupBy" for a
  plot attribute — never both in one plan.
So "which block collected the least / which phase pays best / dues by block" are
all ANSWERABLE. Never call such a question unsupported for lack of joins.

## Rules

### Phase rule — IMPORTANT
Never filter on the \`phase\` field. Live plot records still carry legacy values
("Phase 4", "Phase 5", "Phase 6") from a superseded numbering scheme, so
filtering by phase silently misses records. The block a plot sits in is
authoritative. To filter by phase, filter by that phase's BLOCKS instead:
${ALL_PHASES.map((p) => `- ${p} -> { "block": { "$in": ${JSON.stringify(PHASE_BLOCK_MAP_FOR_PROMPT[p] || [])} } }`).join('\n')}
When you do this, set "reinterpreted" to note that the phase was resolved via
its blocks. You MAY still return \`phase\` in a projection for display.

### Plot type is NOT in the database
The site plan classifies plots as regular / odd size / prime / mortgage, but no
collection stores that. Never invent a \`category\`, \`plotType\` or \`type\` field on
plots. If a question turns on plot type and you were not given the layout facts,
set "unsupported" and say the question is about the site plan.

### Data coverage
Payment data does not exist for every year in every block — some blocks only
have early years (e.g. 2012–2014). Zero results for a recent year usually means
no data was recorded, not that everyone paid. If a question names "this month"
or "this year" and returns nothing, that is a legitimate empty result.

- \`plotFilter\` applies ONLY on payments, receipts and collections. It filters the related
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

### Before answering "unsupported"
Set "unsupported" only when NO field in the schema above carries the information
(e.g. plot type, which is on the site plan only). It is NOT a reason to give up
that a question spans two collections: \`plotFilter\` filters by plot attributes
and \`plotGroupBy\` groups by them, so any question about blocks, phases, owners
or plot status combined with money, dues or receipts can be answered. Prefer the
closest answerable query plus a "reinterpreted" note over refusing.

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

/**
 * Vocabulary that means the question is about the physical layout rather than
 * the database — plot types, amenities, the shape of a block.
 *
 * Why gate at all: Groq's free tier caps at 8,000 tokens per minute and the
 * planner prompt is already ~2,600 tokens. Attaching the layout facts to every
 * question would cost another ~600 on each of up to two planning calls, roughly
 * halving how many questions an admin can ask per minute. Layout questions are a
 * small minority, so they pay that cost and nothing else does.
 *
 * Deliberately generous: a false positive only wastes tokens on one question,
 * whereas a false negative makes the model claim it cannot answer. If you move
 * off the free tier, drop the gate and attach SOCIETY_FACTS unconditionally.
 */
const LAYOUT_TERMS = [
  'prime', 'odd size', 'odd-size', 'oddsize', 'mortgage', 'mortgaged',
  'category', 'categories', 'amenity', 'amenities', 'regular plot',
  'map', 'layout', 'site plan', 'siteplan',
  'park', 'parks', 'school', 'mosque', 'graveyard', 'shopping mall',
  'community centre', 'community center', 'services area', 'central park',
  'how many plots', 'total plots', 'number of plots', 'plot count', 'boundary',
];

/**
 * True when the question looks like it needs the site-plan facts.
 * See LAYOUT_TERMS for why this is gated rather than always on.
 */
export function needsLayoutFacts(question: string): boolean {
  const q = question.toLowerCase();
  if (LAYOUT_TERMS.some((t) => q.includes(t))) return true;
  // "what type is plot 199", "plot 12 type" — a bare "type" only counts when it
  // is talking about a plot or block, since "type" alone is common elsewhere.
  return /\btypes?\b/.test(q) && /\b(plot|block)\b/.test(q);
}

/** Compact reference echoed to the client so the UI can show what's queryable. */
export const CAPABILITIES = {
  collections: Object.keys(COLLECTIONS),
  operations: ['find', 'count', 'sumDuesByPlot', 'groupCount', 'sumAmount'],
  plotGroupBy: [...PLOT_GROUPABLE],
  maxLimit: MAX_LIMIT,
  readOnly: true,
};
