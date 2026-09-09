<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# Does activation-in-rank earn its place? — the three-lane verdict

**Question (pre-declared):** should Phase 1 spreading-activation enter the *primary*
recall ranking (behind the `RESONANCE_WARM_RANK` flag), or stay observable-only?

**Answer: cut activation from *primary rank* — under the current contract.** Keep the flag
off, do not promote it to the Phase 2.2 gate. This is the *pre-declared cut* firing on that
one objective (enter the top-5 at a safe weight), not a judgment call — see the criterion
below.

**Say exactly what this earns, and no more.** The claim the data supports is narrow:

> Phase 1 activation, at its **current signal magnitude, spread semantics, and safe
> weight**, does not earn authority over primary semantic ordering without unacceptable hub
> contamination.

It does **not** establish that "activation doesn't belong in ordering," nor that its home
*is* discovery. Those are architectural *assignments* the experiment did not make — see
[What this does **not** establish](#what-this-does-not-establish). The tell is in the data
below: L1 @ w=1.0 puts the apex at #1 and the hub *out*. A mechanism that can do that is
carrying real relational signal; what failed is competing with cosine at a *safe* weight,
not the mechanism's right to exist. The constructive next test (H4), pre-registered with a
falsifier, is at the bottom.

---

## The decider run

Both the cross-turn pool (Lane A) and the L1-share combiner (Lane B) were brought onto
one branch (`rm-decider-integration`, merge of `rm-testpool` + `rm-combiner-research`;
gate **528 passed / 0 failed**, golden **no regressions**). This is the test no single
lane could run: Lane A built the corpus, Lane B built the shape, and neither had both.

Three corpora × three arms (cold / additive@0.3 / **L1-share@0.3**), k=5:

| Signal | cold | additive @0.3 | **L1-share @0.3** | reading |
|---|---|---|---|---|
| **`entered@k`** (warmed target crosses into top-5) | 0 | **0** | **0** | *the decider — never crosses* |
| `carryover_lift` (rank movement in the tail) | 0 | ±2/±3 | ±2/±3 | moves rank 20→22; never into the window |
| `rank_hub_contamination` (hub without apex) | 1.0 | **1.0** | **1.0 → 0.0** on discriminating cases | L1 is the only arm that damps the hub |
| `graph_bind_rate` (apex reachable) | 1.0 | 1.0 | 1.0 | reachability is never the problem |
| `staleness` / `false_supersession` | 0.4889 / 0.0256 | — | **0.4889 / 0.0256** | flag is inert on the supersession path |

The load-bearing cell is `entered@k = 0` **in every arm, on every bound case.** A
`carryover_lift` of +2 or +3 is real rank movement, but it moves a rank-20 leaf to
rank ~18 — it never reaches the top-5 the model actually sees. Lane A pre-declared
exactly this as *not a win*: "a mean lift of +3 that still misses top-5 is not a win."

## The pre-declared criterion, scored

**Earn rank** required *all five*; it fails at #1:

1. Bound assoc + direct-leftover: recall@5 warm > cold and ≥ half **enter the window** — **FAIL** (`entered@k = 0` everywhere, additive and L1).
2. `rank_hub_contamination` does not increase — pass (L1 *decreases* it).
3. Unrelated control does not enter the window — pass (trivially; nothing enters).
4. Staleness / false-supersession no worse — pass (byte-identical, 0.4889 / 0.0256).
5. Report bound/unbound, H1a/H1b, hostile/late, not averaged — done.

**Cut it** if *any* held; the first one holds: *"bound H1a does not move the window."*
→ **Cut.**

## Why it's structural — the three lanes converge

- **Lane C (edges):** reachability is **not** the bottleneck. `graph_bind_rate = 1.0`
  on every probe; the apex is a well-wired 1-hop neighbor of a strong seed. Denser K
  or recall-time binding buys nothing — the strongest 1-hop edge is already present.
  Vegetarian's bonus-0 was the *surplus-only combiner rule* (`max(0, E − cosine)`), not
  a missing edge.
- **Lane B (combiner):** L1-neighborhood-share is the **correct** shape — the only one
  that inverts hub→apex on the constructed discriminator, *and this now reproduces on the
  real pool*: `rank_hub_contamination` flips 1.0 → 0.0 on the weak-recall / hub-vs-apex
  cases where degree-normalization damps the dense cluster. But the right shape at a
  *safe* weight still cannot close a 0.20–0.28 cosine gap (its bump is ~0.15). Additive
  is worse: it can produce a +2 tail nudge while leaving hub contamination at 1.0.
- **Lane A (pool):** at a *safe* weight, a single-turn primary-rank objective can't show
  activation's value here — a target inside the seed radius gets bonus 0 (surplus-only), a
  target outside it gets a bump too small to enter the window without a weight that
  re-promotes hubs. This bounds the *ranking-at-safe-weight* contract; it does not bound
  activation's value on other contracts (discovery, cross-turn persistence), which are
  untested.

## What this does **not** establish

The three lanes killed real hypotheses (reachability; additive/RRF/ranknorm as the fix;
tuning the weight). They did **not** establish where activation belongs. Two distinctions
the ranking readout is blind to:

- **H1a ≠ H1b (do not average them).** *Associative* leftover (H1a: a residual trace on a
  semantically distant leaf, ~0.06–0.15 of signal) and *direct* leftover (H1b: the apex
  itself carries near-full residual activation) are **different phenomena**. H1a asks a weak
  trace to overpower a large cosine gap — no, not safely, unsurprising. H1b is **working-
  state persistence** — closer to recency than association — and was never given its own
  ranking contract. "Activation is X" collapses two mechanisms that need not share
  semantics.
- **Four axes, not one score.** The campaign is pulling apart signals that
  `final = cosine + activation` flattens: **cosine** = *what is this*; **association** =
  *what is connected to this*; **activation** = *what is recently salient*; **L1** =
  *how much of this activation is meaningful vs its local neighborhood*. These are not
  redundant. Collapsing them into one additive score may simply be the wrong abstraction —
  that is the durable finding to carry forward, above any single verdict.

## What to do next

1. **Keep activation observable-only** (`RESONANCE_WARM_RANK` stays off, not promoted to
   2.2). Measured, not caution. **Do not** keep tuning w = 0.31 / 0.35 / 0.4 — that is the
   trap the campaign was built to avoid.
2. **Bank L1-share as a Phase 2.4 normalization *candidate*** — a strong candidate, not a
   solved mechanism. It is the only shape that inverts hub→apex, and that survived the real
   pool. When 2.2/2.3 land it is the damping to reach for.
3. **Run H4 next — pre-registered (below).** Reframed from "can activation improve Related?"
   to the cleaner architectural test: *does cross-turn residual activation improve
   associative **discovery** without corrupting semantic **ordering**?* I3 gives the exact
   boundary: primary stays cosine-sovereign; activated + associated candidates may enter the
   `Related:` set only. Today `field.js` is kNN-only; WarmField is never consulted.

## H4 pre-registration (write the falsifier before the run)

Same discipline in reverse — so a 4% Related bump can't be back-read into "discovery is
activation's home." Measure per case, stratified, offline/deterministic:

**H4 EARNS adoption iff *all* hold:**
1. Warm `Related:` surfaces correct targets that cold `Related:` **missed**, at a meaningful
   rate (not noise).
2. Those surfaced targets are genuine **associative** targets — **not** items plain kNN
   already returns (the load-bearing falsifier: new discovery vs. duplicate of the neighbor
   set).
3. Unrelated warm topics do **not** intrude into `Related:` (the cheat detector).
4. Hubs do **not** dominate the newly surfaced candidates.
5. The effect survives **held-out** cases and ≥1 different graph shape / corpus.

**H4 is CUT iff:** the activated candidates are overwhelmingly things kNN already finds, or
the apparent gain is mainly generic recency / hub effect. If H4 *also* produces nothing,
then activation has been tested as ranking, association, **and** cross-turn discovery and
failed all three contracts — *that* would justify retiring the mechanism. We are not there.

## Reproduce

```
git checkout rm-decider-integration        # 528/0, golden clean
node eval/measure.js --corpus cross-turn   --warm-rank --warm-rank-shape l1 --warm-rank-weight 0.3
node eval/measure.js --corpus weak-recall  --warm-rank --warm-rank-shape l1 --warm-rank-weight 0.3
node eval/measure.js --corpus hub-vs-apex  --warm-rank --warm-rank-shape l1 --warm-rank-weight 0.3
```

Lane handoffs: `grok/handoffs/task-20260909-075628.md` (pool),
`…-075632.md` (combiner), `…-075636.md` (edges).
