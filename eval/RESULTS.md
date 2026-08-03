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
Co-activation lifts a sub-threshold edge over the 0.55 gate in **1–3 activations**; decay
removes it in **10–80 recalls** (scaled by margin over the gate). "Learns through use, fades
without it" is real — at the ledger level. Its *retrieval* impact is bottlenecked by the same
misaligned topology above: a fast learner on a bad map still arrives in the wrong place.

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
