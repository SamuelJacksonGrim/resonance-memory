# Combiner-shape research (Lane B)

**Date:** 2026-09-09 · **Branch:** `rm-combiner-research` · **Flag:** `RESONANCE_WARM_RANK` default **off**
**Golden:** `node eval/run.js` → 27/31, no regressions (flag-off). **Suite:** `node test.js` → 520 passed, 0 failed.
**Reproduce:** `node eval/combiner-research.js` (offline; `eval/embeddings.cache.json`).

This is the follow-up to the activation-in-rank A/B in [`eval/RESULTS.md`](eval/RESULTS.md). That run locked `final = cosine + 0.3 · surplus-activation` *before* looking at numbers and measured a zero: at the safe weight the +0.06 bump could not reorder; at `w = 1.0` the list moved and promoted Friday/office **hubs**, not the diabetic **apex**. The question here is whether that failure is the *additive combiner*, and whether a different fusion shape can lift the right target without promoting hubs — at a weight that does not nuke cosine.

It is exploratory, behind the flag, and **not** the Phase 2.2 promotion. Lane A's multi-turn/weak-recall corpus is the next validation; numbers here are "promising shape + why," not a ship.

---

## The honest fork

**(b).** A fusion shape is the difference between hub-promotion and apex-rescue on a constructed discriminator, but **nothing earns activation-in-rank at the locked safe weight (`w = 0.3`) on the original diabetic miss.** Neighborhood L1 share (proto-2.4) is the shape to take to Lane A. Rank-normalize (the named proto-2.3) does *not* damp hubs. Additive is confirmed as a bottleneck, not as the only one.

| Fork | What it would have looked like | What we saw |
|---|---|---|
| **(a)** fusion helps at a safe weight → rank is viable | diabetic (or equivalent apex) in top-5 at `w = 0.3`, hubs out | heights is a razor-margin existence proof for L1; diabetic still misses (gap 0.238 vs L1 bump 0.153) |
| **(b)** nothing helps without the full normalization → 2.3/2.4 first | combiner shape inverts hub vs apex *in principle*, but the locked weight still cannot close the measured gap | **this** — L1 inverts the constructed case at `w = 1`; at `w = 0.3` it is hub-safe and still short on diabetic |
| **(c)** even with normalization, hubs-or-nothing → rank may not be earned | L1 and rank-normalize still promote hubs whenever they promote anything | false on the constructed graph (L1 `w = 1` is apex-in, hub-out); mixed on real field-rescue (L1 `w = 1` is apex@1 *and* a hub@2) |

Recommended shape for Lane A: **`l1`** — `final = cosine + w · (node's surplus / Σ surplus in the 1-hop neighborhood)`, default `w = 0.3`, flag still off. Do not promote. Do not retune `w` to 0.47 to buy the diabetic case; that is the override 2.2 refused without 2.3/2.4 on the *graph*.

---

## Shapes (locked before the corpus run)

Surplus activation is unchanged from the A/B: this-turn cosine seeds contribute **0** (no double-count); only spread / leftover warmth enters. Unknown shape names fail-open to additive. Competitive shapes with an empty graph fail-open to additive (an empty neighborhood would otherwise give every spread node share 1.0 and invent a ranking).

| Name | Formula | Why it is in the set |
|---|---|---|
| **additive** | `cosine + w · bonus` | The A/B baseline. Confirm the failure. |
| **rrf** | `1/(k + rank_cos) + w / (k + rank_act)` | 0003 / Phase 2.2: scale-free rank blend. `k ∈ {1, 10, 60}`; 60 is Cormack/Clarke/Buettcher. Activation arm omits bonus-0 docs (an arm that did not retrieve contributes nothing). |
| **ranknorm** | `cosine + w · neighborhood-rank-norm` | The brief's proto-2.3: rank-normalize surplus inside the 1-hop neighborhood. Local max → 1.0; last of *n* → 1/*n*. Ties take the min rank, so a **uniform cluster of hubs all score 1.0**. |
| **l1** | `cosine + w · (bonus / Σ neighborhood bonus)` | Proto-2.4 homeostasis: bound total surplus per neighborhood. A uniform 8-node cluster gets 1/8; an isolated leaf next to a cosine-seed (bonus 0) keeps 1.0. |
| **multiplicative** | `cosine · (1 + w · bonus)` | 0003's other candidate. Cannot close a gap larger than the cosine itself. |

