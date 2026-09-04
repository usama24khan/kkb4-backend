/**
 * KKB4 AI Database Chat — query planning, validation, and execution.
 *
 * Flow: question -> Groq (plan JSON) -> validate against the whitelist in
 * aiQuery.schema.ts -> execute read-only -> Groq (one-line summary) -> result.
 *
 * The LLM cannot reach Mongo directly. It names an operation and supplies
 * parameters; every collection, field path, and operator in those parameters is
 * checked against an allowlist first, and the aggregation pipelines are built
 * here rather than by the model. See aiQuery.schema.ts for the safety model.
 */

import { Types } from 'mongoose';
import { env } from '../config/env';
import {
  COLLECTIONS,
  FIELDS,
  PLOT_REF,
  GROUPABLE,
  PLOT_GROUPABLE,
  plotGroupValue,
  plotGroupDomain,
  SUMMABLE,
  ALLOWED_OPERATORS,
  FORBIDDEN_OPERATORS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_FILTER_DEPTH,
  MAX_REGEX_LENGTH,
  QUERY_TIMEOUT_MS,
  MAX_JOIN_IDS,
  SCHEMA_PROMPT,
  buildDateContext,
  needsLayoutFacts,
  MONTH_KEYS as MONTHS,
  type CollectionName,
} from './aiQuery.schema';
import { SOCIETY_FACTS } from '../config/societyFacts';
import Plot from '../models/Plot';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Raised for anything the admin should see as a plain message, not a 500. */
export class AiQueryError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export interface AiQueryResult {
  answer: string;
  rows: Record<string, any>[];
  columns: string[];
  rowCount: number;
  /** Whether rowCount was capped by the limit. */
  truncated: boolean;
  /** The validated plan actually executed — surfaced for admin transparency. */
  plan: Record<string, any>;
  /** Set when the model reinterpreted an unanswerable-as-asked question. */
  note?: string;
}

// ── Groq ────────────────────────────────────────────────────────────────────

/**
 * Reasoning models (Groq's gpt-oss family) spend part of the completion budget on
 * hidden reasoning tokens before writing any answer. Two consequences this code
 * has to allow for:
 *
 *  - reasoning counts against `max_tokens`, so a tight budget returns
 *    `content: ""` with `finish_reason: "length"` — the answer never gets written
 *  - those tokens also count against the account's tokens-per-minute allowance
 *
 * So we ask for the cheapest useful reasoning and leave headroom on top of the
 * caller's budget. Non-reasoning models ignore both adjustments.
 */
const isReasoningModel = (model: string) => /gpt-oss/i.test(model);

/** Extra completion room for a reasoning model's hidden tokens. */
const REASONING_HEADROOM = 700;

