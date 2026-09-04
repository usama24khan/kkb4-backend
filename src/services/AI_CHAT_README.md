# AI Database Chat — how it works and where the walls are

Admin-only feature letting an admin ask plain-English questions about the KKB4
database ("who hasn't paid maintenance in block B this month") and get back a
one-line answer plus a results table.

## Files

| File | Role |
|---|---|
| `aiQuery.schema.ts` | Whitelists: collections, queryable fields, allowed operators, limits. Also holds the schema description sent to the LLM. **Single source of truth for what the AI may touch.** |
| `../config/societyFacts.ts` | **Generated.** Site-plan facts (plot types, per-block number ranges) for questions the database cannot answer. Rebuild with `node scripts/gen-society-facts.mjs` from the repo root. |
| `aiQuery.service.ts` | Groq calls, plan validation, read-only execution, result summarisation. |
| `../controllers/aiQuery.controller.ts` | Input validation (length, type) and error mapping. |
| `../routes/aiQuery.routes.ts` | `POST /api/ai/query`, `GET /api/ai/capabilities` — both behind `authMiddleware` + `adminOnly`. |

## Request flow

1. Admin sends a question to `POST /api/ai/query`.
2. Groq (`openai/gpt-oss-120b`, free tier) receives the schema description
   and returns **JSON only** — never a query string, never code.
3. The JSON names one of four read-only operations and supplies parameters.
4. `aiQuery.service.ts` validates every collection, field path, and operator in
   those parameters against the allowlist. A single unrecognised key aborts the
   request before Mongo is touched.
5. The validated plan runs read-only. Aggregation pipelines are assembled **in
   our code** from validated scalars; the model never supplies pipeline stages.
6. Results go back to Groq for a one-sentence summary, then to the client.

## Safety boundaries

**Read-only by construction.** The only Mongo calls in this feature are
`find`, `countDocuments`, and `aggregate` with server-authored pipelines. There
is no code path to `save`, `update*`, `delete*`, `insert*`, or `bulkWrite`.

**Allowlisted collections.** `plots`, `payments`, `receipts`, `blocks`,
`phases`, `years`, `monthlyrates`, `complaints`, `collections`, `expenses`,
`expensecategories`, `financesettings`, `notices`.
Deliberately excluded: `admins` (password hashes), `otps`, `devices`,
`auditlogs`, `counters` (an internal sequence allocator). Requesting one of
these is rejected as an unknown collection.

Some fields are withheld even from allowlisted collections, because they carry
no analytical value and only widen the surface: `expenses.attachmentUrl` (a raw
bill-image URL), `notices.pdfPath`/`pdfPaths` (file paths), the `recordedBy` /
`voidedBy` / `generatedBy` admin references, and `collections.allocations` (an
array of subdocuments — the pre-computed arrears/current/advance split already
answers the same questions without exposing `$elemMatch`).

**Allowlisted fields.** Per-collection field lists in `FIELDS`, including the
dotted month paths (`payments.jan` … `payments.dec`). A filter, sort, or
projection referencing anything else is rejected.

**Allowlisted operators.** Only `$eq $ne $gt $gte $lt $lte $in $nin $and $or
$nor $not $exists $regex $options $size $all $elemMatch`. Because this is an
allowlist, anything new is blocked by default. `FORBIDDEN_OPERATORS` names
`$where`, `$function`, `$accumulator`, `$expr`, `$out`, `$merge`, `$lookup`,
and the update operators explicitly as defence in depth.

**No LLM-authored joins.** Cross-collection work happens only through two
server-resolved mechanisms: `plotFilter`, which we turn into
`{ plot: { $in: [ids] } }` (capped at 5,000 ids), and `plotGroupBy`, which folds
per-plot aggregation buckets up by block/phase/allotment status using a plot
`_id` → label map we build ourselves. No `$lookup`, no `$graphLookup`, no
`$expr`.

**Bounded cost.** Results clamp to 200 rows (default 25), filters to 6 levels
of nesting, `$regex` patterns to 100 characters, and every query carries
`maxTimeMS: 8000`. Rate limit: 30 questions per admin IP per 5 minutes. Groq's own free tier also
has a per-minute cap that rapid use can hit; it surfaces as a "wait a moment"
message rather than an error page.

**Admin-only.** Same `authMiddleware` + `adminOnly` chain as the rest of the
admin API, so the `viewer` role is excluded too.

## Robustness: what happens when the model gets the plan wrong

Real testing showed the model reliably makes a handful of plan mistakes. These
are handled without loosening any allowlist:

1. **Plan normalisation** (`normalisePlan`) MOVES misplaced conditions before
   validation — `plotFilter` supplied on `plots` is merged into `filter`, and
   `plot.block` style dotted ref paths are lifted into `plotFilter`. Everything
   still passes through `validateFilter` afterwards.
