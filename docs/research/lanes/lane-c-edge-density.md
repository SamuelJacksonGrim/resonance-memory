# Lane C — edge-binding density / reachability

**Date:** 2026-09-09 · **Branch:** `rm-edge-density` · **Exploratory; not a ship.**
**Reproduce:** `node eval/edge-density.js` (offline, `embeddings.cache.json`).
**Flag-off golden:** `node test.js` → 519 passed, 0 failed; `node eval/run.js` → 27/31, no regressions.

The activation-in-rank A/B (`eval/RESULTS.md`) reported `vegetarian` bonus **0** and
read that as "save-time K=5 never wired the leaf." This slice asks the prior
question: **is the bottleneck that the relevant leaf often isn't reachable
from the query's seeds — and does denser or recall-time binding fix it?**

Coverage here is not recall@k. A target is **graph-reachable** if a path of
length ≤ 2 (Phase 1 `MAX_HOPS`) exists from the query's `K_SEARCH=15` cosine
seeds through the edge table (or the target is itself a seed). It is
**activation-reachable** if spread then puts `E > FLOOR` (0.05) on it. That
is a necessary condition for any combiner to lift it; it is not sufficient.

---

## Honest fork

**(b) — reachability is fine on this corpus. The miss is combiner / signal
(Lane B), not a missing wire.**

The A/B's vegetarian diagnosis was wrong. Status-quo persist (K=5, minCos
0.25) already puts a 1-hop (or seed) path on every field-rescue leaf, and
spread already arrives above the floor:

| leaf | cosine rank | seed? | persist degree | hops from seeds | E | rank bonus (no-double-count) |
|---|---|---|---|---|---|---|
| `diabetic` (`field-rescue`) | 21 | no | **5** | **1** (lemon bars, cos 0.613, seed rank 7) | 0.202 | 0.202 |
| `vegetarian` (`field-rescue-veg`) | 10 | **yes** | **13** | 0 (it *is* a seed) | 0.536 | **0.000** |
| `heights` (`field-rescue-heights`) | 18 | no | **5** | **1** (rooftop bar, cos 0.472, seed rank 11) | 0.167 | 0.167 |

`vegetarian` is not missing from the table. It is wired to risotto (0.520),
ribeye (0.571), the private room (0.543), and ten other dinner memories.
Bonus is 0 because the combiner zeros this-turn cosine seeds
(`activationRankBonus` = surplus above seed energy). Rank 10 is inside
`K_SEARCH=15` and outside return-k=5 — the gap Related: already knows how
to walk with constraint-rescue, on a **different** graph (`field.js`, gate
0.45, not the EdgeStore).

Raising K, dropping the persist floor, rebinding the whole store, and
unioning a recall-time seed-kNN **do not change E on any of the three
leaves** (diabetic stays 0.202, vegetarian 0.536, heights 0.167). Extra
neighbors raise degree (diabetic 5 → 13 at K=10 → 17 at K=15) but spread
is max-not-sum: the strongest 1-hop is already present.

So: (a) is false on the corpus that motivated the question. (c) is the
cost of a density bet we do not need for coverage here — see below for
when it would bite.

---

## The reachability gap (measured)

Corpora: `field-stress`, `field-noise`, `adversarial`, `constraints`
(12 associative queries). Seed radius 15, hops 2, floor 0.05.

**Rescue leaves (the three cosine misses):** graph 3/3, E>floor 3/3, in
return-k 0/3. One of three is a seed (vegetarian). Two of three are 1-hop
from a seed that constraint-rescue also uses (lemon bars / rooftop bar).

**All 12 associative targets:** graph 12/12, E>floor 12/12. Nine are
already in return-k (vacuous). The three misses are the rescue leaves
above — reachable, not ranked.

**TBR / noise excludes** (the items that must *not* surface): all four
are also seeds (mechanic rank 8, hike rank 14, heights-phobia rank 7,
shellfish rank 8). Their activation bonus is 0 for the same combiner
reason vegetarian's is. Denser wiring does not create these leaks *today*;
a combiner that stopped zeroing seeds would light them up immediately.
`adv-height-homonym` already persists bookshelf ↔ "terrified of heights"
at cosine 0.478 (above the constraint-rescue gate).

Empty leaf-diagnosis line for diabetic/heights in the harness means "no
reachability failure to report": they have a persist path and E above
floor. The failure is the +0.06 cosine bump at w=0.3 against a rank-21 /
rank-18 gap — Lane B's number, already in the A/B.

