# H4 — cross-turn residual activation → Related: candidate expansion

**Date:** 2026-09-09 · **Branch:** `rm-h4-related-discovery` · **Embedder:**
`text-embedding-nomic-embed-text-v1.5` (cached, offline). **Reproduce:**

```
node test.js
node eval/run.js
node eval/h4-related-run.js
node eval/h4-related-run.js --floor 0.10
node eval/h4-related-run.js --floor 0.20
```

Criterion locked **before** looking at held-out. Flag `RESONANCE_WARM_RELATED`
default **off**. Primary ranking is not this experiment (I3 / I9).

---

## The claim, scoped

> **H4 (cross-turn residual activation → Related: candidate expansion, this
> mechanism, this contract) failed.** It did not earn adoption.

This is **not** “activation failed at associative discovery.” It is one
implementation under one contract: leftover spread-activation may expand the
`Related:` appendix; primary stays cosine. A miss here does not exhaust other
uses of activation for association.

Honest fork: **(b)**, with a **(c)** rider about what the miss is made of.
See §Fork.

---

## Disagreements (logged before the mechanism was locked)

1. **The existing cross-turn pool cannot show H4 discovery on typed
   constraints.** At product k=5 with field on, cold `Related:` already has
   the apex on 13/15 probes (constraint rescue). `xt-migraine-assoc` is the
   one existing miss — because `migraine` is **not** in `CONSTRAINT_RE`.
   Averaging those 13 as H4 “wins” would be the kNN-duplicate cheat the
   brief named. So: keep cross-turn as the **duplicate detector**, and add
   `eval/corpora/h4-related.jsonl` of non-constraint stars + a chain, with a
   pre-declared held-out slice.

2. **`related_rescue_rate` on this pool was a measurement lie.**
   `eval/measure.js` recalled at k=N so leftover rank was visible, and
   `memory-core` skips `Related:` when `k === N`. The metric read 0 because
   the appendix never ran. Fixed: product k=5 for `Related:`; full cosine
   rank from stored embeddings for `carryover_lift` when `warmRank` is off.
   Field-on `related_rescue_rate` on cross-turn is ~13/15, not 0. That is a
   measurement fix, not a product change.

3. **Warm turns must not run field-on.** A field-on warm turn accrues
   Hebbian (H10). The runner seeds leftover with field **off** (silent
   WarmField hook still seeds/spreads) and probes field-on. Otherwise a
   “Related: win” could be ledger, not activation.

4. **Pure leftover dump is the cheat, not a setting.** The brief’s
   falsifier is recency bleed (warm the cat, the leaf appears). The
   mechanism therefore requires a persist-net 1-hop to *this-turn* cosine
   seeds, and refuses retrieval leftover (`similarity != null`, H1b).
   That gate was locked before the run. It was not enough.

---

## Mechanism (flag-off default, byte-identical)

`RESONANCE_WARM_RELATED` (opt-in, like `RESONANCE_WARM_RANK`). Nested under
field-on: there is no `Related:` surface otherwise.

On each recall, **before** this-turn `seedAndSpread` (including the
`warmRank` path):

1. Snapshot `WarmField.leftoverEntries()` — `{ id, activation, similarity }`.
   `similarity == null` means spread-activated (H1a leaf). A number is a
   retrieval seed (H1b / last-hit recency).
2. Build cold `Related:` as today: constraint rescue, then neighborhood.
3. If the flag is on, append leftover candidates
   (`field.warmRelatedCandidates`) **after constraints, before
   neighborhood**, cap 4, sorted by leftover E:

   - E ≥ floor (default 0.05 = WarmField floor)
   - not already in primary / cold `Related:`
   - **spread-only** (`similarity == null`) — H1b is refused
   - **persist-net 1-hop to this-turn K_SEARCH seeds** — query-tied;
     a leftover cat with no persist-net neighbor in the potluck seed
     pool cannot enter
   - entity `logicalConflict` same as neighborhood

Primary string is not consulted. The whole path is inside the existing
field `try/catch` (I3). Flag-off skips the snapshot consumer.

Persist-net (save-time ≥ 0.25), not field kNN 0.70: requiring the
`Related:` graph would make every “win” a kNN duplicate by construction.

No model-facing label. Order inside `Related:` is the only distinction
(constraints, then leftover discoveries, then neighborhood).

---

## Metric (reporting registry, not golden)

`warm_related_discovery` in `eval/metrics.js`. Requires paired
`cold_related_ids` / `warm_related_ids` on the probe.

| number | definition |
|---|---|
| `discovery_rate` | of probes whose apex is in neither primary top-k nor cold `Related:`, the fraction where leftover put it in warm `Related:` |
| `new_vs_dup` | of Related:-only warm target-hits, the fraction that were **absent** from cold `Related:` |
| `intrusion_rate` | fraction of probes whose warm `Related:` contains a labeled `intrusion_ids` row (the cat) |
| `unrelated_target_lift` | fraction of `unrelated-control` probes that are `discovery`s — **warm the cat, the leaf appears** |
| `hub_share_of_new` | of ids in `{warm Related:} \ {cold Related:}`, how many are labeled hubs |

