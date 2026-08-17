# AI Database Chat — how it works and where the walls are

Admin-only feature letting an admin ask plain-English questions about the KKB4
database ("who hasn't paid maintenance in block B this month") and get back a
one-line answer plus a results table.

## Files

| File | Role |
|---|---|
| `aiQuery.schema.ts` | Whitelists: collections, queryable fields, allowed operators, limits. Also holds the schema description sent to the LLM. **Single source of truth for what the AI may touch.** |
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
`phases`, `years`, `monthlyrates`, `complaints`.
Deliberately excluded: `admins` (password hashes), `otps`, `devices`,
`auditlogs`. Requesting one of these is rejected as an unknown collection.

**Allowlisted fields.** Per-collection field lists in `FIELDS`, including the
dotted month paths (`payments.jan` … `payments.dec`). A filter, sort, or
projection referencing anything else is rejected.

**Allowlisted operators.** Only `$eq $ne $gt $gte $lt $lte $in $nin $and $or
$nor $not $exists $regex $options $size $all $elemMatch`. Because this is an
allowlist, anything new is blocked by default. `FORBIDDEN_OPERATORS` names
`$where`, `$function`, `$accumulator`, `$expr`, `$out`, `$merge`, `$lookup`,
and the update operators explicitly as defence in depth.

**No LLM-authored joins.** Cross-collection filtering happens only through
`plotFilter`, which we resolve ourselves into `{ plot: { $in: [ids] } }`,
capped at 5,000 ids. No `$lookup`, no `$graphLookup`, no `$expr`.

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
2. **One automatic retry.** If validation rejects the plan, the error is fed back
   to the model with a correction hint and it tries once more. This fixes new
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
| `groupCount` | Counts grouped by one low-cardinality field (e.g. plots per block). |

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