### Why the A/B probe misread vegetarian

The probe saw bonus 0 and inferred "not in the table." Two other facts
were sitting next to that zero:

1. Vegetarian is rank 10 — inside the seed radius the A/B used
   (`warmRankSeedK = K_SEARCH = 15`). Seed energy is clamped out of the
   rank bonus on purpose (no double-count). Bonus 0 is then the expected
   value even with a fully-wired leaf.
2. The leaf *does* have persist neighbors (degree 13). The first later
   write after the leaf is risotto; cosine 0.520 ≥ 0.25, so the undirected
   edge is created on risotto's save, when the store only has the leaf.
   K=5 cannot drop a 1-item neighborhood.

`diabetic` matching the A/B's E≈0.20 is the same 1-hop arithmetic the
probe got right: lemon bars is a seed (query cosine ≈ 0.66), conductance
≈ 0.613, attenuation 0.5 → E ≈ 0.202.

---

## Binding options (coverage vs cost)

Defaults stay K=5 / minCos=0.25 / recall-bind **off**. Knobs are
env + live-config, injected into `createCore` so eval/tests never inherit
a user env (same posture as `warmRank`).

### 1. Denser save-time K (5 → 10 / 15)

On the rescue leaves, coverage is already 3/3; E does not move.

On the union of the measured corpora (n=140, real nomic vectors,
sequential bind in save order):

| K | minCos | unique edges | mean degree | max degree | vs K=5 edges |
|---|---|---|---|---|---|
| 5 | 0.25 | 685 | 9.79 | 35 | 1.00× |
| 10 | 0.25 | 1 345 | 19.21 | 57 | 1.96× |
| 15 | 0.25 | 1 980 | 28.29 | 75 | 2.89× |

Scan cost is **O(N) regardless of K** — Phase 0.1 already timed the scan
at p95 **77.1 ms at N=100k** against a 250 ms budget. K only changes how
many of those neighbors are written. On this n=140 union, total sequential
bind was 255 ms at K=5 vs 330 ms at K=15 (~2 ms/save; the extra is persist,
not scan).

Extrapolating Phase 0.1's ~2.5 unique-edges/node at K=5 through the 2.89×
ratio: 100k memories → ~7 unique/node, **~723k edges** at K=15, vs ~250k
at K=5. JSONL sidecar rewrite of 50k edges was 59 ms / 17.7 MB; a 723k
rewrite would be ~850 ms / ~250 MB and would blow the 250 ms save budget
**on the rewrite**, not the scan. SQLite (the default) inserts
incrementally, so the live cost is per-edge INSERT, not a full rewrite —
still 3× the rows, still a bigger `spread()` walk if the cap is raised.

Hubs already exist at K=5 (max degree 35 on 140 clustered memories).
K=15 pushes max degree to 75. I8 will not trim them: they are
unreinforced **and** semantically strong (≥ 0.25), so `pruneSweep` leaves
them. Density is sticky.

### 2. Lower persist floor (0.25 → 0.20 / 0.15)

On this nomic food/office geometry, **K=15 minCos=0.15 produced the same
1 980 unique edges as K=15 minCos=0.25.** The 0.15–0.25 band is empty
inside top-K. The useful bridges are already 0.47–0.61. Lowering the
floor does not add coverage here.

I8 trap, tested: a persist floor below `SEMANTIC_PRUNE_GATE` (0.25) is
born already dead. `pruneSweep` marks unreinforced edges with semantic
< 0.25; `incident()` / spread skip `pruned_at`. A unit test fails if that
stops being true. Do not lower `RESONANCE_SAVE_MIN_COS` without also
dropping the prune gate — and on this corpus there is nothing in the
band to keep.

### 3. Complete-store rebind (kill save-order bias)

After every save, bind each record against the full store. On the rescue
leaves this raised diabetic/heights degree 5 → 8 and left E unchanged
(0.202 / 0.167). Vegetarian already had degree 13 (the later dinner
cluster kept picking it). Save-order is not the bottleneck when the leaf
is write #1 and the designed bridge is write #2: the bridge's
neighborhood is `{leaf}` and binds iff cosine ≥ 0.25, which both risotto
and lemon bars do.

Cost of a true all-pairs rebind is O(N²) cosine, the same class as
`field.buildEdges` (S1 field-on p95 **90.8 s at N=10k**). Not a save-path
option.

### 4. Recall-time ephemeral seed-kNN (`RESONANCE_WARM_RECALL_BIND`, default off)