`compute()` returns `discovery_rate`. Unpaired → `null`, not a fake 0.

### Pre-registered pass bar (locked)

H4 earns adoption iff **all** hold at floor 0.05, in-pool first, then held-out:

1. in-pool `associative-carry` `discovery_rate` ≥ 0.5
2. those hits are new, not kNN dups: in-pool `new_vs_dup` ≥ 0.5, **and**
   cross-turn typed-constraint `n_duplicate ≥ n_discovery` (the predicted
   duplicate detector)
3. unrelated-control: labeled intrusion_rate = 0 **and**
   `unrelated_target_lift` = 0
4. `hub_share_of_new` ≤ 0.5
5. held-out `associative-carry` `discovery_rate` ≥ 0.5, and the chain
   shape is reported (expected-hard under 2-hop attenuation)

Cut if the new candidates are overwhelmingly things kNN already finds,
**or** the apparent gain is recency / hub bleed rather than H1a
association.

---

## Results (floor 0.05, then sensitivity)

### Cross-turn (typed-constraint stars — duplicate detector)

| slice | n | cold_miss | disc | dup | rate | new/dup | hub_new |
|---|---:|---:|---:|---:|---:|---:|---:|
| all | 15 | 1 | 0 | 13 | 0.000 | 0.000 | 0.843 |
| associative-carry | 11 | 1 | 0 | 9 | 0.000 | 0.000 | 0.821 |
| direct-leftover | 2 | 0 | 0 | 2 | n/a | 0.000 | 1.000 |
| unrelated-control | 1 | 0 | 0 | 1 | n/a | 0.000 | 0.667 |
| hub-warm-attack | 1 | 0 | 0 | 1 | n/a | 0.000 | 1.000 |

Cold `Related:` already has the apex on 13/15. The one cold-miss
(`xt-migraine-assoc`, not typed) is also a warm-miss. H4 added **zero**
new targets. It did add 2–4 **new hub filler** rows per probe
(`hub_share_of_new` 0.84). That is clause 4 failing on the duplicate
detector too: leftover is stuffing the appendix even when rescue
already did the job.

### h4-related (non-constraint; the actual window)

| slice | n | cold_miss | disc | dup | rate | new/dup | hub_new |
|---|---:|---:|---:|---:|---:|---:|---:|
| all | 9 | 9 | 4 | 0 | 0.444 | 1.000 | 0.758 |
| in-pool assoc-carry | 3 | 3 | 1 | 0 | 0.333 | 1.000 | 0.750 |
| held-out assoc-carry | 3 | 3 | 1 | 0 | 0.333 | 1.000 | 0.727 |
| star assoc-carry | 5 | 5 | 1 | 0 | 0.200 | 1.000 | 0.842 |
| chain (2nd shape, held-out) | 1 | 1 | 1 | 0 | 1.000 | 1.000 | 0.250 |
| direct-leftover | 1 | 1 | 0 | 0 | 0.000 | n/a | 1.000 |
| unrelated-control | 1 | 1 | 1 | 0 | 1.000 | 1.000 | 0.750 |
| hub-warm-attack | 1 | 1 | 1 | 0 | 1.000 | 1.000 | 0.667 |

Per-case (in-pool first, held-out last):

| id | disc | what newly entered Related: |
|---|---|---|
| `h4-caffeine-assoc` (right bridge) | n | 4 hubs. Leaf did not make the cap. |
| `h4-kiln-assoc` | Y | kiln **and** Koneko **and** two Thursday hubs |
| `h4-canal-assoc` | n | picnic / shade / kayaks / **Koneko**. Not the flood leaf. |
| `h4-caffeine-direct` (H1b) | n | hubs only. Spread-only gate held. |
| `h4-caffeine-unrelated` (warm cat) | **Y** | hubs **and the caffeine leaf**. Cheat. |
| `h4-caffeine-hubwarm` | Y | hubs **and** the leaf. Hub-warm “finds” it too. |
| `h4-backpain-assoc` HOLD | n | 4 work-spot hubs |
| `h4-earplugs-assoc` HOLD | n | 3 show hubs |
| `h4-canal-chain` HOLD | Y | Koneko, kayaks, job, **and** the flood leaf |

When the target appears, it was genuinely absent from cold `Related:`
(`new_vs_dup` = 1.0). That is clause 2a. It is **not** selective: the
same dump also fires on unrelated-warm and hub-warm, and the other
three new slots are hubs or controls.

### Sensitivity

Floor 0.10 ≈ floor 0.05 (spread leftover on this geometry sits ~0.2).
Floor 0.20:

- kills the unrelated false discovery (good)
- kills the chain “win” (2-hop dies, as pre-declared)
- in-pool still 1/3 (kiln only)
- hub-warm still “finds” the leaf
- `hub_share_of_new` **rises** to 0.80

Raising the floor does not turn a hub dump into H1a association. It
just deletes the weaker leftover, which was also where the chain lived.

---

## Clause-by-clause (floor 0.05, this mechanism)

