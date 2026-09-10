# Activation test pool — design, hypotheses, decision criterion

Lane A of the Kaizen campaign. The activation-in-rank A/B
(`eval/ab-warm-rank.js`, `eval/RESULTS.md` "Activation-in-rank A/B")
came back a **measured zero** on recall@k / MRR / staleness. That
number is not an answer to "does activation earn its place." It is
an answer to a different question: *does this-turn spread, folded
additively into cosine at w=0.3, reorder a one-query-per-store
corpus?* No. Related: already does single-turn associative discovery
(field-on ROC 1/4 → 4/4 on the rescue cases). Activation exists for
**cross-turn warmth** — leftover energy from turn 1 on a related
turn-2 query — and that was never in the pool.

This document is the contract Lanes B (combiner) and C (graph
density) measure against. The fixtures are `eval/corpora/cross-turn.jsonl`,
`weak-recall.jsonl`, `hub-vs-apex.jsonl`. The numbers are reporting
metrics in `eval/metrics.js`, not the golden gate.

Reproduce:

```
node eval/measure.js --corpus cross-turn
node eval/measure.js --corpus cross-turn --warm-rank
node eval/ab-warm-rank.js
```

Offline, cached embeddings, `gate: false`. Flag-off default is
untouched. Golden stays 27/31.

---

## What the previous pool could not see

Three structural holes, not a bad run:

1. **One query per store.** WarmField is process-local and
   conversation-scale (half-life 300 s). A single recall seeds,
   spreads, and is scored. There is no leftover. The one thing
   activation is *for* is untested.
2. **Surplus-only combiner zeros the near-miss.**
   `activationRankBonus` is `max(0, E − this-turn cosine)`. A
   target sitting at cosine 0.61 inside the seed radius (K_SEARCH
   = 15) gets bonus 0 *by construction*. The "s=0.61 near-miss"
   is not a weak-recall case; it is a case the current fusion
   refuses to help. The diabetic leaf that *did* get a bonus
   (spread node, sim `null`, E ≈ 0.202) gained +0.061 at w=0.3 —
   not enough to close rank 21 → top-5.
3. **Related: walks a different graph.** Constraint rescue uses
   `field.js` at CONSTRAINT_GATE 0.45 over K_SEARCH seeds.
   Activation spreads over save-time K=5 edges (min cosine 0.25).
   Vegetarian's this-turn bonus was **0** because the leaf was
   never bound. Measuring "activation" on a disconnected leaf is
   measuring H3, not H1.

The w=1.0 sensitivity *did* move lists: it promoted Friday/office
hubs into slots 4–5 and still missed diabetic. That is the
discrimination failure this pool is built to catch.

---

## Corpus shapes

A case is a **sequence of turns against one store**, scored on the
later turn. Schema (self-contained JSONL, `gate: false`):

```json
{
  "id": "xt-diabetic-assoc-hostile",
  "kind": "cross_turn",
  "subset": "associative-carry",
  "band": "bind-hostile",
  "writes": [
    {"id": "apex", "role": "apex", "text": "I'm diabetic, so no sugary desserts for me"},
    {"id": "bridge", "role": "bridge", "text": "I always bring lemon bars …"},
    {"id": "hub-casual", "role": "hub", "text": "Fridays are casual dress at the office"}
  ],
  "turns": [
    {"id": "warm-desserts", "role": "warm", "query": "what desserts do I usually bring to potlucks",
     "relevant_writes": ["bridge"], "score": false},
    {"id": "probe-potluck", "role": "probe", "query": "what should I bring to the potluck on Friday",
     "relevant_writes": ["apex"], "hub_writes": ["hub-casual", "hub-carpool"]}
  ]
}
```

`eval/measure.js` runs two cores on the same populated store:

- **Cold probe:** fresh WarmField, probe only. This-turn activation
  (what the old A/B measured).
- **Warm probe:** fresh WarmField, warm turn(s) then probe. Leftover
  + this-turn.