`w = 0.3` is the locked Related: `maxBonus` cap ("Hebbian must never fully override semantic"). `w = 1.0` is sensitivity, not a candidate default. Weights were declared; they were not searched.

Code: `fuseScoredWithActivation` in `memory-core.js`, injector `warmRankShape` / env `RESONANCE_WARM_RANK_SHAPE`. Default shape is additive so the existing A/B is byte-comparable.

---

## Discriminating test (constructed)

Injected graph, synthetic unit vectors (pairwise cosine = *cᵢ·cⱼ* ≪ `DEDUP_LO`, so RM-02.b does not merge). Seed radius 5; k = 5; cosine cutoff = 0.64.

- **Apex** (diabetic): cosine 0.25, rank 14, 1-hop from a lemon-bars seed at γ = 1.0 → E = 0.36, **L1 share = 1.0**, rank-norm = 1.0, degree 1.
- **Hub** (casual dress): cosine 0.48, rank 6, 1-hop from a cluster-seed into an 8-node Friday clique at γ = 0.9 → E = 0.315, **L1 share = 0.125**, rank-norm = 1.0 (tied local max), degree 8.

The two outcomes are distinguishable: additive-at-high-w should promote the hub; a combiner that damps rich-get-richer should promote the apex.

| shape | w = 0.3 | w = 1.0 |
|---|---|---|
| additive | neither | **hub@1** |
| rrf k = 1 | both, hub ahead | both, **apex@1** |
| rrf k = 10 | hub@2 | both, hub ahead |
| rrf k = 60 (0003 default) | **hub@1** | both, hub ahead |
| ranknorm | **hub@1** | **hub@1** |
| **l1** | neither | **apex@1, hub out** |
| multiplicative | neither | neither |

Live `createCore` recall (not just the pure function) matches the snapshot for additive `w = 1` (hub) and l1 `w = 1` (apex).

What this isolates:

1. **Additive at the locked weight cannot reorder** when the gap (0.64 − 0.25 = 0.39, 0.64 − 0.48 = 0.16) exceeds `w · bonus` (0.11 and 0.09). Same signature as the A/B's +0.06.
2. **Additive at `w = 1` promotes the hub**, not the apex. Confirmed.
3. **Rank-normalize does not damp a uniform cluster.** Tied local-maxima all get 1.0, so the hub's fused score is `0.48 + w` and it enters even at `w = 0.3`. Proto-2.3 as "rank-normalize then add" is the wrong damping.
4. **L1 is the only shape that inverts the discriminator** (apex in, hub out), and only at `w = 1`. At `w = 0.3` the isolate's +0.30 still leaves apex at 0.55 < 0.64.
5. **RRF at k = 60 hub-promotes at the safe weight.** Scale-free does not mean hub-free: the hub is cosine-rank 6 *and* activation-rank 2, so both arms agree it is better than the apex. k = 1 is the only RRF setting that puts apex first, and only at `w = 1` — that is an override, not a fusion.
6. **Multiplicative cannot close a large cosine gap.** `0.25 · (1 + 1.0 · 0.36) = 0.34`, still out.

---

## Real corpora (right answer known)

Same surplus snapshot per case; every shape reads the same (cosine, activation, save-time graph). Field off, so Related: constraint-rescue is not in the list — this is rank, not discovery.

### `field-rescue` (diabetic vs Friday/office) — the A/B's case

Query: *what should I bring to the potluck on Friday*. n = 24, seedK = 15. Cosine top-5 cutoff = **0.7143**.

| node | cos-rank | cosine | bonus | L1 share | rank-norm | deg | seed? |
|---|---|---|---|---|---|---|---|
| diabetic (apex, constraint) | 21 | 0.4761 | 0.2022 | **0.5102** | 1.0000 | 5 | no |
| casual dress (hub) | 17 | 0.5471 | 0.1979 | 0.1542 | 0.8571 | 12 | no |
| carpool with Dana (hub) | 16 | 0.5484 | 0.1804 | 0.3152 | 0.3333 | 8 | no |
| parking Fridays (hub) | 18 | 0.5345 | 0.1941 | 0.1306 | 0.6250 | 15 | no |
| lemon bars (bridge) | 7 | 0.6597 | 0 | 0 | — | — | **yes** |