Union a seed-only kNN (O(`K_SEARCH` · N), not O(N²)) into the spread
graph. Nothing is persisted (I5 / I7). On this corpus, every overlay —
union K=5/15 at 0.25 or 0.15, union K=2/0.45 (constraint-rescue shaped),
recall-only, full-store kNN — left rescue E unchanged.

Cost on n=140: **1.15 ms** for 15 × 140. Scaled with the Phase 0.1 scan
(77 ms per N=100k pass): 15 × 77 ms ≈ **1.2 s at 100k**, which blows the
S1 field-off 100 ms bar. Field-on already pays O(N²) for Related:; this
flag is for the field-off activation walk.

The one number that moved: recall-only (ignore persist) dropped heights
E 0.167 → 0.140. Persist had the rooftop-bar bridge; a seed-only kNN
with K=15 still has it, but conductance on the persist edge was the
better walk. Persist is not the problem.

---

## I8 / `WARM_EDGE_CAP` — the actual density walls

- **Soft-prune does not fight a denser graph at the current floor.**
  `pruneSweep` requires *both* unreinforced *and* semantic < 0.25. Every
  save-time edge is ≥ 0.25 by construction. Raising K adds permanent
  unreinforced structure. That is the two-signal rule that protects
  constraint-rescue; it also means K=15 is a one-way storage bet.
- **Spread is already off at product scale.** `WARM_EDGE_CAP=512`:
  `shouldSpread` is false when the store has more vectors than that.
  S1 is 1k–100k. A perfectly dense table is not walked. Denser persist
  cannot help activation at 100k unless the cap is raised, and raising
  the cap turns `spread()` into an O(E) walk over hundreds of thousands
  of edges on a recall path. That is a different slice, with a different
  budget.

2-hop through two 0.25 bootstrap edges from E=1 is 0.0156, **below
FLOOR 0.05**. Weak 2-hop structure does not deliver activation even when
the path exists. Coverage that matters is **1-hop from a strong seed**.
That is already what diabetic and heights have.

---

## Recommendation for Lane A's corpus

Do **not** spend the A/B budget on K=10/15 persist, a lower persist
floor, or recall-time bind as the primary lever. On the corpus that
produced the vegetarian/diabetic anecdote, those knobs do not change
whether the leaf is reachable or what E it gets.

What to test instead (Lane B's turf, validated on Lane A's store):

1. **Combiner that can use a seed outside return-k.** Vegetarian is rank
   10, E=0.536, bonus 0. A rule that zeros *return-k* seeds but not
   ranks 6–15 would give the combiner a signal Related: already knows is
   useful. Pre-declare the TBR cost: heights-phobia is rank 7 on the
   bookshelf query (also a seed, also bonus 0 today).
2. **A combiner willing to close a ~0.2 activation bump vs a rank-18/21
   cosine gap** — or a two-turn leftover-warmth corpus, as the A/B
   verdict already named. Denser wiring will not enlarge that 0.20.
3. **Only if Lane A's store shows a degree-0 leaf at rank > 15**, then
   A/B recall-time seed-kNN (flag `RESONANCE_WARM_RECALL_BIND`) before
   denser persist. Ephemeral, no I8 residue, cost O(15 N) at recall.
   Persist K=10 is the fallback if that flag wins *and* the win survives
   a restart (recall-time does not).

Negative-control on Lane A: `adv-height-homonym`. If a combiner or a
denser graph promotes "terrified of heights" into primary for a
bookshelf query, that is a TBR fail, not a coverage win.

Knobs shipped behind flags, default byte-identical:

| knob | env / live-config | default |
|---|---|---|
| save-time K | `RESONANCE_SAVE_K` / `save_k` | 5 |
| save-time floor | `RESONANCE_SAVE_MIN_COS` / `save_min_cos` | 0.25 |
| recall-time bind | `RESONANCE_WARM_RECALL_BIND` / `recall_bind` | **off** |
| recall-time K / floor | `RESONANCE_WARM_RECALL_BIND_K` / `_MINCOS` | 5 / 0.25 |

Eval/tests pin the constants. Production `server.js` reads env +
`resonance-memory.config.json`.

---
**Related:** part of the [activation & consumption campaign](../README.md) — the [research index](../README.md) holds the full tree: Lane A/B/C → decider → [[H4]] → [[H6]] → [[S2v2]]. See also the sibling lanes and `docs/phases/` (H6 prereg · contract · result · S2v2).