Warm turns are `score: false` so they do not inflate recall@k.
Probes get `cold_ranked_ids` and `warm_ranked_ids`. Rankings are
full-store (`k = N`) so a rank-21 leaf is visible; recall@k still
windows at 5.

Write `role`s: `apex` (the fact cosine ranks too low), `bridge`
(the associated neighbor turn 1 should seed), `hub` (dense
Friday/office distractor), `control` (unrelated).

### `cross-turn.jsonl` — the headline (13 cases)

| id | subset | what it tests |
|---|---|---|
| `xt-diabetic-assoc-hostile` | associative-carry | H1a: warm lemon bars, probe potluck, Friday crowding |
| `xt-diabetic-direct-hostile` | direct-leftover | H1b: warm the apex itself, then potluck |
| `xt-diabetic-unrelated` | unrelated-control | Negative: warm the cat, diabetic must not lift |
| `xt-diabetic-hubwarm` | hub-warm-attack | Warm Friday/office; combiner must not promote hubs over apex |
| `xt-diabetic-assoc-friendly` | associative-carry | Bind-connected control (not weak-recall: apex already ~rank 5). Leftover has no window to enter. |
| `xt-veg-assoc-hostile` | associative-carry | Vegetarian / risotto; this-turn bonus was 0 (H3 trap) |
| `xt-heights-assoc-hostile` | associative-carry | Heights / rooftop (pair 0.472 — the sharp one) |
| `xt-heights-direct-hostile` | direct-leftover | Warm the phobia, then drinks |
| `xt-celiac-assoc` | associative-carry | New domain, same shape |
| `xt-peanut-assoc` | associative-carry | Allergy constrains a restaurant rec |
| `xt-sober-assoc` | associative-carry | Sober vs after-work drinks |
| `xt-migraine-assoc` | associative-carry | Lights/migraine vs dancing (little shared vocab) |
| `xt-dog-assoc` | associative-carry | Dog allergy via dog-park-next-to-brewery |
| `xt-diabetic-assoc-late-hostile` | associative-carry | H3 save-order: hubs first, apex last |
| `xt-veg-assoc-late-hostile` | associative-carry | H3 save-order for vegetarian |

`band: bind-hostile` is the crowded neighborhood (field-rescue
shape). `bind-friendly` mixes unrelated domains so the pair is
likelier to survive K=5. **`bind-late` is the real H3 trap:** hubs
are written *first*, apex last. Save-time bind is incremental — if
the apex is saved when the store still has 1–2 items, K=5 will bind
the leaf even in a store that later looks crowded. The original
hostile list therefore often reports `graph_bind_rate` 1. Late-bind
cases are the ones where K=5 can actually drop the pair. **Do not
pool them.** `graph_bind_rate` says which is which after the writes.

### `weak-recall.jsonl` — this-turn baseline (9 cases)

Single probe, no warm turn. Same stores as the cross-turn probes.
This is the original A/B's question, now with labeled apex/hubs and
full ranking, so a later combiner can be compared to carry-over on
the *same* geometry.

Targets are **genuinely low-cosine** (diabetic at ~rank 21, heights
pair 0.472, migraine/strobe vs dancing). Not s=0.61 near-misses:
those sit inside the seed radius and the surplus-only combiner
cannot help them.

Store size > k on every case. `constraints.jsonl`'s 1-memory
"diabetic" rows are not in this pool; they cannot discriminate.

### `hub-vs-apex.jsonl` — discrimination (6 cases)

Apex + labeled hubs on the probe. Single-turn (the w=1.0 failure
mode) plus one hub-warm attack. The catch is **hub in top-k AND
apex not in top-k**, not "any hub appeared." A combiner that lifts
diabetic *and* casual-dress is mixed; Friday-without-diabetic is
the failure.

---

## Metrics

All four are registry metrics (`eval/metrics.js`). `compute` is
null when the result shape is absent (not a fake 0). Warm-seed
turns (`score: false`) are skipped by recall@k / MRR /
carryover / hub / related.