Activation-arm #1 is *not* diabetic — it is "the office printer is out of toner" (bonus 0.2070). Diabetic is #2. The signal reaches the leaf (the A/B already said this). It is not larger than the cluster, and L1 only half-isolates it (share 0.51, not 1.0): save-time K = 5 bound five neighbors, some of them also surplus-warm.

Gap vs cutoff: **0.2381**. Additive bump at w = 0.3: **0.0607**. L1 bump at w = 0.3: **0.1531**. Short by 0.085. Closing the gap with L1 would need `w ≥ 0.238 / 0.510 ≈ 0.47`. That number is reported as a measurement, not used as a new default.

| shape | w = 0.3 | w = 1.0 |
|---|---|---|
| additive | neither | **hub@4,5** (casual, carpool) — A/B confirmed |
| rrf k = 1 | neither | both, apex@3 |
| rrf k = 10 | neither | both, apex@2 |
| rrf k = 60 | both, **hub@1** (apex@4) | both, hub ahead |
| ranknorm | both, **hub@1** (apex@3) | both, **apex@1** (hub@3,4) |
| **l1** | neither | both, **apex@1** (hub@2) |
| multiplicative | neither | neither |

Additive at `w = 1` is the A/B's hub-shaped list change, reproduced. L1 at `w = 1` is the first setting that puts diabetic at #1 — and a hub still occupies slot 2 (carpool 0.548 + 0.315 = 0.863). That is better than additive, not clean.

### `field-rescue-veg` (vegetarian vs meat dishes)

Vegetarian is **cosine-rank 10, inside the seed radius**, bonus **0**. Every surplus combiner is a no-op on the apex. The miss is not fusion: a rank-6…15 seed cannot be promoted without double-counting cosine. Gap to cutoff is only 0.043 (0.579 − 0.536) — cosine already almost has it; the surplus contract forbids the last step.

High `w` on this case promotes leftover *non-seed* noise (wine, bill, office) and can **kick a cosine-top-5 meat hub out** without ever moving vegetarian. That is a failure signature, not a win.

### `field-rescue-heights` (fear of heights vs Friday-drinks cluster)

Apex: rank 18, cosine 0.3955, bonus 0.1669, **L1 share = 1.0**, rank-norm = 1.0. The named hubs are *seeds* (ranks 4, 5, 8) with bonus 0 — they already occupy cosine top-5. Gap vs cutoff 0.6793: **0.2839**. L1 bump at w = 0.3: **0.3000**.

This is the razor-margin existence proof: **L1 (and rank-norm, and RRF k = 60) put heights in top-5 at the locked weight** (`apex@5` / `@3`). Additive does not (0.3 × 0.167 = 0.050, final 0.446 ≪ 0.679). Multiplicative does not.

It is also not a free lunch: the named "hubs" were never the A/B's failure mode here (they are cosine hits). The non-seed activation arm is three isolates (speakeasy, Uber, heights), all L1 = 1.0, so L1 cannot prefer heights over the speakeasy — cosine does (heights 0.396 vs speakeasy ~0.41-ish, and both get +0.3). Heights enters because the *cutoff* is a seed with bonus 0, not because L1 picked the constraint.

### Adversarial (`adv-height-homonym`, `adv-offtopic-quiet`)

n = 10 and n = 8, seedK = 15 → **every record is a cosine seed, activation arm empty.** Every shape is a no-op. Right answer stays in, phobia/allergy stay out. Combiner does not spend TBR. (Field-on Related: still bleeds `adv-height-homonym`; that is the existing golden, not this slice.)

---

## Sensitivity (declared, not a search)

- **`w`:** 0.3 is hub-safe for additive, L1, and multiplicative; it is already hub-promoting for rank-norm and for RRF k = 60 on both the constructed case and field-rescue. 1.0 is the only weight at which L1 inverts the constructed discriminator or puts diabetic at #1, and it is the weight the A/B already showed nukes cosine into cluster geometry.
- **RRF `k`:** 60 (the 0003 default) agrees with cosine enough to promote hubs. 1 is the override: activation-#1 can outrank cosine-rank 6, and on field-rescue at `w = 1` diabetic lands at #3. That is not "scale-free fusion at a safe weight"; it is a second ranking.
- **L1 vs rank-norm:** the two proto-2.3/2.4 shapes disagree on a uniform cluster. Rank-norm is not a cheaper 2.4. If Phase 2.3 is "neighborhood competition," it has to *split* a tied cluster (softmax, L1, degree-normalize), not award every local max a 1.0.

