# RM-00 — first results

**Date:** 2026-07-29 · **Substrate baseline:** commit `29238f5` · **Embedder:**
`text-embedding-nomic-embed-text-v1.5` (768-dim, via LM Studio), cached offline in
`embeddings.cache.json`. **Reproduce:** `npm run eval` (offline, deterministic).

This is the record of the first serious experiment against the claim the whole project
rested on and had never tested: *that the associative field improves retrieval over plain
cosine similarity.* The harness was built specifically so that claim could be **falsified**.

## The result, stated precisely

> **The current associative field topology does not demonstrate a retrieval advantage over
> cosine similarity in the evaluated corpus.**

and, separately and independently:

> **The Hebbian reinforcement and decay mechanisms themselves were experimentally confirmed
> at the ledger level.**

That distinction is the whole finding. Three independently testable layers:

```
                    RM-00 RESULT
                         |
          +--------------+--------------+
          |                             |
   RETRIEVAL GEOMETRY            HEBBIAN DYNAMICS
   (associative topology)        (reinforce / decay)
          |                             |
   NOT validated                 mechanically WORKS
   over cosine                   (measured, below)
          |                             |
          +--------------+--------------+
                         |
                  FUTURE RESEARCH
          Change the TOPOLOGY, not the baseline.
                 RM-00 judges it.
```

## What was measured

Scorecard: **16 / 25 checks pass** across `basic`, `constraint`, `contradiction`,
`field-stress`, `field-noise`. The failures are informative, not accidental:

### 1. Cosine retrieval is strong
`constraint-crowded` (16 memories, k=5): cosine ranks the "diabetic" constraint into the
top-5 for "dessert recipe" on embedding geometry alone. `basic-*` and `regress-direct` all
pass. (Note: `constraint-near/-far-sparse/-far-rich` pass **trivially** — their stores are
≤ k, so everything returns; they discriminate nothing and are kept only as a floor.)

### 2. The associative field earns nothing here, and costs precision
`field lifted 0 cases fail→pass, and BROKE 1.` Net value on this corpus is **negative**.

**Rescue failures — the field cannot surface niche/leaf memories** (failure-surface map,
`node eval/diagnose.js`; cell = rescued?(non-target memories dragged in)):

```
case                  n   rank  fwd-1(ship)  fwd-2   bi-1    bi-2
field-rescue          24  21     . (2)        . (3)   . (4)  YES(8)
field-rescue-veg      20  10     . (3)        . (5)  YES(5)  YES(9)
field-rescue-heights  18  18     . (1)        . (2)   . (4)   . (6)
regress-direct        14  1*     . (1)        . (1)   . (1)   . (1)
```

Two distinct failure modes:
- **Edge exists but traversal strands it** (`diabetic`, `vegetarian`). Fixable only by more
  aggressive traversal — and the fix drags in **5–8 non-target memories per rescue** (a
  5:1–8:1 noise-to-signal ratio). `diabetic` needs bidirectional **and** 2-hop *together*;
  neither alone reaches it.
- **Edge never forms** (`heights`). No traversal strategy rescues it: the
  fear-of-heights ↔ rooftop-bar similarity fell below the 0.55 edge gate, so the leaf is
  isolated. Traversal cannot reach an edge that does not exist.

**Measured false positive — the field surfaces irrelevant associates:** `noise-schedule`
passes with the field off and **fails with it on** — asked "when is my doctor's appointment,"
the field dragged in "the mechanic said the car will be ready **Thursday**" on the shared
word alone. (`noise-homonym` stayed clean, so precision is *inconsistent*, case-dependent.)

So the current field **misses what you want and surfaces what you don't.** This is a property
of the kNN-from-cosine-seeds topology, not a parameter setting.

### 3. The Hebbian dynamics mechanically work (ledger probe, `node eval/decay-probe.js`)
```
pair     cosine   learning              forgetting
gluten   0.530    1 co-recall to cross  80 recalls to decay back
budget   0.466    3 co-recalls          10 recalls
```
Co-activation lifts a sub-threshold edge over the 0.55 gate in **1–3 activations**; the
retired epoch clock removed it in **10–80 recalls** (scaled by margin over the gate). As of
Phase 0.2 the live law is wall-clock half-life (`effectiveHebbian`, facts ~7 days), so an
instant eval no longer fades anything — the probe's forget column is the old timescale,
kept inspectable via `tick()`. "Learns through use, fades without it" is real. Its
*retrieval* impact is bottlenecked by the same misaligned topology above: a fast learner
on a bad map still arrives in the wrong place.

### 4. Documented gaps (not regressions — improvements when closed)
- **Contradiction detection (`contra-job`, `contra-city`): fails.** Nothing wires supersession
  into the save verb — `supersedePatches` is defined and unit-tested but called by no verb, so
  contradictory facts both store as current. This is `RM-03`. **→ Now closed; see the RM-03
  addendum below.**

## Decisions taken

1. **Field parked, not removed.** `field.js`/`ledger.js` are intact and gated off by default.
   Do **not** modify them before changing anything — the current behavior is the experimental
   baseline.
2. **This scorecard is locked as `golden.json`.** Future topology experiments (semantic typing,
   salience-weighted edges, asymmetric association, activation spreading, a different graph
   construction) must **beat this baseline**, measured by RM-00 — not modify the baseline itself.