| name | definition | null when |
|---|---|---|
| `carryover_lift` | mean `(rank_cold − rank_warm)` on paired probes. Miss = \|list\|+1. Positive = leftover helped. Also reports `n_improved` / `n_entered_window`. | no cold/warm rankings |
| `rank_hub_contamination` | fraction of apex+hub-labeled probes whose top-k contains a hub and **not** the apex. Distinct from Op B `hub_contamination` (cluster-glue). | no `hub_ids` |
| `graph_bind_rate` | fraction of labeled apex↔bridge pairs with a save-time EdgeStore row. H3's readout. | no `bind_pairs` |
| `related_rescue_rate` | fraction of probes whose apex is in Related: and **not** in primary top-k. H4's number. Field-off → 0. | no labeled probes |

Windowed **recall@5** on the probes remains the product number.
Carry-over lift of +3 that still misses top-5 is a tracing
curiosity, not a ship.

Mechanism the carry-over metric depends on, locked by test:
`seedFromRetrieval` overwrites this-turn cosine seeds and
`thisTurn`, but **does not wipe leftover E on disjoint ids**.
Spread on turn 2 does *not* re-walk leftover nodes (comment in
`warm.js`: "a later recall does not re-spread from leftover
warmth"). Turn-1 spread is all the associative leftover you get.

---

## Hypothesis critique and extension

Starting set, then what it is missing.

### H1 — cross-turn warmth helps recall on turn-2 associative queries

**Right question, two different strengths.** Split it.

- **H1a (associative leftover).** Turn 1 retrieves the *bridge*;
  spread deposits E on the leaf; turn 2's probe needs the leaf.
  Magnitude is `E_bridge × γ × α`. On diabetic this-turn that was
  ~0.20; leftover from a stronger dessert query might be ~0.28.
  At w=0.3 that is still ~+0.08 cosine — **probably not enough
  to enter top-5** on a rank-21 leaf. H1a can be "true" as a
  rank-order lift and still fail the product window.
- **H1b (direct leftover).** Turn 1 retrieves the *apex*; turn 2
  is a query that buries it. Leftover E ≈ the turn-1 cosine
  (0.8–1.0). At w=0.3 that is +0.24–0.30 — in range to close a
  real gap. This is "we were just talking about diabetes, now
  you asked about the potluck." It is the conversation-scale
  claim. It is also closer to recency than to association.

The unrelated-control (`xt-diabetic-unrelated`) is the cheat
detector: if H1b-style leftover lifts *everything recently
retrieved*, you have recency-in-rank (I2b-adjacent), not
association.

**What H1 assumes and may not have:** the leaf is on the graph
(`graph_bind_rate`), leftover survives the turn-2 seed (it does,
tested), and the combiner can spend leftover E (surplus-only
can, on non-seeds). If bind is 0, a zero lift is H3, not H1.

### H2 — the additive combiner is the bottleneck (Lane B)

**Half right, and the surplus-only rule is the load-bearing
half.** The A/B already showed w=0.3 cannot close 0.06 and w=1.0
promotes hubs. A better fusion (RRF, multiplicative gate, "use
activation only outside the seed radius", a floor that does not
zero near-misses) might help **if there is signal**. It cannot
invent an edge. Lane B must stratify:

- bound cases (bind_present=1) with leftover E > 0: fusion's
  home turf.
- unbound cases: fusion is powerless; that is Lane C.
- near-misses inside the seed radius: *this* combiner cannot
  help them. If Lane B wants those, it has to change the
  surplus-only rule, and that is a different bet (it re-opens
  double-counting / rich-get-richer).

H2 without 2.3/2.4 (competition / neighborhood normalization) is
the w=1.0 result. A combiner willing to spend more than 0.3
**must** be scored on `rank_hub_contamination`, not just
recall@k.

### H3 — save-time K=5 is too sparse; the leaf is never reachable (Lane C)

**This is the most likely reason H1a fails — but it is
save-order, not just K.** Bind is incremental: each save
attaches K=5 neighbors of the *current* store. If diabetic
is written first and lemon bars second, the edge exists
before the Friday crowd arrives, and `graph_bind_rate` on
the "hostile" list is often 1. The trap is **late bind**:
hubs first, apex last, so K=5 sees a food/Friday
neighborhood. `band: bind-late` is that order. Vegetarian's
this-turn bonus of 0 in the original A/B may be this, or
it may be surplus-only (leaf inside the seed radius). The
pool now distinguishes them.

H3 is not "activation is useless." It is "the graph activation
spreads on is not the graph Related: walks." Related: uses
constraint-typed 0.45 over 15 seeds and *does* rescue. If Lane
C densifies save-time bind (K↑, or constraint pairs always
bind, or recall-time kNN reused), H1a becomes testable.
Raising K without a hub damper re-creates the w=1.0 failure
on the *graph*, before fusion ever runs.

The bind-friendly vs bind-hostile vs bind-late split is how
we tell "K=5 dropped the leaf" from "the leaf was there and
leftover did nothing." Read `graph_bind_rate` per band; do
not average.

### H4 — activation's real value is improving Related: breadth, not reordering primary

**Plausible, and not a current capability.** Related: today is
`field.js` kNN + constraint rescue. WarmField is not consulted.
H4 is a *proposal for where to spend the signal*, not a
measurement of existing code. `related_rescue_rate` is the
hook: field-on already aces it on the rescue cases (that is
the golden ROC). If a later slice appends warm nodes into
Related:, the metric moves. If it does not move with
activation-in-Related off, H4 is a story about a mechanism
that does not exist yet.

The honest reading of the current system: **Related: already
does the single-turn job H4 wants activation to do.** Spending
engineering on activation-in-rank to duplicate a working
additive block is the thing the zero A/B warned against.
Spending it on *cross-turn* Related: (leftover nodes appear
in the appendix of turn 2) is a different, cheaper experiment
than fusion.

### What was missing from the starting set

**H5 — leftover does not re-spread.** Turn 2 will not walk
further from a leftover leaf. Multi-hop carry-over is one-shot.
A "warm A, then B, then C" conversation cannot accumulate
graph walk across turns. If that is the product claim, the
spread contract has to change (and CAP / runaway need a new
APR claim).

**H6 — the model may not need the fact in primary.** If the
host attends to Related:, rank is the wrong surface. The
live A/B rigs (`eval/ab/`, `eval/ab-grok/`) are the place
to ask that; this pool cannot, it has no model in the loop.
Do not promote rank on a recall@k win if the value A/B
(model-facing) is flat.

**H7 — this-turn vs leftover are different products.** Collapsing
them into "activation-in-rank" hid that this-turn is a
worse Related: and leftover is the actual bet. Decision
criteria must name which.

**H8 — hub contamination is the observed failure, not a
hypothetical.** Any "earns rank" criterion that ignores
`rank_hub_contamination` will pass a combiner that recreates
w=1.0.

**H9 — half-life 300 s means this is conversation-local.** A
new process is empty (I7). "Next session" is not H1; do not
score a restart as an H1 miss.

**H10 — Hebbian from a field-on warm turn is a third arm.**
Turn 1 with field on reinforces retrieved pairs; turn 2
spreads over a *learned* edge, not just save-time semantic.
That is closer to "the ledger earning rank" than to
activation. The runner already has `--field --warm-rank`.
Do not call a field-on win an H1 win.

---

## Pre-declared decision criterion (two-sided)

Activation **earns a place in rank** (still behind the flag,
still not the 2.2 promotion — that also needs 2.3/2.4 and
RM-16) iff **all** of the following hold on this pool, flag-on
vs flag-off, k=5, w=0.3 unless Lane B pre-declares a different
weight **and** still passes the hub clause:

1. **Windowed product, not mean-rank trivia.** On
   `associative-carry` + `direct-leftover` probes with
   `graph_bind_rate` present (bind_present=1): **recall@5
   warm > recall@5 cold**, and at least half of those probes
   **enter the window** (`n_entered_window / n_bound ≥ 0.5`)
   or were already in it without leaving. A mean
   `carryover_lift` > 0 that still misses top-5 is **not**
   a win.
2. **The lift is the apex, not the hub.**
   `rank_hub_contamination` does not increase vs cold / vs
   flag-off. The hub-warm-attack cases (`xt-diabetic-hubwarm`,
   `hub-diabetic-after-friday-warm`) stay uncontaminated.
3. **The unrelated control does not enter the window.**
   `xt-diabetic-unrelated` `n_entered_window` is 0. A ±few
   ranks around 20 is jitter, not recency-in-rank; a cat-warm
   that puts diabetic in top-5 is the cheat. Direct-hit
   regression (`regress-direct` / Koneko in field-stress)
   stays MRR 1.0.
4. **Staleness and false-supersession do not get worse** than
   cosine on `contradictions.jsonl` (already in the A/B
   runner).
5. **Stratification is reported, not averaged.** Bound vs
   unbound, H1a vs H1b, hostile vs friendly. A pooled "we
   moved some ranks" that is entirely H1b (direct leftover)
   plus unbound zeros is not an associative win.

Activation-in-rank is **cut** (flag stays off, negative written
down, stop spending slices on fusion-into-primary) if **any**:

1. On **bound** associative-carry probes, recall@5 does not
   move and `n_entered_window` is 0. Leftover exists, the
   graph is connected, and the combiner still cannot put the
   leaf in the window. That is "activation does not earn
   rank," not "we needed denser edges."
2. The only windowed wins require a weight that raises
   `rank_hub_contamination` (the w=1.0 shape). Hub promotion
   is not a rescue.
3. Wins are only H1b (direct leftover on the same id) and H1a
   is flat. Then you have recency of the last hit, which I2b
   already forbids as a rank signal. Do not launder it
   through WarmField.
4. Related: already has the apex (`related_rescue_rate` with
   `--field`) and primary never moves. Then H4 wins: keep
   activation out of rank; if you spend a slice, spend it on
   leftover-into-Related:, not fusion.

**Honesty bar.** A small rank-order lift on a full ordering
(21→18) will look like a "yes" in `carryover_lift` and a "no"
in recall@5. The criterion uses the window. The model sees
top-k. We already know spread *reaches* diabetic (E ≈ 0.20).
Reaching is not ranking.

**What this criterion deliberately does not decide:**

- 2.2 promotion to default (needs competition, normalization,
  RM-16, golden-set A/B — phase-2).
- Whether Lane C should densify the graph (that's a graph
  question; this pool *exposes* it via `graph_bind_rate`).
- Whether the host model attends to Related: (value A/B, not
  this harness).

If H1a is flat on bound cases at w=0.3 **and** H4's Related:
path already rescues, the grown-up outcome is: keep computing
activation (Phase 1 exit is met, the signal is cheap), keep
it out of rank, and stop calling fusion the next slice.

---

## What Lanes B and C owe this pool

- **Lane B (combiner):** run `node eval/ab-warm-rank.js` and
  `node eval/measure.js --corpus cross-turn --warm-rank` (and
  `--field` as a named arm, not mixed into H1). Pre-declare
  the fusion and the weight. Pass the hub clause. Stratify on
  `graph_bind_rate`.
- **Lane C (density):** the bind-hostile vs bind-friendly
  split plus `graph_bind_rate` is the before. After a K/gate
  change, the same cases must report bind_present flipping
  on hostile stores *without* `rank_hub_contamination`
  jumping on the hub-warm attacks. Do not raise SAVE_TIME_K
  by pointing at recall@k alone.

Neither lane should add these cases to `golden.json`.