2. **One automatic retry.** If validation rejects the plan — or the model claims
   the question is `unsupported` — the reason is fed back with a correction hint
   and it tries once more. This fixes new
   mistake shapes generically instead of needing a code change each time. Worst
   case is therefore three Groq calls per question (plan, retry, summary).
3. **Sort and projection degrade gracefully.** Unknown fields there are dropped,
   not rejected — row order is presentation and cannot mislead, whereas a wrong
   `filter` would change *which* records come back, so filters stay strict.
4. **Contradictory dues bounds are ignored.** Models send
   `maxTotalRemaining: 0` to mean "no maximum", which combined with a minimum
   would be unsatisfiable and silently return nothing. An upper bound below the
   lower bound is dropped.
5. **Today's date is injected per request** (`buildDateContext`). Without it the
   model guessed the current year and quietly queried the wrong one.
6. **Empty results are never summarised by the model.** Asked "who hasn't paid
   this month", it would report "0 residents haven't paid" — which reads as
   "everyone is paid up" when it usually means no data exists for that period.
   Zero rows now return a fixed, honest message instead.

## The cash book vs. dues — the distinction most likely to be got wrong

`payments` and `collections` both hold money and are easy to conflate:

- **`payments`** records *what the money is for* — which months of dues are cleared.
- **`collections`** records *when the cash physically arrived* (`receivedDate` →
  `bookYear`/`bookMonth`).

A payment handed over in March 2026 clearing 2015 dues sits in `bookYear 2026`
in `collections` and in `year 2015` in `payments`. So "how much did we collect
in <period>" is a `collections` question, while "which months are unpaid" is a
`payments` question. The prompt states this explicitly with worked examples.

Two filters are near-mandatory on `collections`, and the prompt says so:
`isVoided: false` (reversed mistakes) and `countInCashBook: true` (historical
backfill for money collected *and spent* years ago — including it inflates
income badly). `expenses` needs `isVoided: false` for the same reason.

## Site-plan knowledge

Plot *type* — regular, odd size, prime, mortgage — exists only on the approved
site plan; no collection stores it. `societyFacts.ts` carries a compact prose
summary (440 plots, per-block number ranges, the amenity list) generated from
`frontend-admin/constants/societyMap.ts`, which is where the map is drawn.

It is attached as its own system message, but **only when the question looks
like a layout question** (`needsLayoutFacts`). The gate exists for cost, not
correctness: see the token budget below. The prompt also tells the planner never
to invent a `category`/`plotType` field on `plots`, so a layout question that
slips past the gate returns an honest "this is about the site plan" rather than a
fabricated filter.

The generated file must be rebuilt when the map changes:

```
node scripts/gen-society-facts.mjs
```

## Token budget — the real ceiling on the free tier

Groq's free tier caps at **8,000 tokens per minute**, and that, not request
count, is what an admin runs into. Measured cost per question:

| Case | Approx. tokens |
|---|---|
| Normal question, no retry | ~3,300 |
| Normal question, one retry | ~6,200 |
| Layout question, no retry | ~3,800 |

So roughly **two questions per minute**, or one if a retry fires. The planner
prompt is ~2,700 tokens because it documents 13 collections; a retry resends the
whole message array, which is what makes retries expensive.

Levers, cheapest first: leave the layout gate in place; set `GROQ_MODEL` to a
smaller model; or move off the free tier, at which point the gate can be dropped
and `SOCIETY_FACTS` attached unconditionally.

## Live-data quirks the prompt must account for

These are properties of the actual database, not the models:

- **Phases are unmigrated.** Plot records store `Phase 1`–`Phase 6` (the old
  scheme), not the `Phase 1/2/3/P` map in `constants.ts`. The prompt therefore
  forbids filtering on `phase` and supplies phase→blocks mappings instead, since
  `block` is authoritative. Running `npm run migrate:phases` would let this
  restriction be relaxed.
- **`isActive: false` == `allotmentStatus: "Cancelled"`.** They are the same 11
  records. So "add `isActive: true`" must NOT be applied to questions about
  cancelled/inactive plots, or the answer is always zero.
- **Payment year coverage is uneven.** Some blocks only have early years (block B
  has 2012–2014 only). A recent-year question returning nothing usually means no
  data, not full payment.

## Operations the model can request

| Op | Purpose |
|---|---|
| `find` | Read documents from one collection, with optional `plotFilter` join and `populatePlot`. |
| `count` | How many documents match. |
| `sumDuesByPlot` | Dues summed **across years** per plot, joined to owner details. |
| `groupCount` | Counts grouped by one field of the collection (`groupBy`) or of the related plot (`plotGroupBy`). |
| `sumAmount` | Totals a money field, optionally broken down by `groupBy` or `plotGroupBy`. |