| # | bar | result |
|---|---|---|
| 1 | in-pool assoc-carry discovery_rate ≥ 0.5 | **FAIL** 0.333 (1/3: kiln only; caffeine and canal miss) |
| 2a | in-pool new-vs-dup ≥ 0.5 | **PASS** 1.000 (the one hit was a real cold-miss) |
| 2b | cross-turn typed-constraint mostly duplicate | **PASS** disc=0 dup=9 (predicted) |
| 3 | no labeled intrusion **and** no unrelated target-lift | **FAIL** labeled cat-in-Related: = 0, but warming the cat **surfaced the caffeine leaf**; kiln/canal `Related:` also grew Koneko |
| 4 | hub_share_of_new ≤ 0.5 | **FAIL** 0.758 (h4-related) / 0.843 (cross-turn) |
| 5a | held-out assoc-carry ≥ 0.5 | **FAIL** 0.333 (chain only; backpain and earplugs miss) |
| 5b | chain shape reported | yes. Hit at 0.05 with control contamination; dies at floor 0.20 |

---

## Fork

**(b) Cut this mechanism.** Scoped: leftover spread-activation dumped into
`Related:` via persist-net 1-hop to this-turn seeds, spread-only, cap 4,
floor 0.05.

It failed because the query-tie is too promiscuous on the save-time graph
(K=5, min cosine 0.25, 2-hop spread). After any warm turn, leftover E sits
on a persist-net neighborhood. Turn 2 then admits **any** leftover node
that is 1-hop from the *new* seed pool. On a crowded store that set is
hub-shaped. The leaf is one neighbor among many; hubs sort higher on
leftover E and take the four slots. When the leaf does sneak in, so does
Koneko.

That is **persist-net recency wearing an association costume** — closer to
H1b working-state of a graph neighborhood than to H1a (a weak residual
trace on a semantically distant leaf). The H1a-shaped caffeine-assoc case
(warm the *right* bridge) **missed**. The unrelated and hub-warm cases
“hit.” Selectivity is inverted.

**(c) rider — what is still true, and must not be flattened:**

- The **I3 contract holds.** Flag-off is byte-identical. Primary is
  byte-identical flag on/off. A throwing leftover snapshot degrades to
  cold `Related:`. The golden is untouched (27/31). This is a safe
  negative, not a product regression.
- **Typed-constraint `Related:` already does the single-turn job.**
  Cross-turn leftover does not add targets there; it adds hub filler.
  That is the testpool-design H4 suspicion, now measured.
- **Spread-only (refuse H1b) did what it said.** `h4-caffeine-direct`
  did not launder retrieval leftover into `Related:`.
- **new-vs-dup is honest.** On the non-constraint window, cold `Related:`
  really does miss; H4’s problem is contamination, not duplication.
- Floor is not the lever. Geometry is.

Do not write “activation cannot help association.” Write: **this dump
into `Related:` is not association.**

---

## Recommended next node

Do **not** spend another slice on leftover-dump-into-`Related:` with a
looser gate or a higher cap. That is the w=1.0 shape on a different
surface.

If the tree continues on H4-ground:

1. **Tighter via (pre-register, don’t peek).** Candidate C qualifies
   only if it is persist-net 1-hop from a leftover *retrieval seed*
   that is **also** in this-turn K_SEARCH — i.e. the turn-1 bridge is
   still query-relevant — **and** Related: gets at most **one** such
   row (highest leftover E, or L1-share vs that bridge’s neighbors).
   Cheat detector stays: unrelated-warm must not surface the target
   (`unrelated_target_lift` = 0), and Koneko must not appear. If that
   still hub-dominates, stop.
2. **Do not** reopen extra leftover-seeds for constraint rescue on this
   pool — rescue already has the typed apex when the bridge is in
   K_SEARCH=15. That experiment needs cases where the bridge is *outside*
   the search radius, which this geometry does not have.
3. **Orthogonal, and maybe the real product question:** H6 — does the
   host attend to `Related:` at all? Cold field-on already puts diabetic
   in the appendix on the crowded potluck probe. If the model ignores
   it, stuffing more rows (even clean ones) is theatre. That is the
   live A/B rigs (`eval/ab/`, `eval/ab-grok/`), not this harness.

Flag stays **off**. The code stays behind the flag so the negative is
replicable. It is not a ship.

---

## Walls (checked)

- `node test.js` — `534 passed, 0 failed`
- `node eval/run.js` — `TOTAL: 27/31 checks passed` / `No regressions vs golden.`
- Flag-off default; eval does not read `RESONANCE_WARM_RELATED` from the
  process env.
- Corpora are fixtures; embeddings cached and committed.
- AGPL-3.0 header on new source (`eval/h4-related-run.js`).
- No fifth verb. Primary = cosine.

---
**Related:** part of the [activation & consumption campaign](../README.md) — the [research index](../README.md) holds the full tree: Lane A/B/C → decider → [[H4]] → [[H6]] → [[S2v2]]. See also the sibling lanes and `docs/phases/` (H6 prereg · contract · result · S2v2).
