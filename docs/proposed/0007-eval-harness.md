# 0007 — The evaluation harness

**Status:** proposed · **Backlog:** `RM-00` · **Depends on:** nothing · **Blocks:** everything

## Why this is first

Every capability on the roadmap — extraction, dedup, supersession, decay, Hebbian tuning — is
a feature that **can make the system worse**. An extraction pass that drops a nuance, a
supersession rule that hides a true fact, a decay curve that prunes the one thing you needed.
Without measurement you cannot tell the difference between shipping a feature and shipping a
regression, and you will not find out for months.

The market makes this vivid. Mem0 and Zep are in a public credibility fight over LOCOMO —
84% → 58.44% → 75.14%, every number contested, independent observers advising that no vendor
number be trusted. That happened because numbers shipped ahead of methodology.

**Our counter-position is not a better number. It is reproducibility.** A harness anyone can
run offline in under a minute, on their own machine, with committed fixtures and fixed seeds,
is a claim hosted vendors structurally cannot match — their eval needs their cloud. That is
the asymmetry to press.

## Layout

```
eval/
  corpora/
    basic.jsonl           # plain save/recall
    contradictions.jsonl  # ≥50 cases - THE differentiating axis
    duplicates.jsonl      # restatements, near-dupes
    temporal.jsonl        # "used to", validity windows
    messy.jsonl           # typos, fragments, pronouns, compound facts
    constraints.jsonl     # diabetic→sugar: must surface on related topics
    adversarial.jsonl     # injection, secrets, memory poisoning (RM-16)
  embeddings.cache.json   # COMMITTED - makes runs offline + deterministic
  run.js                  # the runner
  metrics.js              # scoring
  golden.json             # last accepted scorecard (the regression gate)
```

### Case format

```jsonl
{"id":"contra-001","kind":"contradiction",
 "writes":["I work at Acme","Actually I work at Globex now"],
 "query":"where do I work",
 "expect":{"contains":["Globex"],"excludes":["Acme"],"current_only":true}}

{"id":"constraint-004","kind":"constraint",
 "writes":["I'm diabetic, no sugary foods","I take my dog Rex on long walks"],
 "query":"suggest a snack for after my walk",
 "expect":{"contains":["diabetic"],"reason":"health constraint must bridge via the walk"}}
```

`excludes` is as important as `contains` — most memory bugs are *extra wrong stuff*, not
missing right stuff.

## Metrics

| Metric | Definition | Why |
|---|---|---|
| `recall@k` | fraction of cases whose expected memory is in top-k | baseline quality |
| `MRR` | mean reciprocal rank of first correct hit | ranking quality, not just presence |
| **`staleness_rate`** | answers drawn from a superseded fact | **our differentiating axis** |
| `false_supersession` | still-true facts wrongly invalidated | **hard gate — must be 0** |
| `duplicate_rate` | near-identical stored pairs (cos > 0.95) | store hygiene |
| `extraction_precision` | stored facts that are genuinely durable | `RM-01` guard |
| `constraint_surfacing` | constraints appearing on topically-related recalls | `RM-08` |
| `write_latency_p95` | ms per save | guards against LLM-on-write creep |
| `store_growth` | bytes per 100 writes | supersession must not balloon the file |

## Determinism

The single most important property: **runs must be offline and repeatable.**

```js
// eval/embed-cache.js
// Real embeddings, computed once, committed. The harness NEVER hits the network,
// so results are identical on CI, on a laptop, and on a plane.
const cache = JSON.parse(fs.readFileSync("eval/embeddings.cache.json", "utf8"));

async function embedCached(texts) {
  const missing = texts.filter(t => !(hash(t) in cache));
  if (missing.length) {
    if (process.env.EVAL_REFRESH !== "1")
      throw new Error(
        `${missing.length} uncached strings. Run: EVAL_REFRESH=1 npm run eval  (needs a live embedder)`);
    const fresh = await realEmbed(missing);           // only in refresh mode
    missing.forEach((t, i) => { cache[hash(t)] = fresh[i]; });
    fs.writeFileSync("eval/embeddings.cache.json", JSON.stringify(cache));
  }
  return texts.map(t => cache[hash(t)]);
}
```