async function callGroq(
  messages: { role: string; content: string }[],
  opts: { json?: boolean; maxTokens?: number } = {},
): Promise<string> {
  if (!env.GROQ_API_KEY) {
    throw new AiQueryError(
      'AI chat is not configured — set GROQ_API_KEY on the server (free key at console.groq.com).',
      503,
    );
  }

  const reasoning = isReasoningModel(env.GROQ_MODEL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        messages,
        temperature: 0,
        max_tokens: (opts.maxTokens ?? 900) + (reasoning ? REASONING_HEADROOM : 0),
        ...(reasoning ? { reasoning_effort: 'low' } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429) {
        throw new AiQueryError('Groq rate limit reached — wait a moment and try again.', 429);
      }
      if (res.status === 401) {
        throw new AiQueryError('Groq rejected the API key — check GROQ_API_KEY.', 502);
      }
      throw new AiQueryError(`Groq request failed (${res.status}): ${body.slice(0, 200)}`, 502);
    }

    const data: any = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      // A reasoning model that hits the ceiling mid-thought returns empty content
      // with finish_reason "length". Rephrasing won't help there, so say what
      // actually happened rather than sending the admin round in circles.
      if (choice?.finish_reason === 'length') {
        throw new AiQueryError(
          'The AI ran out of room before answering — try a narrower question.',
          502,
        );
      }
      throw new AiQueryError('Groq returned an empty response — try rephrasing.', 502);
    }
    return content;
  } catch (err: any) {
    if (err instanceof AiQueryError) throw err;
    if (err?.name === 'AbortError') {
      throw new AiQueryError('The AI took too long to respond — try again.', 504);
    }
    throw new AiQueryError(`Could not reach Groq: ${err?.message || 'unknown error'}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Recursively validate an LLM-supplied filter: every `$key` must be in the
 * operator allowlist, every other key must be a whitelisted field path for the
 * collection, and values must be JSON primitives/arrays/objects only.
 */
function validateFilter(
  filter: unknown,
  allowedFields: string[],
  label: string,
  depth = 0,
): Record<string, any> {
  if (filter === undefined || filter === null) return {};
  if (!isPlainObject(filter)) {
    throw new AiQueryError(`${label} must be an object.`);
  }
  if (depth > MAX_FILTER_DEPTH) {
    throw new AiQueryError(`${label} is nested too deeply.`);
  }

  const out: Record<string, any> = {};

  for (const [key, value] of Object.entries(filter)) {
    if (FORBIDDEN_OPERATORS.has(key)) {
      throw new AiQueryError(`Operator ${key} is not permitted.`);
    }

    if (key.startsWith('$')) {
      if (!ALLOWED_OPERATORS.has(key)) {
        throw new AiQueryError(`Operator ${key} is not permitted.`);
      }
      if (key === '$regex') {
        if (typeof value !== 'string') {
          throw new AiQueryError('$regex must be a string.');
        }
        if (value.length > MAX_REGEX_LENGTH) {
          throw new AiQueryError('$regex pattern is too long.');
        }
        out[key] = value;
        continue;
      }
      if (key === '$and' || key === '$or' || key === '$nor') {
        if (!Array.isArray(value) || value.length === 0) {
          throw new AiQueryError(`${key} expects a non-empty array.`);
        }
        out[key] = value.map((v) => validateFilter(v, allowedFields, label, depth + 1));
        continue;
      }
      out[key] = validateValue(value, allowedFields, label, depth);
      continue;
    }

    // Plain field path.
    if (!allowedFields.includes(key)) {
      throw new AiQueryError(`Field "${key}" is not queryable in ${label}.`);
    }
    out[key] = validateValue(value, allowedFields, label, depth);
  }

  return out;
}

function validateValue(
  value: unknown,
  allowedFields: string[],
  label: string,
  depth: number,
): any {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((v) => validateValue(v, allowedFields, label, depth + 1));
  }
  if (isPlainObject(value)) {
    // A nested object here is an operator expression, e.g. { $gt: 5 }.
    return validateFilter(value, allowedFields, label, depth + 1);
  }
  throw new AiQueryError(`Unsupported value type in ${label}.`);
}

function validateCollection(name: unknown): CollectionName {
  if (typeof name !== 'string' || !(name in COLLECTIONS)) {
    throw new AiQueryError(
      `Unknown collection "${String(name)}". Available: ${Object.keys(COLLECTIONS).join(', ')}.`,
    );
  }
  return name as CollectionName;
}

/**
 * Sort and projection are PRESENTATION, so unknown fields are dropped rather
 * than rejected. Models routinely ask to sort payments by `plotNumber` (a plots
 * field) or project `ownerName` alongside a populate; failing the whole question
 * over row order helps nobody, and an unsorted table cannot mislead the way a
 * wrong filter can. `filter`, `plotFilter`, `groupBy`, and `collection` stay
 * strict — those decide *which* records come back.
 */
function validateSort(sort: unknown, allowedFields: string[]): Record<string, 1 | -1> {
  if (!sort || !isPlainObject(sort)) return {};
  const out: Record<string, 1 | -1> = {};
  for (const [field, dir] of Object.entries(sort)) {
    if (!allowedFields.includes(field)) continue;
    out[field] = Number(dir) < 0 ? -1 : 1;
  }
  return out;
}

function validateProjection(projection: unknown, allowedFields: string[]): string[] {
  if (!projection || !Array.isArray(projection)) return [];
  return projection.filter(
    (f): f is string => typeof f === 'string' && allowedFields.includes(f),
  );
}

function clampLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Resolve a `plotFilter` into `{ <refField>: { $in: [ids] } }`. This is the
 * only join mechanism — no $lookup, no $expr.
 */
async function resolvePlotFilter(
  collection: CollectionName,
  plotFilter: unknown,
): Promise<Record<string, any> | null> {
  if (!plotFilter || !isPlainObject(plotFilter) || Object.keys(plotFilter).length === 0) {
    return null;
  }
  const refField = PLOT_REF[collection];
  if (!refField) {
    throw new AiQueryError(`plotFilter is not supported on ${collection}.`);
  }

  const validated = validateFilter(plotFilter, FIELDS.plots, 'plotFilter');
  const ids = await Plot.find(validated)
    .select('_id')
    .limit(MAX_JOIN_IDS + 1)
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .lean();

  if (ids.length > MAX_JOIN_IDS) {
    throw new AiQueryError(
      'That plot filter matches too many plots to join — narrow it down (e.g. one block).',
    );
  }

  return { [refField]: { $in: ids.map((d: any) => d._id as Types.ObjectId) } };
}

/**
 * Repair two join mistakes models make constantly. Both rewrites only MOVE
 * conditions between `filter` and `plotFilter`; everything still goes through
 * validateFilter against the same allowlists afterwards, so this costs no
 * safety — it just turns a confusing error into the answer the admin wanted.
 *
 *  1. `plotFilter` supplied on the `plots` collection itself — semantically
 *     identical to `filter`, so merge it in.
 *  2. Dotted paths through the ref (`plot.block`, `plotRef.ownerName`) inside a
 *     payments/receipts filter — Mongo can't traverse a ref, so lift those keys
 *     into `plotFilter`, which resolves the join properly.
 *  3. `groupBy: "block"` on a collection that only reaches a block through its
 *     plot — that is `plotGroupBy`, so move it there.
 *
 * Only top-level filter keys are rewritten; a dotted ref path buried inside
 * $and/$or still fails validation with a clear message.
 */
function normalisePlan(collection: CollectionName, plan: Record<string, any>): Record<string, any> {
  const out = { ...plan };
  const filter = isPlainObject(out.filter) ? { ...out.filter } : {};

  if (collection === 'plots') {
    if (isPlainObject(out.plotFilter) && Object.keys(out.plotFilter).length) {
      out.filter = Object.keys(filter).length
        ? { $and: [filter, out.plotFilter] }
        : out.plotFilter;
    }
    delete out.plotFilter;
    return out;
  }

  const refField = PLOT_REF[collection];
  if (!refField) {
    delete out.plotFilter;
    return out;
  }

  // 3. `groupBy` naming a plot attribute (`block`, `plot.block`, `phase`) on a
  //    plot-referencing collection. The cash book has no block of its own, so
  //    what the model means is `plotGroupBy`.
  if (out.plotGroupBy == null || out.plotGroupBy === '') {
    const asked = String(out.groupBy ?? '').replace(/^(?:plot|plotRef)\./, '');
    const ownFields = GROUPABLE[collection] || [];
    if ((PLOT_GROUPABLE as readonly string[]).includes(asked) && !ownFields.includes(asked)) {
      out.plotGroupBy = asked;
      delete out.groupBy;
    }
  }

  const lifted: Record<string, any> = isPlainObject(out.plotFilter) ? { ...out.plotFilter } : {};
  let moved = false;

  for (const key of Object.keys(filter)) {
    const match = /^(?:plot|plotRef)\.(.+)$/.exec(key);
    if (match) {
      lifted[match[1]] = filter[key];
      delete filter[key];
      moved = true;
    }
  }

  // Models also nest the month map — { payments: { mar: null } } — where Mongo
  // needs the dotted path { "payments.mar": null }. Expand month keys; anything
  // left under `payments` still fails validation, since bare `payments` is not
  // a queryable path.
  if (collection === 'payments' && isPlainObject(filter.payments)) {
    const nested = { ...filter.payments };
    for (const monthKey of Object.keys(nested)) {
      if ((MONTHS as readonly string[]).includes(monthKey)) {
        filter[`payments.${monthKey}`] = nested[monthKey];
        delete nested[monthKey];
      }
    }
    if (Object.keys(nested).length === 0) delete filter.payments;
    else filter.payments = nested;
    out.filter = filter;
  }

  if (moved) {
    out.filter = filter;
    out.plotFilter = lifted;
    // Owner details are the point of such a query — make sure they show up.
    if (out.populatePlot === undefined) out.populatePlot = true;
  }

  return out;
}

/**
 * Group-by an attribute of the RELATED plot (block, phase, allotment status) for
 * the three collections that reference a plot.
 *
 * Why this exists: the cash book, dues and receipts store no block of their own,
 * so "which block collected least in 2026" has no in-collection field to group
 * on, and $lookup is forbidden. We instead group by the plot ref, then fold
 * those per-plot buckets up in memory using a plot _id -> label map. Cheap
 * because the plot register is a few hundred rows, and it keeps the no-LLM-joins
 * rule intact.
 */
function validatePlotGroupBy(
  collection: CollectionName,
  raw: unknown,
): string | null {
  if (raw == null || raw === '') return null;
  const field = String(raw);
  if (!PLOT_REF[collection]) {
    throw new AiQueryError(
      `plotGroupBy is not supported on ${collection}. It works on ` +
        `${Object.keys(PLOT_REF).join(', ')}.`,
    );
  }
  if (!(PLOT_GROUPABLE as readonly string[]).includes(field)) {
    throw new AiQueryError(
      `Cannot group by plot "${field}". Available: ${PLOT_GROUPABLE.join(', ')}.`,
    );
  }
  return field;
}

/** plot _id -> grouping label, restricted to the ids the join already selected. */
async function buildPlotLabelMap(
  plotGroupBy: string,
  join: Record<string, any> | null,
  refField: string,
): Promise<Map<string, string>> {
  const filter = join ? { _id: join[refField] } : {};
  const plots = await Plot.find(filter)
    .select('block allotmentStatus')
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .lean();
  const map = new Map<string, string>();
  for (const p of plots as any[]) map.set(String(p._id), plotGroupValue(p, plotGroupBy));
  return map;
}

/**
 * Fold per-plot aggregation buckets into per-label buckets.
 *
 * Zero-fills the labels that produced no rows at all (every block, every phase)
 * unless a plotFilter deliberately narrowed the question — without that, a block
 * which collected nothing has no bucket, and "which block collected least"
 * would confidently name the smallest NON-zero block instead.
 */
function foldPlotGroups(
  buckets: Array<{ _id: any; total: number; count: number }>,
  labels: Map<string, string>,
  plotGroupBy: string,
  zeroFill: boolean,
): Array<{ label: string; total: number; count: number }> {
  const acc = new Map<string, { total: number; count: number }>();
  if (zeroFill) {
    for (const label of plotGroupDomain(plotGroupBy) ?? []) acc.set(label, { total: 0, count: 0 });
  }
  for (const b of buckets) {
    const label = labels.get(String(b._id)) ?? 'Unknown';
    const cur = acc.get(label) ?? { total: 0, count: 0 };
    cur.total += b.total || 0;
    cur.count += b.count || 0;
    acc.set(label, cur);
  }
  return [...acc.entries()].map(([label, v]) => ({ label, ...v }));
}

/** -1 = largest first (default), 1 = smallest first, for "lowest"/"fewest". */
function sortDirection(raw: unknown): 1 | -1 {
  return Number(raw) > 0 ? 1 : -1;
}

/**
 * The executed plan is echoed to the admin under "Show query". A resolved
 * `plotFilter` is a literal `$in` of every matching plot _id — hundreds of them
 * on a whole-society question — which buries the readable part of the query. So
 * collapse the id list to a count for display only; the filter that actually ran
 * is untouched.
 */
function echoFilter(match: Record<string, any>, refField?: string): Record<string, any> {
  if (!refField) return match;
  const collapse = (node: any): any => {
    if (Array.isArray(node)) return node.map(collapse);
    if (!isPlainObject(node)) return node;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === refField && isPlainObject(v) && Array.isArray(v.$in)) {
        out[k] = { $in: `<${v.$in.length} plot ids matching plotFilter>` };
      } else {
        out[k] = collapse(v);
      }
    }
    return out;
  };
  return collapse(match);
}

// ── Execution ───────────────────────────────────────────────────────────────

interface Executed {
  rows: Record<string, any>[];
  plan: Record<string, any>;
  truncated: boolean;
  rowCount: number;
  /**
   * Underlying documents behind the rows, where that differs from `rowCount`.
   * Zero-filled groupings return a full row per block even when NOTHING matched,
   * so without this the summariser announces "block A has the lowest collection"
   * for a period where no collection was ever recorded.
   */
  matched?: number;
}

async function executeFind(rawPlan: Record<string, any>): Promise<Executed> {
  const collection = validateCollection(rawPlan.collection);
  const plan = normalisePlan(collection, rawPlan);
  const fields = FIELDS[collection];
  const Model: any = COLLECTIONS[collection];

  const filter = validateFilter(plan.filter, fields, collection);
  const sort = validateSort(plan.sort, fields);
  const projection = validateProjection(plan.projection, fields);
  const limit = clampLimit(plan.limit);

  const join = await resolvePlotFilter(collection, plan.plotFilter);
  const finalFilter = join ? { $and: [filter, join] } : filter;

  let q = Model.find(finalFilter);
  if (projection.length) q = q.select(projection.join(' '));
  else q = q.select('-__v');
  if (Object.keys(sort).length) q = q.sort(sort);

  // Fetch one extra row to detect truncation without a second count query.
  q = q.limit(limit + 1).maxTimeMS(QUERY_TIMEOUT_MS).lean();

  const refField = PLOT_REF[collection];
  if (plan.populatePlot && refField) {
    q = q.populate(refField, 'ownerName plotBlock block phase -_id');
  }

  const docs: any[] = await q;
  const truncated = docs.length > limit;

  return {
    rows: docs.slice(0, limit).map(flattenRow),
    plan: {
      op: 'find', collection, filter: echoFilter(finalFilter, refField), sort, projection, limit,
      populatePlot: !!plan.populatePlot,
    },
    truncated,
    rowCount: Math.min(docs.length, limit),
  };
}

async function executeCount(rawPlan: Record<string, any>): Promise<Executed> {
  const collection = validateCollection(rawPlan.collection);
  const plan = normalisePlan(collection, rawPlan);
  const fields = FIELDS[collection];
  const Model: any = COLLECTIONS[collection];

  const filter = validateFilter(plan.filter, fields, collection);
  const join = await resolvePlotFilter(collection, plan.plotFilter);
  const finalFilter = join ? { $and: [filter, join] } : filter;

  const count = await Model.countDocuments(finalFilter).maxTimeMS(QUERY_TIMEOUT_MS);

  return {
    rows: [{ collection, count }],
    plan: { op: 'count', collection, filter: echoFilter(finalFilter, PLOT_REF[collection]) },
    truncated: false,
    rowCount: 1,
  };
}

/**
 * Dues summed per plot across a year range, joined to owner details.
 *
 * The pipeline is built here from validated scalars — the model supplies only
 * the year range, thresholds, sort direction, limit, and an optional plotFilter.
 * `remaining` on a single payment doc covers one year only (max mcRate*12), so
 * this is the only correct way to answer "dues over N" for N above 4800.
 */
async function executeSumDuesByPlot(plan: Record<string, any>): Promise<Executed> {
  const yearFrom = Number.isFinite(Number(plan.yearFrom)) ? Number(plan.yearFrom) : null;
  const yearTo = Number.isFinite(Number(plan.yearTo)) ? Number(plan.yearTo) : null;
  const min = Number.isFinite(Number(plan.minTotalRemaining)) ? Number(plan.minTotalRemaining) : null;
  let max = Number.isFinite(Number(plan.maxTotalRemaining)) ? Number(plan.maxTotalRemaining) : null;

  // Models often send 0 for "no upper bound" despite the prompt asking them to
  // omit it, which would make `$gte: min, $lte: 0` unsatisfiable and silently
  // return nothing. An upper bound below the lower bound is never intentional.
  // (min === max === 0 is left alone — that legitimately means "fully paid".)
  if (max !== null && min !== null && max < min) max = null;
  const sortDir: 1 | -1 = Number(plan.sortDir) > 0 ? 1 : -1;
  const limit = clampLimit(plan.limit);

  const match: Record<string, any> = {};
  if (yearFrom !== null || yearTo !== null) {
    match.year = {};
    if (yearFrom !== null) match.year.$gte = yearFrom;
    if (yearTo !== null) match.year.$lte = yearTo;
  }

  const join = await resolvePlotFilter('payments', plan.plotFilter);
  if (join) Object.assign(match, join);

  const having: Record<string, any> = {};
  if (min !== null) having.$gte = min;
  if (max !== null) having.$lte = max;

  const Payment: any = COLLECTIONS.payments;
  const grouped: any[] = await Payment.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $group: {
        _id: '$plot',
        totalRemaining: { $sum: '$remaining' },
        totalReceived: { $sum: '$totalReceived' },
        totalDue: { $sum: '$totalDue' },
        years: { $sum: 1 },
      },
    },
    ...(Object.keys(having).length ? [{ $match: { totalRemaining: having } }] : []),
    { $sort: { totalRemaining: sortDir } },
    { $limit: limit + 1 },
  ]).option({ maxTimeMS: QUERY_TIMEOUT_MS });

  const truncated = grouped.length > limit;
  const page = grouped.slice(0, limit);

  // Attach owner details in one extra read rather than a $lookup stage.
  const plots = await Plot.find({ _id: { $in: page.map((g) => g._id) } })
    .select('ownerName plotBlock block phase allotmentStatus')
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .lean();
  const byId = new Map(plots.map((p: any) => [String(p._id), p]));

  const rows = page.map((g) => {
    const p: any = byId.get(String(g._id)) || {};
    return {
      ownerName: p.ownerName ?? '—',
      plotBlock: p.plotBlock ?? '—',
      block: p.block ?? '—',
      phase: p.phase ?? '—',
      allotmentStatus: p.allotmentStatus ?? '—',
      years: g.years,
      totalDue: g.totalDue,
      totalReceived: g.totalReceived,
      totalRemaining: g.totalRemaining,
    };
  });

  return {
    rows,
    plan: {
      op: 'sumDuesByPlot', yearFrom, yearTo,
      minTotalRemaining: min, maxTotalRemaining: max, sortDir, limit,
      plotFilter: plan.plotFilter ?? null,
    },
    truncated,
    rowCount: rows.length,
  };
}

/**
 * Counts grouped by one field. Pipeline built server-side.
 *
 * Grouping is by a field on the collection (`groupBy`) or by an attribute of the
 * related plot (`plotGroupBy`) — see foldPlotGroups for why the second case is
 * folded in memory instead of joined.
 */
async function executeGroupCount(rawPlan: Record<string, any>): Promise<Executed> {
  const collection = validateCollection(rawPlan.collection);
  const plan = normalisePlan(collection, rawPlan);
  const plotGroupBy = validatePlotGroupBy(collection, plan.plotGroupBy);

  let groupBy = '';
  if (!plotGroupBy) {
    const groupable = GROUPABLE[collection];
    if (!groupable) {
      throw new AiQueryError(
        `Grouping is not supported on ${collection}.` +
          (PLOT_REF[collection] ? ` Use plotGroupBy (${PLOT_GROUPABLE.join(', ')}).` : ''),
      );
    }
    groupBy = String(plan.groupBy || '');
    if (!groupable.includes(groupBy)) {
      throw new AiQueryError(
        `Cannot group ${collection} by "${groupBy}". Available: ${groupable.join(', ')}` +
          (PLOT_REF[collection]
            ? `, or plotGroupBy: ${PLOT_GROUPABLE.join(', ')}.`
            : '.'),
      );
    }
  }

  const fields = FIELDS[collection];
  const filter = validateFilter(plan.filter, fields, collection);
  const join = await resolvePlotFilter(collection, plan.plotFilter);
  const match = join ? { $and: [filter, join] } : filter;
  const limit = clampLimit(plan.limit);
  const sortDir = sortDirection(plan.sortDir);

  const Model: any = COLLECTIONS[collection];
  const refField = PLOT_REF[collection];
  const groupKey = plotGroupBy ? `$${refField}` : `$${groupBy}`;

  const buckets: any[] = await Model.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    { $group: { _id: groupKey, count: { $sum: 1 } } },
    // A plot-grouped query must keep every per-plot bucket to fold correctly;
    // only a direct group can be sorted and cut in the pipeline.
    ...(plotGroupBy ? [] : [{ $sort: { count: sortDir } }, { $limit: limit }]),
  ]).option({ maxTimeMS: QUERY_TIMEOUT_MS });

  if (!plotGroupBy) {
    return {
      rows: buckets.map((g) => ({ [groupBy]: g._id ?? '—', count: g.count })),
      plan: {
        op: 'groupCount', collection, groupBy,
        filter: echoFilter(match, refField), sortDir, limit,
      },
      truncated: false,
      rowCount: buckets.length,
    };
  }

  const labels = await buildPlotLabelMap(plotGroupBy, join, refField!);
  const folded = foldPlotGroups(buckets as any[], labels, plotGroupBy, !join)
    .sort((a, b) => (a.count - b.count) * sortDir)
    .slice(0, limit);

  return {
    rows: folded.map((g) => ({ [plotGroupBy]: g.label, count: g.count })),
    plan: {
      op: 'groupCount', collection, plotGroupBy,
      filter: echoFilter(match, refField), sortDir, limit,
      zeroFilled: !join,
    },
    truncated: false,
    rowCount: folded.length,
    matched: folded.reduce((n, g) => n + g.count, 0),
  };
}

/**
 * Total a money field, optionally broken down by one field. Pipeline built
 * server-side from validated scalars — the model supplies only names and filters.
 *
 * Exists because "how much did we spend last year" is unanswerable with the other
 * operations: `find` would return rows for the admin to add up by hand, and
 * `groupCount` counts documents rather than summing money.
 */
async function executeSumAmount(rawPlan: Record<string, any>): Promise<Executed> {
  const collection = validateCollection(rawPlan.collection);
  const plan = normalisePlan(collection, rawPlan);

  const summable = SUMMABLE[collection];
  if (!summable) {
    throw new AiQueryError(
      `Totalling is not supported on ${collection}. Summable collections: ` +
        `${Object.keys(SUMMABLE).join(', ')}.`,
    );
  }
  const field = String(plan.field || '');
  if (!summable.includes(field)) {
    throw new AiQueryError(
      `Cannot total "${field}" on ${collection}. Available: ${summable.join(', ')}.`,
    );
  }

  // Both breakdowns are optional; with neither we return a single grand total.
  // `plotGroupBy` is what makes "by block" / "by phase" answerable on the cash
  // book, dues and receipts, none of which carry a block of their own.
  const plotGroupBy = validatePlotGroupBy(collection, plan.plotGroupBy);
  let groupBy = '';
  if (!plotGroupBy && plan.groupBy != null && plan.groupBy !== '') {
    const groupable = GROUPABLE[collection] || [];
    groupBy = String(plan.groupBy);
    if (!groupable.includes(groupBy)) {
      throw new AiQueryError(
        `Cannot group ${collection} by "${groupBy}". Available: ${groupable.join(', ') || 'none'}` +
          (PLOT_REF[collection]
            ? `, or plotGroupBy: ${PLOT_GROUPABLE.join(', ')}.`
            : '.'),
      );
    }
  }

  const fields = FIELDS[collection];
  const filter = validateFilter(plan.filter, fields, collection);
  const join = await resolvePlotFilter(collection, plan.plotFilter);
  const match = join ? { $and: [filter, join] } : filter;
  const limit = clampLimit(plan.limit);
  const sortDir = sortDirection(plan.sortDir);

  const Model: any = COLLECTIONS[collection];
  const refField = PLOT_REF[collection];
  const groupKey = plotGroupBy ? `$${refField}` : groupBy ? `$${groupBy}` : null;

  const grouped: any[] = await Model.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $group: {
        _id: groupKey,
        total: { $sum: `$${field}` },
        count: { $sum: 1 },
      },
    },
    // Plot-grouped queries are sorted after folding; the rest can be cut here.
    ...(plotGroupBy
      ? []
      : [{ $sort: { total: sortDir } }, { $limit: groupBy ? limit : 1 }]),
  ]).option({ maxTimeMS: QUERY_TIMEOUT_MS });

  if (plotGroupBy) {
    const labels = await buildPlotLabelMap(plotGroupBy, join, refField!);
    const folded = foldPlotGroups(grouped as any[], labels, plotGroupBy, !join)
      .sort((a, b) => (a.total - b.total) * sortDir)
      .slice(0, limit);

    return {
      rows: folded.map((g) => ({
        [plotGroupBy]: g.label,
        [`total ${field}`]: g.total,
        records: g.count,
      })),
      plan: {
        op: 'sumAmount', collection, field, plotGroupBy,
        filter: echoFilter(match, refField), sortDir, limit,
        zeroFilled: !join,
      },
      truncated: false,
      rowCount: folded.length,
      matched: folded.reduce((n, g) => n + g.count, 0),
    };
  }

  const rows = groupBy
    ? grouped.map((g) => ({ [groupBy]: g._id ?? '—', [`total ${field}`]: g.total, records: g.count }))
    : [{ [`total ${field}`]: grouped[0]?.total ?? 0, records: grouped[0]?.count ?? 0 }];

  return {
    rows,
    plan: {
      op: 'sumAmount', collection, field, groupBy: groupBy || null,
      filter: echoFilter(match, refField), sortDir, limit,
    },
    truncated: false,
    rowCount: rows.length,
    // A grand total always produces one row, so rowCount alone can't tell an
    // admin apart "we collected nothing" from "nothing was ever recorded".
    matched: grouped.reduce((n, g) => n + (g.count || 0), 0),
  };
}

/**
 * Flatten a Mongo doc into table-friendly scalar columns: populated plot refs
 * become ownerName/plotBlock/..., the nested month map becomes payments.jan etc.
 */
function flattenRow(doc: any): Record<string, any> {
  const out: Record<string, any> = {};

  for (const [key, value] of Object.entries(doc)) {
    if (key === '__v') continue;

    if (value instanceof Date) {
      out[key] = value.toISOString().slice(0, 10);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // A populated ref (plain object of scalars) or the month map.
      for (const [sub, subVal] of Object.entries(value as Record<string, any>)) {
        if (subVal === null || typeof subVal !== 'object') {
          out[key === 'plot' || key === 'plotRef' ? sub : `${key}.${sub}`] = subVal;
        }
      }
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.length;
      continue;
    }
    out[key] = value;
  }

  if (out._id) out._id = String(out._id);
  return out;
}

// ── Orchestration ───────────────────────────────────────────────────────────

function parsePlanResponse(raw: string): { plan?: any; reinterpreted?: string; unsupported?: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some models wrap JSON in prose or fences despite json_object mode.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new AiQueryError('The AI did not return a usable query — try rephrasing.', 502);
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new AiQueryError('The AI did not return a usable query — try rephrasing.', 502);
    }
  }
  if (!isPlainObject(parsed)) {
    throw new AiQueryError('The AI did not return a usable query — try rephrasing.', 502);
  }
  // Tolerate a bare plan object without the envelope.
  if (!parsed.plan && typeof parsed.op === 'string') return { plan: parsed };
  return parsed;
}

async function summarise(question: string, result: Executed): Promise<string> {
  const preview = JSON.stringify(result.rows.slice(0, 8));
  try {
    const text = await callGroq(
      [
        {
          role: 'system',
          content:
            'Summarise database results for a housing-society admin in ONE short sentence. ' +
            'State the count and the most useful specific detail. Amounts are Pakistani rupees (PKR). ' +
            'Never invent numbers that are not in the data. No preamble, no markdown.',
        },
        {
          role: 'user',
          content:
            `Question: ${question}\n` +
            `Rows returned: ${result.rowCount}${result.truncated ? ' (capped by limit)' : ''}\n` +
            `Sample: ${preview.slice(0, 2000)}`,
        },
      ],
      { maxTokens: 120 },
    );
    return text.trim();
  } catch {
    // A failed summary shouldn't discard good data.
    return result.rowCount === 0
      ? 'No records matched that question.'
      : `Found ${result.rowCount} matching record${result.rowCount === 1 ? '' : 's'}.`;
  }
}

/**
 * Answer a natural-language question about the database, read-only.
 */
export async function answerQuestion(question: string): Promise<AiQueryResult> {
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: SCHEMA_PROMPT },
    { role: 'system', content: buildDateContext() },
    // Physical-layout facts (plot types, per-block ranges). Not database fields,
    // so the model cannot derive them — but ~600 tokens on every question would
    // halve the free tier's questions-per-minute, hence the gate.
    ...(needsLayoutFacts(question)
      ? [{ role: 'system', content: SOCIETY_FACTS }]
      : []),
    { role: 'user', content: question },
  ];

  let executed: Executed | null = null;
  let reinterpreted: string | undefined;
  let lastError: AiQueryError | null = null;

  // Two attempts: models reliably get some plan shapes wrong (treating the month
  // map as an array, filtering through a ref), and handing the validation error
  // back fixes it far more generally than special-casing each mistake here.
  for (let attempt = 0; attempt < 2 && !executed; attempt++) {
    const planRaw = await callGroq(messages, { json: true });
    const parsed = parsePlanResponse(planRaw);
    const plan = parsed.plan;

    if (parsed.unsupported && !plan) {
      // Models over-use this verdict, most often claiming a question needs a
      // join ("blocks aren't on collections") when plotFilter/plotGroupBy
      // already cover exactly that. Push back once before giving up — the same
      // one-retry budget the validator errors use.
      if (attempt === 0) {
        messages.push(
          { role: 'assistant', content: JSON.stringify({ unsupported: parsed.unsupported }) },
          {
            role: 'user',
            content:
              'Reconsider — that is very likely answerable. Cross-collection questions ' +
              'ARE supported: `plotFilter` filters by the related plot and `plotGroupBy` ' +
              '("block", "phase", "allotmentStatus") groups by it, so per-block or ' +
              'per-phase totals of collections/payments/receipts work without any join. ' +
              'Use "sortDir": 1 for lowest/least and -1 for highest/most. Return a plan; ' +
              'only repeat "unsupported" if no field in the schema holds the information ' +
              'at all, and if you do, name the specific missing field.',
          },
        );
        continue;
      }
      throw new AiQueryError(
        `That can't be answered from this database: ${String(parsed.unsupported).slice(0, 300)}`,
        422,
      );
    }
    if (!isPlainObject(plan) || typeof plan.op !== 'string') {
      throw new AiQueryError('The AI did not return a usable query — try rephrasing.', 502);
    }

    try {
      switch (plan.op) {
        case 'find':          executed = await executeFind(plan); break;
        case 'count':         executed = await executeCount(plan); break;
        case 'sumDuesByPlot': executed = await executeSumDuesByPlot(plan); break;
        case 'groupCount':    executed = await executeGroupCount(plan); break;
        case 'sumAmount':     executed = await executeSumAmount(plan); break;
        default:
          throw new AiQueryError(
            `Unsupported operation "${plan.op}". Use one of: find, count, ` +
              `sumDuesByPlot, groupCount, sumAmount.`,
          );
      }
      reinterpreted = parsed.reinterpreted;
    } catch (err) {
      // Only plan-shape problems are worth retrying; infrastructure errors are not.
      if (!(err instanceof AiQueryError) || err.status !== 400 || attempt === 1) throw err;
      lastError = err;
      messages.push(
        { role: 'assistant', content: JSON.stringify({ plan }) },
        {
          role: 'user',
          content:
            `That plan was rejected by the query validator: ${err.message}\n` +
            'Fix the plan and return corrected JSON. Remember: `payments` is an ' +
            'embedded object (use dotted paths like "payments.mar", never ' +
            '$elemMatch), and filtering the related plot must go in `plotFilter`, ' +
            'never as "plot.<field>" inside `filter`.',
        },
      );
    }
  }

  if (!executed) {
    throw lastError ?? new AiQueryError('Could not build a valid query — try rephrasing.', 502);
  }

  // An empty result is stated flatly rather than summarised. Asked "who hasn't
  // paid this month", the model happily reports "0 residents haven't paid" —
  // which reads as "everyone is paid up" when it usually means no data was ever
  // recorded for that period. Wrong-but-confident answers about who owes money
  // are the ones an admin would act on.
  const answer =
    executed.rowCount === 0 || executed.matched === 0
      ? 'No records matched. An empty result can mean the data was never recorded rather than ' +
        'that nothing is outstanding — check the query below to see what was actually asked of the database.'
      : await summarise(question, executed);

  // Union the keys — sparse docs would otherwise hide columns.
  const columns: string[] = [];
  for (const row of executed.rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  return {
    answer,
    rows: executed.rows,
    columns,
    rowCount: executed.rowCount,
    truncated: executed.truncated,
    plan: executed.plan,
    ...(reinterpreted ? { note: String(reinterpreted).slice(0, 300) } : {}),
  };
}