No weight between 0.3 and 1.0 was searched to flip diabetic. The closing weight under L1 is ~0.47; writing it down is the point of not using it.

---

## Why additive flatlined (restated with the new instrument)

The A/B's three-part diagnosis survives, with one correction.

1. **The signal exists.** Diabetic bonus 0.202 on field-rescue; constructed apex E = 0.36. Activation is not dead.
2. **At a safe weight the bump is too small.** Additive +0.061 vs a 0.238 gap (diabetic) or a 0.39 gap (constructed). L1 enlarges the isolate's bump (share 1.0 → +0.30) and that *does* close heights (gap 0.284). It does not close diabetic (share 0.51 → +0.153 < 0.238). So "2.3/2.4 would not enlarge a 0.06 bump" was true of *damping* and false of *L1 isolation share* — but isolation share still is not enough on the original miss.
3. **At `w = 1` additive promotes hubs.** Reproduced. L1 is the combiner-level reason: the cluster's surplus is divided, the isolate's is not. Rank-normalize does not do this.
4. **New: the surplus-only contract cannot promote a seed.** Vegetarian at rank 10 is geometrically almost in top-5 and combiners cannot touch it. Lane A's interesting case is leftover warmth from a *previous* turn (similarity `null`, full E is surplus), not same-turn spread into the seed radius.

---

## Recommended shape for Lane A

**`RESONANCE_WARM_RANK_SHAPE=l1`** with the locked `w = 0.3`. Predictions, so a miss is informative:

| Lane A target looks like… | L1 at w = 0.3 should… |
|---|---|
| Isolated leaf, cosine gap ≲ 0.3 (heights) | enter top-5, hubs that are seeds stay seeds |
| Isolated leaf, cosine gap ≳ 0.24 and share ~0.5 (diabetic) | still miss; do not raise `w` |
| Near-miss *inside* the seed radius (vegetarian rank 10) | miss unless a prior turn left surplus (the multi-turn corpus's actual job) |
| Dense cluster member just outside top-5 (casual dress) | stay out (share 1/*n*) — this is the test that additive failed |

If Lane A shows leftover-warmth isolates with gaps ≲ 0.3, L1 is a real (a). If the weak-recall targets are seed-radius near-misses or diabetic-sized gaps, that is (b) confirmed on a better corpus and rank stays off until 2.3/2.4 land on the graph (competition at spread time, not just at the combiner).

Related: constraint-rescue remains the working associative path (golden ROC 1/4 → 4/4, field-on). This slice does not touch it.

---

## Failure signatures tested

- Additive `w = 0.3` does not reorder the constructed case or field-rescue (A/B zero).
- Additive `w = 1` promotes the hub, not the apex (A/B hub list).
- Rank-normalize awards 1.0 to a tied cluster and hub-promotes at the *safe* weight.
- RRF k = 60 hub-promotes at the safe weight; k = 1 is an override.
- L1 without a graph fails open to additive (does not invent share = 1.0).
- Unknown shape names fail open to additive.
- Flag-off default remains byte-identical (existing tests + golden 27/31).
- Adversarial stores with no surplus arm stay clean (no TBR spend).
- Vegetarian-as-seed is unreachable — documented, not papered over by raising `w`.

---

## What this slice did not do

- Did not promote any combiner. Flag-off, default shape additive.
- Did not retune `w`, RRF `k`, seed radius, or save-time K.
- Did not put constraint-typing into the combiner (Related: already gates on `is_constraint`; folding that into rank would be a different design).
- Did not implement Phase 2.3/2.4 on the *graph* (spread-time competition, homeostatic edge weights). Combiner-time L1 is a readout, not a substrate change.
- Did not run Lane A's multi-turn corpus — that is the next round, and the reason these numbers are framed as a shape + a prediction rather than a gate.