Adding a case is a two-step ritual (`EVAL_REFRESH=1` once, then commit the cache), and that is
a *feature*: it keeps the fixture set honest and reviewable in a diff.

## The runner

```js
// eval/run.js
async function run({ variant = "default", filter = null } = {}) {
  const results = [];
  for (const file of fs.readdirSync("eval/corpora")) {
    for (const c of readJsonl(`eval/corpora/${file}`)) {
      if (filter && !c.id.startsWith(filter)) continue;
      const store = freshStore();                      // isolated temp store per case
      for (const w of c.writes) await saveMemory(w, { store, variant });
      const got = await recallMemory(c.query, { store, variant });
      results.push({ ...score(c, got), id: c.id, kind: c.kind });
    }
  }
  return aggregate(results);
}

// Regression gate
const golden = JSON.parse(fs.readFileSync("eval/golden.json", "utf8"));
const now = await run();
const regressions = Object.entries(now).filter(([m, v]) =>
  HIGHER_IS_BETTER.has(m) ? v < golden[m] - EPS : v > golden[m] + EPS);

if (regressions.length) {
  console.error("REGRESSION:", regressions);
  console.error(diffCases(golden.cases, now.cases));   // WHICH cases flipped, not just totals
  process.exit(1);
}
```

`diffCases` matters more than the aggregate. "recall@5 dropped 0.02" is unactionable;
"`contra-017` and `contra-023` flipped from pass to fail" sends you straight to the bug.

## A/B mode

For `RM-05` (hybrid) and `RM-09` (Hebbian tuning), where the question is "is variant B better":

```bash
npm run eval -- --ab cosine-only,hybrid-rrf
```

```
metric                cosine-only   hybrid-rrf     delta
recall@5                   0.784        0.831     +0.047  ✅
MRR                        0.712        0.749     +0.037  ✅
  └ rare_noun              0.522        0.698     +0.176  ✅
  └ identifier             0.481        0.744     +0.263  ✅
  └ negation               0.610        0.634     +0.024  ~
  └ paraphrase             0.848        0.836     -0.012  ~
write_latency_p95 (ms)      12.3         12.4      +0.1   ~
```

Per-category breakdown is the point. An aggregate win that comes entirely from one category
while regressing another is a *different decision* than a broad win, and the table has to show
you which one you're looking at.

## Soak mode (`RM-15`)

```bash
npm run eval -- --soak 1000
```

Simulates a persona evolving over 1,000 updates (job changes, moves, preference flips,
corrections of corrections), checkpointing at 100/250/500/1000:

```
updates   staleness   duplicates   store_kb   graph_components
    100       0.02         0.01         340                  3
    250       0.03         0.02         820                  4
    500       0.03         0.02        1610                  4
   1000       0.04         0.03        3180                  5
```

**The curve is the deliverable.** Slow rot is invisible to single-shot benchmarks and is
exactly the failure mode the user identified: *"the gap between a working prototype of
temporal/contradiction handling and one that stays coherent after hundreds of updates."*
Flat lines here are the strongest quality claim the project can make.

## What we publish

- The harness, the corpora, the cache, the seeds, the exact command.
- A `RESULTS.md` regenerated by the runner, with the date and commit.
- **No competitor comparison numbers.** If someone wants to compare, the harness is right
  there and it runs against any MCP memory server. Let them.

## Acceptance

- `npm run eval` runs offline in <60s and prints a scorecard.
- CI fails on regression, naming the flipped cases.
- ≥50 contradiction cases; every corpus category represented.
- A deliberately-broken change (rank by recency) is caught.
- `--ab` and `--soak` both work.
