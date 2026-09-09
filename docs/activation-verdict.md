<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# Does activation-in-rank earn its place? — the three-lane verdict

**Question (pre-declared):** should Phase 1 spreading-activation enter the *primary*
recall ranking (behind the `RESONANCE_WARM_RANK` flag), or stay observable-only?

**Answer: CUT it from primary rank.** Keep the flag off, do not promote it to the
Phase 2.2 gate. This is the *pre-declared cut* firing, not a judgment call — see the
criterion below. The reason is **structural, not a tuning miss**, and all three research
lanes trisect the same wall.

This is not "activation is worthless." It is "activation does not belong in *ordering*;
it belongs in *discovery* (I3)." The constructive redirect is at the bottom.

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
- **Lane A (pool):** the surplus-only rule + a safe weight means single-turn primary
  rank *cannot* show activation's value by construction. A target inside the seed radius
  gets bonus 0; a target outside it gets a bump too small to enter the window without a
  weight that re-promotes hubs. Activation's payoff can only appear **cross-turn** and
  **in discovery**, not in single-turn ordering.

## The constructive redirect (what to build instead)

1. **Keep activation observable-only** (`RESONANCE_WARM_RANK` stays off, not promoted to
   2.2). This is now a *measured* decision, not caution.
2. **Bank L1-share as the Phase 2.4 normalization candidate.** It is the only shape that
   inverts hub→apex; when 2.2/2.3 land it is the damping to reach for. It earned that
   much even though it did not earn primary rank.
3. **Spend the Phase 1 slice on discovery, not ordering (I3-clean).** The unbuilt H4
   path — feed leftover cross-turn warmth into `Related:` *breadth* — is where the
   mechanism can pay off without touching primary cosine or the invariant. Today
   `Related:` is `field.js` kNN only; WarmField is never consulted. That is the next
   experiment, and it is safe by construction (additive discovery, never reorders).

## Reproduce

```
git checkout rm-decider-integration        # 528/0, golden clean
node eval/measure.js --corpus cross-turn   --warm-rank --warm-rank-shape l1 --warm-rank-weight 0.3
node eval/measure.js --corpus weak-recall  --warm-rank --warm-rank-shape l1 --warm-rank-weight 0.3
node eval/measure.js --corpus hub-vs-apex  --warm-rank --warm-rank-shape l1 --warm-rank-weight 0.3
```

Lane handoffs: `grok/handoffs/task-20260909-075628.md` (pool),
`…-075632.md` (combiner), `…-075636.md` (edges).
