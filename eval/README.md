# RM-00 — the evaluation harness

The measurement system the whole roadmap depends on. Every capability ahead —
contradiction detection, dedup, hybrid retrieval, decay — is a feature that *can make
recall worse*. Without measurement you can't tell a shipped feature from a shipped
regression, and you won't find out for months.

Our counter-position to the Mem0/Zep benchmark wars is **not a better number — it's
reproducibility**: a harness anyone can run offline in seconds, on their own machine,
with committed fixtures and a committed embedding cache. Hosted vendors structurally
can't match that; their eval needs their cloud.

## Run it

```powershell
npm run eval                 # run all corpora, print the scorecard, check regressions
npm run eval -- --accept     # lock the current scorecard in as golden.json (the gate)
npm run eval -- --filter constraint   # only cases whose id starts with "constraint"
```

Normal runs are **offline and deterministic** — they read `embeddings.cache.json` and
never touch the network. Adding a new corpus case needs its embeddings once:

```powershell
$env:EVAL_REFRESH=1; npm run eval; Remove-Item Env:EVAL_REFRESH
```

That hits a live LM Studio (`/v1/embeddings` on :1234), grows the cache, and you commit
the diff. The two-step ritual is a feature: fixtures stay honest and reviewable.

## What it measures

The headline is the one number this project has never had: **what the associative field
is actually worth.** Every `constraint` case runs twice — field **off** and field **on** —
and the scorecard prints the gap. A case that fails off and passes on is the field earning
its keep; a case that passes off and fails on is the field *breaking* recall (a regression
the gate will catch).

The harness also supports *repeated* cases (a `repeat` array instead of `query`): one store
held across turns so the Hebbian ledger can strengthen an edge with use, scored per-turn with
`contains_by_turn`. "Missed at turn 1, landed by turn 4" is a **success** for this architecture,
and `first_hit_turn` is reported so a one-shot metric can't score it as a failure. (No corpus
case currently exercises this — the machinery is kept for the topology experiments ahead.)

**Contradiction / supersession (RM-03).** `contradiction` cases save two facts and check that a
correction retires the stale one: "I work at Acme" → "Actually I work at Globex now" should leave
only Globex current. The `contra-wrongslot` and `contra-additive-pets` guards check the *inverse*
— that a cross-slot or cue-less save does **not** delete an unrelated memory. See `RESULTS.md`
("RM-03") for why detection is gated on a correction cue, not raw cosine.

## Layout

```
eval/
  corpora/*.jsonl        committed fixtures (tracked despite the repo's *.jsonl ignore)
  embeddings.cache.json  committed real embeddings -> offline + deterministic
  embed-cache.js         the cached embedder (refresh ritual above)
  pipeline.js            the real substrate (store/field/edges/record) composed into
                         an injectable save/recall, mirroring server.js
  metrics.js             scoring (contains / excludes / current_only / per-turn)
  run.js                 the runner + regression gate
  golden.json            last accepted scorecard (written by --accept)
  save-time-cost.js      Phase 0.1 cost sweep (neighbor-scan + EdgeStore.save p50/p95/p99
                         at N=100/1k/10k/50k/100k). Pre-declares the p95 budget that
                         triggers RM-07 *before* measuring. Not part of npm run eval.
```

## Case format

```jsonl
{"id":"contra-job","kind":"contradiction",
 "writes":["I work at Acme","Actually I work at Globex now"],
 "query":"where do I work",
 "expect":{"contains":["Globex"],"excludes":["Acme"],"current_only":true}}
```

`excludes` matters as much as `contains` — most memory bugs are *extra wrong stuff*, not
missing right stuff. `kind:"constraint"` triggers the off/on double-run. A `repeat` array
(instead of `query`) keeps one store across turns; pair it with `contains_by_turn`.

---

## Related

[[RESULTS]] · [[0007-eval-harness]] · [[BACKLOG]] · [[phase-2-retrieval-dynamics]] · [[ARCHITECTURE]] · [[ROADMAP]]
