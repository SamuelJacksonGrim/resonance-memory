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
  contradictory facts both store as current. This is `RM-03`.

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