Both grouped operations take `sortDir`: `-1` (largest first, the default) or `1`
for a "lowest / least / fewest" question.

`sumAmount` exists because "how much did we spend last year" was previously
unanswerable: `find` would return rows for the admin to add up by hand, and
`groupCount` counts documents rather than summing money. Summable fields are a
separate allowlist (`SUMMABLE`) from `FIELDS`, because totalling a year, an
ordinal, or an `_id` is never a sensible answer and would produce confident
nonsense.

## Grouping by block or phase — `plotGroupBy`

`collections` (the cash book), `payments` and `receipts` store no block, phase or
owner of their own; those live on the related plot. So "which block has the
lowest collection in 2026" has no field on the collection to group by, and
`$lookup` is forbidden. Before `plotGroupBy` existed the planner correctly
concluded it could not be done and answered *"joins are not supported"* — a real
question about data we hold, refused.

`plotGroupBy` (`block`, `phase`, `allotmentStatus`) closes that gap:

1. Aggregate grouped by the plot ref, giving one bucket per plot.
2. Build a plot `_id` → label map (a few hundred rows — cheaper than a join).
3. Fold the buckets into per-label totals in memory, then sort and cut.

Two details that matter for correctness:

- **`phase` is derived from the plot's block** via `BLOCK_PHASE_MAP`, not read
  off `plots.phase`, so phase grouping is immune to the unmigrated legacy phase
  values that the rest of the prompt has to work around.
- **Missing buckets are zero-filled** from `ALL_BLOCKS` / `ALL_PHASES` whenever no
  `plotFilter` narrowed the question. Without this, a block that collected
  nothing produces no aggregation row, and "which block collected least" would
  confidently name the smallest *non-zero* block. The plan echoes
  `zeroFilled: true` so the admin can see it happened.

`sortDir` exists for the same reason: the pipeline used to hardcode
`{ total: -1 }`, so a "lowest" question was answered with a largest-first list.

Two planner repairs support this: `normalisePlan` moves a `groupBy` that names a
plot attribute (`block`, `plot.block`, `phase`) into `plotGroupBy`, and an
`unsupported` verdict now gets **one push-back** reminding the model that
`plotFilter`/`plotGroupBy` cover cross-collection questions, before it is
reported to the admin. Models over-use that verdict, and refusing a question we
can actually answer is the worst failure this feature has.

## Schema quirks the prompt has to teach the model

- **`payments` is one document per plot per year.** `remaining` therefore covers
  a single year and caps at `mcRate × 12` (4,800). Any "dues over N" question
  where N > 4,800 must use `sumDuesByPlot`, not a `find` on `remaining`.
- **`null` means unpaid** in `payments.jan … payments.dec`. Zero is not used.
- **There is no per-month payment timestamp.** Questions like "no payment in 90
  days" cannot be answered literally. The model reinterprets them as unpaid
  months of the relevant year and returns a `note` explaining the substitution,
  which the UI shows above the table — so nobody reads the answer as something
  it isn't.

## Configuration

Set `GROQ_API_KEY` (free, no card: https://console.groq.com). Optionally
override `GROQ_MODEL`. With no key set, `GET /api/ai/capabilities` reports
`configured: false` and the UI shows a setup notice rather than failing on the
first question.

### Choosing a model

The default is `openai/gpt-oss-120b`, Groq's recommended replacement for
`llama-3.3-70b-versatile` (decommissioned 2026-08-16).

Two things to know before switching it:

- **JSON mode is mandatory here.** The planner asks for
  `response_format: json_object`; a model that cannot honour that is unusable.
  `qwen/qwen3.6-27b` — the other suggested replacement — fails these requests
  with "Failed to generate JSON", so it is not an option without rewriting the
  planner to parse free text.
- **Reasoning models need headroom.** The gpt-oss family spends completion
  tokens on hidden reasoning before answering, so `callGroq` sends
  `reasoning_effort: 'low'` and adds `REASONING_HEADROOM` to `max_tokens`.
  Without that, a hard question returns empty content with
  `finish_reason: "length"`. `gpt-oss-20b` is cheaper and faster but answered a
  simple plot count wrongly in testing, so 120b is the default.

The free tier's ceiling is tokens-per-minute (8,000 at the time of writing), not
requests. Each question costs up to two model calls, so a few questions in quick
succession can hit a 429; the UI surfaces that as a rate-limit message.

## Follow-up recommended: read-only Mongo user

The feature is read-only in code, but it currently shares the app's regular
MongoDB connection, which has write privileges. For defence in depth, create a
`readAnyDatabase`-scoped (or `read`-on-`kkb4_maintenance`) user in MongoDB
Atlas, and open a second Mongoose connection for this service using it. That
requires Atlas credentials, so it wasn't done here — it needs someone with
project access to create the user first.