3. **The public claim follows the evidence.** The associative field is an *experimental research
   subsystem*, off by default. The product is not marketed as "learns which memories belong
   together" until RM-00 shows a topology that beats cosine without the noise cost.

## Why this matters

Twelve hours ago the position was *"we believe this associative substrate is what makes
Resonance different."* It is now *"we built an instrument capable of falsifying that hypothesis,
and the first serious experiment showed the dynamics work but the current topology does not
produce the desired retrieval behavior."* That is the difference between a belief and a result.

---

# RM-03 — contradiction detection (supersession wired into `save`)

**Date:** 2026-08-01 · **Substrate baseline:** commit `cf70448` (RM-00) · same embedder and
offline harness. **Scorecard: 20 / 27** — `contra-job` and `contra-city` flipped **fail → pass**
(RM-00's documented gap #4, now closed), plus two new precision guards. No RM-00 case moved.

## What was broken

`supersedePatches` (record.js) and `updateMany` (store.js) both existed, were unit-tested, and
were **called by nothing**. So "I work at Acme" then "Actually I work at Globex now" stored *two*
current facts, and recall surfaced the stale one. The missing piece was never persistence — it
was the **decision**: *when are two memories a correction rather than two separate truths?*

## The measurement that shaped the design

Before writing a line of detection, the pairwise cosines (offline cache):

```
0.5703   "I work at Acme"        <> "Actually I work at Globex now"   SHOULD supersede
0.5599   "I live in Austin"      <> "I moved to Denver last month"    SHOULD supersede
0.5124   "Actually...Globex now" <> "I live in Austin"                MUST NOT (different slot)
0.4736   "I work at Acme"        <> "I live in Austin"
```

> **On this embedder, a same-attribute update and a different-attribute statement in the same
> first-person voice are only ~0.05 cosine apart.** Cosine alone cannot tell a correction from a
> coincidental resemblance.

A similarity-threshold-only detector would eventually retire an unrelated memory (the 0.51 case
is a *new job*, not a move — it must not delete "I live in Austin"). Worse, two genuinely
additive facts — "I have a dog named Rex" / "I have a cat named Whiskers" — are geometrically
*closer* (shared "I have a … named" frame) than the real updates, so cosine-only would delete
the dog.

## The design (cue-gated, argmax-targeted)

Supersession fires only when **all** hold (`detectSupersession`, record.js — pure, unit-tested):

1. the new memory carries an explicit **correction cue** (`actually`, `now`, `moved`, `no longer`,
   `switched`, `instead`, …) — *not* history cues like "used to", which surface the old fact;
2. it is above a **similarity floor** (0.535 — measured to sit between the 0.51 cross-slot pair
   and the 0.56 real updates); and
3. it retires only the **single most-similar** current memory (argmax), never a set.

**The cue gate carries the precision; cosine only picks which memory the cue targets.** This is
the honest boundary: RM-03 detects *user-signalled* corrections, not silent value swaps ("I work
at Globex" with no cue, following "I work at Acme", is **not** caught — documented, not hidden).

## What the guards prove

```
contra-job          Globex retires Acme                     PASS  (cue + 0.57)
contra-city         Denver retires Austin                   PASS  (cue + 0.56)
contra-wrongslot    new job does NOT retire the city        PASS  (cue, but 0.51 < floor)
contra-additive-pets  cat does NOT retire the dog           PASS  (no cue -> both kept)
```

The last two are the point: they are the cases a naive "high similarity → supersede" gets
**wrong**, and they lock the precision boundary into the golden.

## Known boundaries (measured, not aspirational)

- **The 0.535 floor is empirically tuned** to this embedder on short first-person statements,
  where the same-slot/different-slot margin is only ~0.05. It is fragile *by nature of the
  geometry*; the cue gate, not the floor, is what makes the mechanism safe.
- **Supersession is order-dependent** — it only retires memories already present when the
  correction is saved. (This is why `field-rescue`'s "The Friday standup moved to 3pm" line,
  which carries the "moved" cue, does **not** disturb that corpus: at save time its only
  neighbors score 0.43, below the floor.)
- **Silent value swaps are out of scope** — no cue, no supersession, by design.

## Decision

Supersession is **on by default** in the `save` verb (unlike the field, which stays parked): it
is cue-gated and argmax-limited, so its worst case is retiring nothing, and the guard cases prove
it does not delete additive or cross-slot facts. The RM-04 bi-temporal model (`valid_to`,
`superseded_by`, `supersedes`, `revision`) now has its first live writer.

---

# RM-00 field experiment #1 — reciprocal (mutual) kNN

**Date:** 2026-08-01 · same harness. **Scorecard: 20/27 → 21/27**, `noise-schedule [field:on]`
flips **fail → pass**, no regressions. First experiment run *against* the parked field, judged by
the golden the way RM-00 said it must be.

## Hypothesis

RM-00 measured the field's one concrete harm: on "when is my doctor's appointment," the field
appended "the mechanic said the car will be ready **Thursday**" — a false positive on a shared
token. Diagnosis: **directional** kNN edges are asymmetric. A generic node that shares a word with
many others lands in *their* top-k and gets dragged into a seed's neighborhood, even though it
does not rank *them* back. Hypothesis: require the association to be **reciprocal** (edge a↔b only
if each is in the other's top-k) and the one-sided hub link disappears.

## Result — a cost removed, not value added

```
                    directional kNN (RM-00)      mutual kNN (this run)
noise-schedule on   fail  (mechanic FP)          PASS   <-- FP pruned
field-rescue*  on   fail  (leaf stranded)        fail   (unchanged)
field lifted        0, and BROKE 1               0, and BROKE 0
```

Mutual kNN did exactly what it was meant to and **nothing more**:

- **It removed the field's only measured precision cost.** The Thursday bleed is gone; the field
  went from **net-negative** (breaks 1, earns 0) to **net-neutral** (breaks 0, earns 0).
- **It did not earn a single rescue.** `field-rescue`/`-veg`/`-heights` are unchanged. That is
  expected and worth stating plainly: leaf-stranding is a **traversal-reach** problem (the leaf's
  edge exists but the walk doesn't reach it, or never formed), not an **edge-quality** problem.
  Reciprocity prunes bad edges; it cannot manufacture a path to an isolated leaf.

So the honest headline is unchanged from RM-00: **the field still does not beat cosine — it has
stopped *losing* to it.** The RM-00 result ("topology not validated over cosine") stands; what
moved is that turning the field on is no longer strictly a downgrade.

## Decision

Mutual kNN is a **Pareto improvement** on the corpus (one case up, none down), so per the ratchet
it becomes the **default** edge construction and the golden is re-locked at **21/27**. This is the
bar climbing on a real gain, not the bar being lowered to manufacture a pass — the distinction the
RM-00 discipline turns on. Escape hatch `RESONANCE_FIELD_MUTUAL=0` restores directional kNN for
comparison. Unit tests (`test.js`, "reciprocal kNN") lock the semantics: mutual is always a subset
of directional, and it prunes exactly the un-reciprocated edges.

**What this does NOT change:** the field is still **off by default**, and the product is still not
marketed as "learns which memories belong together." Removing a cost is not earning a keep. The
next field experiments (activation-spreading / 2-hop-with-a-precision-guard to attack traversal
reach; a lower gate for edge *formation* on the `heights` never-forms case) must show a real
**fail → pass on a rescue** against this 21/27 golden.

---

# RM-00 field experiment #2 — instrumentation first (ROC / TBR split)

**Date:** 2026-08-01. **No behavior change** — pure measurement, golden still 21/27. Built before
touching any traversal or gate, on external review's advice: a flat pass/fail scalar weights a *fatal
false negative* ("forgot the user is diabetic") the same as an *annoying false positive* ("also
mentioned the mechanic"), and for a memory system those are not equal. So the scorecard now reports
two rates apart (`eval/metrics.js` `fieldSignals`, panels in `eval/run.js`):

- **ROC — Constraint Rescue Rate:** did the apex rule surface? Measured over the `metric:"roc"` cases
  (`constraint-crowded` + the three `field-rescue*`).
- **TBR — Tangent Bleed Rate:** did a forbidden term leak in? Measured over the `metric:"tbr"` noise
  cases, plus `+Nrel` = how many memories the field *appended* (tangent surface, the early-warning gauge).

**Baseline (mutual-kNN default):**
```
ROC  off=1/4 (25%)  on=1/4 (25%)   field-attributable rescues: 0
     (only constraint-crowded rescues, via cosine; the field rescues 0/3 stranded leaves)
TBR  off=0/2 (0%)   on=0/2 (0%)    appended: noise-schedule +1rel, noise-homonym +4rel
     (0 forbidden bleed, but the field already appends 1-4 non-answer nodes on precision queries)
```

This is the legibility foundation for experiment #2 (typed-constraint retrieval). The bar is now
explicit and two-dimensional: **drive ROC up (rescue the diabetic/veg/heights leaves) while holding
TBR at 0** — and watch `+Nrel` as the leading indicator that a gate loosening is about to bleed.

## Stage 1 — typed traversal (no gate change): diabetic + vegetarian rescued

**Result: ROC 25% → 75% (3/4), TBR held at 0%, golden 22→23/27.** The first field-attributable
constraint rescues in the project's history. Three mechanisms, all local, no gate drop, no LLM:

1. **Server-side constraint typing at save** (`record.detectConstraint`, wired through `normalize`).
   A lexical heuristic flags apex rules (diabetic / vegetarian / allergic / terrified / "no meat"…).
   Measured on the corpus: **4/4 constraints flagged, 0 false positives across 131 memories.** The
   server assigns it, never the model (small-model-safe); it only widens retrieval, so a false
   positive is cheap.
2. **Decoupled search vs return radius** (`K_SEARCH=15`, `return_k=5`). The model still sees 5, but
   the field's constraint walk seeds from the top 15 — so the diabetic bridge "lemon bars" (rank 7)
   becomes a seed.
3. **Constraint-restricted bidirectional 1-hop** (`field.reachableConstraints`). From the wide seed
   pool, surface any *typed constraint* that is either (a) in the pool but outside the returned top-k
   (vegetarian, rank 10 — it fell in the gap between return_k and k_search), or (b) reachable via a
   bridge in the pool (diabetic, rank 21 → via lemon bars, rank 7). **Restricted to constraints**, so
   the wider radius cannot re-drag a non-constraint hub — the noise corpora have no constraint to
   surface, so TBR is protected *by construction*, and indeed `+Nrel` on the noise cases was unchanged.

`heights` still fails: its only bridge (`rooftop`, cos 0.472) is below the 0.55 edge gate, so it forms
no association at all. That is Stage 2's target — a constraint-only gate drop to ~0.45.

## Stage 2 — constraint-only gate drop to 0.45: heights rescued, geometry wins

**Result: ROC 75% → 100% (4/4), TBR held at 0%, golden 23 → 24/27.** `heights` — the case external
review first conceded to a save-time NLI model, believing the bridge "does not exist (cos 0.395)" —
flipped `fail → PASS` on **pure local geometry**. The lever was a single default change: the constraint
gate (the min cosine for a *typed constraint* to claim a bridge in the seed pool) dropped 0.55 → **0.45**,
which lets `heights → rooftop` (0.472) form. `RESONANCE_CONSTRAINT_GATE` A/Bs it.

All three stranded constraints now rescue, with **zero tangent bleed and no LLM/NLI/cloud anywhere** —
the geometric thesis holds end to end. The `heights` rescue in particular only exists because the
`0.395 → 0.472` measurement error was caught; trusting the first read would have shipped a 30MB model
the geometry did not need.

### Honest boundary — what this corpus can and cannot prove about the 0.45 gate
The gate only governs whether a **typed constraint** finds a bridge; it never loosens ordinary recall,
and it is inert on any query whose store has no constraint memory — which is exactly why TBR stayed 0
on the noise cases (they contain no constraints). **So this corpus does not yet stress the real
precision risk of a 0.45 gate:** a store where a constraint has a *spurious* 0.45–0.55 link to an
unrelated query's seeds, and would surface when it should not. The next adversarial corpus case should
be exactly that — a constraint that must **not** fire — so TBR has something real to catch at 0.45.
Until then, 0.45 is validated only on non-adversarial evidence (ROC 4/4, TBR 0), and that caveat is the
honest state of it.

## Stage 3 — the adversarial test paid off: one hole fixed, one hard boundary found

Built the "constraint that must NOT fire" cases Stage 2 said it owed (`corpora/adversarial.jsonl`).
Both bled on the first run (TBR 0 → 100%) — the test did exactly its job. Diagnosis found **two
distinct failure modes**, not one:

**Mode 1 — small-store over-reach (`adv-offtopic-quiet`): FIXED.** With `k_search=15`, a store of 8
memories means the seed pool *is the whole store*. The old "surface a constraint that's in the pool but
unreturned" path (the mechanism that had rescued vegetarian) then fired for **any** constraint in a small
store — a shellfish allergy surfaced for "when should I change my oil" (constraint↔query cos 0.430, and
it had *no* bridge at all). Fix: **removed the pool-membership auto-surface entirely.** A constraint must
now EARN its way in through a genuinely query-relevant bridge (`reachableConstraints`, bridge path only).
Vegetarian still rescues — via its "dinner playlist" bridge, not by mere existence — so **ROC held at
4/4 while `adv-offtopic-quiet` flipped to pass.**

**Mode 2 — lexical polysemy (`adv-height-homonym`): the measured boundary of pure geometry.** "I'm
terrified of heights" surfaces for "how tall should I make the bookshelf" because *height/tall* tokens
dominate the vector. This is not tunable — it is the distributional-vs-entailment gap, and three separate
geometric separators were measured to **fail**:

```
signal                     legit rescue (veg)   spurious trap (heights→bookshelf)
constraint↔query cosine    0.536                0.537        <- one thousandth apart
bridge cosine              0.592 (playlist)     0.594 (top shelf)
constraint's rank in the   #6 of 20             #6 of 10     <- same band; and the GOOD
bridge's own neighbor list                                     heights rescue is #16
```

Cosine, query relevance, and reciprocal rank all overlap the good and bad cases. **No purely geometric
rule separates "vegetarian bears on cooking" from "heights spuriously matches a tall bookshelf."** That
is a real, honest result — and it is the first place in this whole line of work where a **tiny local
semantic/entailment check is measurement-JUSTIFIED** rather than assumed: run only as a precision filter
on the ≤4 constraints a query actually rescues (local, cheap, no per-recall-on-everything cost), to
answer "does this rule bear on this query?" — the one question geometry provably cannot. Not built yet;
it is now a defensible design option instead of a premature reflex.

**Net:** golden 24/27 → **27/31** (2 adversarial cases added; `adv-offtopic-quiet` passes, the polysemy
`adv-height-homonym [field:on]` is locked as a *documented known-fail boundary* — a future entailment
filter flipping it to pass will register as the improvement it is). ROC 4/4 held; TBR 2/2 → **1/4**, the
single remaining leak being the polysemy case we now understand exactly. The field stays behind its flag:
the adversarial test **validated that decision** — the precision hole is real, one half is closed by
geometry, and the other half has a named, measured path forward.

### Corrected geometry that sets up experiment #2 (measured, not assumed)
External review initially conceded `heights` to a save-time NLI model, believing the `heights↔rooftop`
edge "does not exist (cosine 0.395)." That 0.395 is `heights`-to-**query**; the actual **pair** cosine
`heights↔rooftop` is **0.472** — below the 0.55 edge gate but **above 0.45**. Measured best bridges:
```
diabetic  → "lemon bars"     0.613   (already forms at 0.55)
vegetarian→ "dinner playlist"0.592 / "ribeye" 0.571  (forms — but to semantically INVERTED neighbors)
heights   → "rooftop bar"    0.472   (forms only at a ~0.45 gate)
```
So all three leaves have a real geometric bridge at ≥0.45. **The rescue is reachable on local geometry
alone — no LLM/NLI extraction needed.** Plan for #2: type constraints at save (server heuristic, not the
model), give typed constraints a lower edge gate (~0.45) + exemption from mutual-kNN + a bidirectional
1-hop restricted to them, and decouple the internal search radius (k_search≈15) from the returned k (5)
so a rank-7 bridge like "lemon bars" becomes a seed. The typing keeps the aggressive reach settings off
the ordinary nodes, so `noise-schedule` precision is not re-broken.

---

## Phase 0.1 — save-time bind cost sweep (2026-09-05)

Pre-declared p95 budget **250 ms** (written in `eval/save-time-cost.js` before any
measurement ran). Isolates neighbor scan + `EdgeStore.save` of K=5 edges; embed and JSONL
rewrite excluded. 768-d JS Arrays (production shape). Reproduce: `node eval/save-time-cost.js`.

| N | trials | p50 (ms) | p95 (ms) | p99 (ms) | K bound | vs 250 ms |
|---|--------|----------|----------|----------|---------|-----------|
| 100 | 80 | 1.7 | 2.0 | 2.7 | 5 | UNDER |
| 1 000 | 40 | 2.0 | 2.4 | 2.6 | 5 | UNDER |
| 10 000 | 20 | 8.6 | 9.1 | 9.1 | 5 | UNDER |
| 50 000 | 12 | 38.2 | 45.5 | 45.5 | 5 | UNDER |
| 100 000 | 8 | 75.4 | 77.1 | 77.1 | 5 | UNDER |

Sidecar rewrite footnote (mature `.edges.json`, no scan): 1k edges p95 2.9 ms · 10k 12.6 ms ·
50k 59.1 ms.

**RM-07 verdict: NO-GO on forcing `RM-07` from this slice.** Scan p95 at N=100k is 77.1 ms
against a 250 ms budget. `RM-07` stays scheduled on the JSONL-rewrite / `all()`-parse
grounds already in BACKLOG. Full write-up: [`phases/phase-0`](../docs/phases/phase-0-edge-substrate.md).

Golden (`npm run eval`) after this slice: **No regressions vs golden.** Recall still uses
`field.js`; the persist-on-save path is additive.

---

# RM-02.a — measurement seed (pre-dedup baseline)

**Date:** 2026-09-05 · **Product behaviour:** unchanged (`memory-core.js` / `record.js` /
`save` / `recall` untouched). **Embedder:** `text-embedding-nomic-embed-text-v1.5`,
cache-extended for the new corpus. **Reproduce:** `node eval/measure.js --bands`
(offline after the cache commit). Golden: `node eval/run.js` → **No regressions vs golden.**

This slice builds the three things RM-02's acceptance names and that did not exist:
a `duplicate_rate` metric, a `recall@k` metric, and `eval/corpora/duplicates.jsonl`.
Dedup itself is 02.b; these numbers are the "before."

## Registry

Reporting metrics live in `eval/metrics.js` as named entries
`{ name, compute(results, corpus, opts) -> number }`, distinct from the golden
contains/excludes scorer. Builtins: `recall_at_k` (success@k, default k=5) and
`duplicate_rate`. Adding `mrr` / `staleness_rate` / `extraction_precision` is
`register({ name, compute })`. Runner: `eval/measure.js` (reuses `pipeline.js`).
Levers (field, k) are runner flags, not metric internals.

`duplicate_rate` = `max(0, N − G*) / N` on `store.current()`: N = current stored
records, G* = labeled groups represented among them (unmatched texts count as
their own singleton). Membership is stored `text` ∈ the group's write texts.
This is **not** "pairs with cosine > 0.95" — measuring cosine-dedup by cosine
would be circular; the labels are the ground truth.

`recall_at_k` = fraction of queries whose top-k **primary** cosine ids contain
at least one relevant id (success@k, not set-recall). Relevant ids resolve
through the same text→group mapping.

## Corpus (`eval/corpora/duplicates.jsonl`)

One store, four bands, 15 groups, 23 writes, 17 queries. Pairwise cosine is
from the committed cache (overlapping strings with `basic.jsonl` keep their
original vectors — that's the geometry the rest of the eval uses):

| group | band | members | pairwise cos |
|---|---|---|---|
| coffee-order | exact | 2× byte-identical | 1.0 (collapsed by the shipping restatement path) |
| penicillin | hi | 3 paraphrases | 0.9883 / 0.9651 / 0.9524 |
| tea | hi | 2 | 0.9522 |
| peanuts | hi | 2 | 0.9581 |
| job | mid | 2 (longer = more specific) | 0.9261 |
| cat | mid | 2 | 0.9435 |
| diabetic | mid | 2 | 0.9433 |
| dog, peanut-allergy, standup, mechanic, name, night-owl, sister-bday, garage | control | 1 each | — |

Controls include two **precision traps**: `dog` vs `cat` (same-frame pets, live
pair ~0.69) and `peanut-allergy` vs `peanuts` (same-topic, live pair ~0.67).
Both sit well below DEDUP_LO ~0.88; a too-aggressive merge would tank
`q-cat` / `q-dog` / `q-peanut-allergy`. No correction cues, so RM-03 does not fire.

The brief's example pair *"I'm allergic to penicillin" / "penicillin gives me
hives, I'm allergic"* measured **0.8941 (mid, not hi)** on this embedder. HI
in the corpus is tighter paraphrases that actually clear 0.95; mid is the
"same fact, one more specific" band.

## Baseline (today, pre-dedup)

```
writes=23  stored_current=22  groups=15  exact_restatements_caught=1
duplicate_rate  0.3182   (extras=7/22, G*=15)
recall@5        1.0000   (17/17 queries hit)
```

**Existing restatement path:** the byte-identical `coffee-order` pair is
confirmed, not appended (`Already remembered`). **No HI paraphrase is
caught** — `r.text === content` is exact match only, so the four HI extras
and three mid extras all store. That is the RM-02 gap, measured.

Extras by band: HI 4 (penicillin 2 + tea 1 + peanuts 1) · MID 3 · exact 0 ·
control 0.

## Pre-declared RM-02 pass bar (written BEFORE 02.b runs)

Same discipline as the Phase 0.1 250 ms budget. Changing these numbers after
seeing 02.b's table is cheating.

| metric | baseline | pass iff |
|---|---|---|
| `duplicate_rate` | **0.3182** | drops ≥ 50% relative → **≤ 0.1591** |
| `recall@5` | **1.0000** | not lower → **= 1.0000** (17/17 holds) |

Arithmetic that 02.b will hit whether or not it ships the mid band:

| 02.b does | extras left | stored | rate | relative drop | vs 50% |
|---|---|---|---|---|---|
| nothing | 7 | 22 | 0.3182 | 0% | FAIL |
| HI restatement only (4 extras gone) | 3 | 18 | 0.1667 | **47.6%** | **FAIL** (shy of 50%) |
| mid merge only (3 extras gone) | 4 | 19 | 0.2105 | 33.8% | FAIL |
| HI + mid (the spec) | 0 | 15 | 0.0000 | 100% | PASS, if recall@5 holds |
| over-merge a control into a dup group | ≤3 | ≤18 | maybe ≤0.1591 | maybe | **FAIL on recall@5** (q-cat / q-dog / q-peanut-allergy) |

So the 50% bar is not free on the easy ≥0.95 band: **DEDUP_HI restatement
alone is expected to miss.** The mid-band merge is what the acceptance
actually demands. Over-merge is caught by recall@5 sitting at 1.0 with
no room to drop.

Reproduce the before-column: `node eval/measure.js --corpus duplicates`.
02.b compares the after-column to the table above.

---

# RM-02.b — cosine-banded dedup/merge at save (measured A/B)

**Date:** 2026-09-05 · **Product behaviour:** `save()` in `memory-core.js` now
runs cosine-banded dedup against already-stored vectors after embed, before
RM-03. **Embedder:** `text-embedding-nomic-embed-text-v1.5`, same committed
cache. **Reproduce:** `node eval/measure.js --corpus duplicates` (offline).
Golden: `node eval/run.js` → **No regressions vs golden.** (27/31 unmoved —
the golden corpora are distinct memories, so the bands did not fire.)

This is the first real measured A/B in the project: 02.a built the stick and
locked the bar; this slice moved the number and proved it.

## Tuned thresholds

| knob | value | why |
|---|---|---|
| `DEDUP_HI` | **0.95** (`≥`) | HI paraphrases sit 0.9522–0.9883. Tea at **0.9522** is the tightest HI and clears 0.95 with margin. `≥` not `>`: a pair sitting exactly on 0.95 is treated as restatement (keep the original) rather than merge. Equality is hypothetical on this corpus. |
| `DEDUP_LO` | **0.88** (`≥`, band is `[lo, hi)`) | Mid pairs sit 0.9261–0.9435; controls ≤ ~0.69 (dog/cat ~0.69, peanuts/peanut-allergy ~0.67). 0.88 sits well above the control ceiling so those traps cannot merge. |

Config, not constants: env `RESONANCE_DEDUP_HI` / `RESONANCE_DEDUP_LO` plus
live-config keys `dedup_hi` / `dedup_lo` (same pattern as the field toggle).
Defaults are these tuned values.

HI-only restatement would have left the three mid extras (`duplicate_rate`
0.1667, shy of 0.1591). The mid-band merge is what the 50% bar actually
demanded. Confirmed: no control crept in, no mid pair was missed.

## After (02.b)

```
writes=23  stored_current=15  groups=15  exact_restatements_caught=5
duplicate_rate  0.0000   (extras=0/15, G*=15)
recall@5        1.0000   (17/17 queries hit)
```

`exact_restatements_caught` rose 1 → 5 because HI paraphrases now share the
byte-identical confirm path ("Already remembered"): coffee-order (exact) +
penicillin ×2 + tea + peanuts. The three mid extras (job, cat, diabetic) were
merged via `supersedePatches` (loser linked with `superseded_by`, survivor
kept one of the original texts). Controls untouched.

## A/B vs the pre-declared bar

| metric | baseline (02.a) | after (02.b) | pass iff | verdict |
|---|---|---|---|---|
| `duplicate_rate` | **0.3182** | **0.0000** | ≤ 0.1591 (≥50% relative drop) | **PASS** (100% drop) |
| `recall@5` | **1.0000** | **1.0000** | = 1.0000 (17/17 holds) | **PASS** (controls not over-merged) |

Both conditions. `q-cat` / `q-dog` / `q-peanut-allergy` still hit — the
precision traps did not fire. Survivor texts are original labeled writes, so
the group mapping did not break.

## Decision

Cosine-banded dedup is **on by default** in `save()` (unlike the field):
worst case on a miss is "append as before"; a hit never hard-deletes (I8:
restatement keeps the original; merge links the loser with `superseded_by`).
No vector (embedder down) → append, don't crash.

---

# RM-02.c — `--dedup-existing` backfill (offline pass)

**Date:** 2026-09-05 · **Product behaviour:** `save()` / `recall()` untouched
(CLI/maintenance path). Same bands, same `detectNearDuplicate` /
`pickMergeSurvivor` / `mergeBandPatches` as 02.b — the planner lives in
`memory-core.js` so the offline pass and the write path cannot disagree.
**Reproduce:** the corpus fixture is built inside `test.js` ("duplicates
corpus backfill"); golden: `node eval/run.js` → **No regressions vs golden.**

This is the retroactive pass for stores written **before 02.b**. Exact
restatement already existed (RM-04), so a pre-02.b store still carries the
four HI extras and three mid extras — the 02.a baseline.

## Pass order

File order (JSONL insertion). Each current record is treated as an incoming
`save()` against the survivors of earlier records. That is why `--apply`
twice is a no-op: after one pass every remaining current pair is below
`DEDUP_LO` (or vectorless, which we refuse to merge blind). Dry-run is the
default; `--apply` is one `store.updateMany` → `writeFileDurable` (I5).
Restatement losers already on disk are superseded, not deleted (I8) — so
`current()` matches sequential save, while `all()` keeps the extra rows.

## Backfill result (pre-02.b fixture)

`eval/corpora/duplicates.jsonl` writes, save-time dedup **bypassed**, the
second byte-identical `coffee-order` dropped (already collapsed by RM-04).
22 current records, 7 extras. Dry-run plan: 4 HI restatements (penicillin,
tea, peanuts) + 3 mid merges (job, cat, diabetic); 8 controls untouched.

```
current           22 → 15
duplicate_rate    0.3182 → 0.0000   (extras 7 → 0, G*=15)
recall@5          1.0000            (17/17 queries still hit)
```

Same after-column as 02.b's sequential save. Online-vs-offline equivalence
(synthetic fixture in `test.js`): `current()` texts match one-by-one
`save()`. Second `--apply` writes nothing. Vectorless row + dead embedder
→ skipped, not merged.

## Decision

`--dedup-existing` ships as a CLI (dry-run default). RM-02 acceptance is
fully met: the 50% bar was cleared by 02.b at save-time, and 02.c applies
the same decision to stores that never went through that path.

---

# RM-01.a — measurement seed (pre-extraction baseline)

**Date:** 2026-09-05 · **Product behaviour:** unchanged (`memory-core.js` / `record.js` /
`save` / `recall` untouched). **Embedder:** `text-embedding-nomic-embed-text-v1.5`,
cache-extended for the new corpus. **Reproduce:** `node eval/measure.js --corpus messy`
(offline after the cache commit). Golden: `node eval/run.js` → **No regressions vs golden.**

This slice builds the three things RM-01's acceptance names and that did not exist:
an `extraction_precision` metric, `eval/corpora/messy.jsonl`, and a recall@5 backstop
on that corpus. Extraction itself is 01.b (Tier 0/1, Tier 2 off); these numbers are
the "before."

## Registry

`extraction_precision` is a named entry in the same `eval/metrics.js` registry as
`recall_at_k` / `duplicate_rate`. Adding it is `register({ name, compute })`; the
runner (`eval/measure.js`) emits it when the scenario's writes carry `gold_facts`.

Definition, computable from what `save()` actually persists:

```
precision = n_correct / n_stored
```

A stored record is **correct** iff its text equals one of the write's gold atomic
facts (whitespace-collapsed, case-folded) **and** contains none of that write's
noise spans. Exact equality, not containment: today's `save()` stores the raw
blob, which *contains* the fact plus filler/imperative/sibling-fact — counting
that as correct would make the pre-extraction baseline look healthy.

- `n_stored` is the per-write delta of `store.current()` (a restatement confirm
  that writes nothing contributes 0; a refusal that writes nothing contributes 0).
- PII writes have `gold_facts: []` and `expect_refusal: true`. Storing the payload
  is a false positive. Refusing (stored nothing, `refused=true`) does not dilute
  precision; `pii_refusal_rate` in `explain` is the dedicated readout
  (refused-and-wrote-nothing / PII cases).
- Vacuous: labeled cases + zero stored → 1.0 (no false positives). That is the
  all-refuse cheat — precision aces, recall@5 is the backstop. Unlabeled input
  (no `gold_facts`) → 0, so `computeAll` on a duplicates result doesn't look like
  a perfect extraction run.

## Corpus (`eval/corpora/messy.jsonl`)

One store, 23 writes, 19 queries. Gold facts are unique across writes so 01.b
restatement will not collapse the A/B. No correction cues, so RM-03 does not fire.
Bands:

| band | n | what 01.b should do |
|---|---|---|
| filler | 6 | strip the opener ("I think you should know that…", "just so you're aware", "FYI", stacked), keep the fact |
| imperative | 3 | drop assistant-aimed framing ("remember to remind me", "make sure you", "Please remember that"), keep the embedded fact |
| multi | 2 | split on `; ` / ` and also ` — both halves stand alone (≥4 words + copula/verb, not a dependent clause) |
| multi-nosplit | 1 | `and also` but the second half does **not** stand alone ("…and also with honey") — keep as one fact |
| pii | 6 | refuse the whole write (API key / password / card / AWS / PEM / GitHub token). Fake payloads; they match the 0001 shapes |
| control | 5 | clean single facts, including two digit traps (garage code `4821`, `1500mg` metformin) that must **not** trip the card-number guard |

## Baseline (today, pre-extraction)

```
writes=23  stored_current=23  groups=23  exact_restatements_caught=0
duplicate_rate         0.0000   (no dup labels; each write is its own text)
recall@5               1.0000   (19/19 queries hit)
extraction_precision   0.2609   (correct=6/23 stored, labeled=23)
pii_refusal_rate       0.0000   (0/6 PII writes refused)
```

**What the 6/23 is.** `save()` stores the trimmed raw text as-is. The five
controls and the should-not-split compound equal their gold facts, so they
count as correct. Every filler/imperative/to-split-multi blob fails exact
match (and the filler/imperative ones contain a noise span). Every PII
payload is stored — there is no guard.

That is the RM-01 gap, measured: filler, imperatives, and compound facts
all land as one embedding; secrets land at all.

## Pre-declared RM-01.b pass bar (written BEFORE 01.b runs)

Same discipline as the RM-02.a 50% bar and the Phase 0.1 250 ms budget.
Changing these numbers after seeing 01.b's table is cheating. **Tier 2 is
off** — 01.b is deterministic Tier 0 + Tier 1 only. (Tier 2 is deferred
pending a design decision with Samuel.)

| metric | baseline | pass iff |
|---|---|---|
| `extraction_precision` | **0.2609** (6/23) | **≥ 0.9** (Tier 2 off) |
| `recall@5` | **1.0000** (19/19) | not lower → **= 1.0000** |
| `pii_refusal_rate` | **0.0000** (0/6) | **= 1.0000** (every PII write refused; implied by the spec's "every secret-shaped input is refused" and needed to clear 0.9 — leaving all 6 PII stored caps precision at 17/23 = 0.739 even with perfect Tier 0) |
| write-latency p95 | (Tier 2 off) | **unchanged** — Tier 0/1 are string ops, no extra embed, no LLM/network call. Extra embeds from a *legitimate* split are in-scope (that's storing two memories, not extraction overhead). |

Arithmetic that 01.b will hit:

| 01.b does | correct/stored | precision | vs 0.9 | recall@5 |
|---|---|---|---|---|
| nothing | 6/23 | 0.2609 | FAIL | holds |
| PII refuse only (6 gone) | 6/17 | 0.3529 | FAIL | holds (queries aren't the PII writes) |
| filler+imperative strip, no split, no PII guard | 14/23 | 0.6087 | FAIL | holds if controls pass through |
| Tier 0 perfect, PII still stored | 17/23 | 0.7391 | FAIL | holds |
| Tier 0+1 perfect (the spec) | 19/19 | **1.0000** | PASS, if recall@5 holds and controls aren't rewritten |
| over-split the nosplit trap | 18/20 or similar | maybe ≥0.9 | maybe | **FAIL on q-tea-honey** if the surviving half doesn't carry "honey" / the labeled text |
| strip a control ("I think" false-positive on a non-opener) | <19/19 | maybe | maybe | **FAIL on recall@5** if the gold text is gone |
| refuse everything | 0/0 → vacuous 1.0 | PASS on precision | **FAIL on recall@5** (19 misses) |

So the 0.9 bar is not free on PII-refuse-alone or filler-strip-alone: **Tier 0
and Tier 1 together are what the acceptance actually demands**, and recall@5
sitting at 1.0 with no room to drop is the anti-cheat for "drop the messy
writes, keep the controls."

Reproduce the before-column: `node eval/measure.js --corpus messy`.
01.b compares the after-column to the table above.

---

## Related

[[eval/README]] · [[0007-eval-harness]] · [[phase-0-edge-substrate]] · [[phase-2-retrieval-dynamics]] · [[BACKLOG]] · [[ARCHITECTURE]]
