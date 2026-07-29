# 0006 — Soft constraints, importance decay, pruning

**Status:** proposed · **Backlog:** `RM-08` · **Depends on:** `RM-04`, `RM-00`

## Problem

Three related failures, all about *which memories deserve to be present*.

### 1. Constraints surface only when they happen to match

> "I'm diabetic — don't give me sugary recipes."

**First, a correction to an earlier draft of this document.** It claimed that asking for a
dessert wouldn't surface this memory, because "dessert" isn't close to "I'm diabetic." That
argument was wrong, and wrong in an instructive way: it silently compared the query against a
*truncated* version of the memory. The stored text contains **"sugary"** and **"recipes"** —
a dessert or recipe query has real lexical and semantic overlap with it, and probably does
clear the gate. The same draft then asserted two paragraphs later that "the substrate already
places these near each other," which contradicts the claim outright. **Treat the near-miss
case as unmeasured until `eval/constraints` says otherwise** (see `RM-00`).

**And a second correction, because the first fix didn't go far enough.** A revision then kept
"semantic distance" as the leading argument and merely appended a caveat to it. That was still
wrong-headed: if the chain `potluck → food → sweets → diabetic` is already in the embedding —
and it very likely is, since the model was trained on text where those co-occur constantly —
then distance isn't the problem at all, and it should not be leading anything.

Reordered by what actually survives, strongest first:

1. **Top-k crowding.** *This is the real argument, and it holds no matter how good the
   embedding is.* A constraint can score well above the gate and still be squeezed out: it
   competes for `k=5` slots against memories that match the phrasing *more* directly. Ask for
   a dessert recipe with 500 memories stored and the top five may all be recipes, with the
   constraint at rank 8. **Similarity was never the failure — the budget was.** Better
   embeddings make this *worse*, not better, because they surface more strong near-matches to
   compete with.
2. **Recall has to fire at all.** Surfacing depends on the model choosing to call
   `recall_memory` in that turn. No amount of retrieval quality helps if it doesn't. Also
   independent of the embedding.
3. **Semantic distance — possible, unproven, and probably smaller than assumed.** There may
   be queries genuinely too far to reach ("we're celebrating Friday"), but every concrete
   example anyone has produced so far dissolved on inspection. `constraint-far-sparse` in
   [`0007`](0007-eval-harness.md) exists to find a real one. Until it does, **treat this as
   speculative and do not build for it.**

### What that costs this design

Non-trivially: **most of it.** If crowding is the whole problem, the fix is a **reserved slot**
— hold one of the `k` results for the highest-scoring constraint — and the domain-probe
machinery in Part 1 below is unnecessary. That's roughly ten lines instead of a subsystem.

The `constraintDomain()` / `applicableConstraints()` design is kept below because it is the
right answer *if* `constraint-far-sparse` fails. **Build the reserved slot first, measure,
and only build the domain model if the measurement demands it.** The 2-hop domain remains the
tool for the `chewtoy → heartworm → walk → diabetes → sugar` case, where each link is close
but the endpoints are far — if that case turns out to be real.

### 2. Everything is equally permanent

A store only grows. "I'm allergic to penicillin" and "I'm at the airport" have identical
standing forever.

### 3. Nothing is ever removed

There is no pruning at all. `importance` is assigned (`= access_count`) and then never read by
anything. It is currently a **write-only field** — dead weight that looks like a feature.

---

## Part 1 — Constraints as a memory kind

### Classification (write side, cheap)

```js
const CONSTRAINT_RE = new RegExp([
  /\b(i'?m|i am) (allergic to|diabetic|vegetarian|vegan|lactose|celiac|sober)\b/,
  /\b(don'?t|do not|never|avoid|no more) \w+/,
  /\b(i can'?t|i cannot|i must not|i'?m not allowed to) \w+/,
  /\b(always|never) (give|send|suggest|recommend|use|call) me\b/,
].map(r => r.source).join("|"), "i");

function classify(text) {
  if (CONSTRAINT_RE.test(text)) return "constraint";
  return "fact";
}
```

Stored as `kind: "constraint"` (backfilled `"fact"` by `normalize()`, so nothing migrates).

### The reserved slot — build this first

If crowding is the problem, this is the entire fix. Reserve one of the `k` result slots for
the best-scoring constraint, so a constraint that clears the gate can never be squeezed out by
memories that merely match the phrasing more closely.

```js
const CONSTRAINT_GATE = 0.42;    // below the 0.55 edge gate; tune on RM-00

function withReservedConstraint(ranked, all, queryVec, k = 5) {
  if (ranked.some(m => m.kind === "constraint")) return ranked;   // already surfaced

  const best = all
    .filter(m => m.kind === "constraint" && !ranked.includes(m))
    .map(m => ({ m, s: cosine(queryVec, m.embedding) }))
    .filter(x => x.s >= CONSTRAINT_GATE)
    .sort((a, b) => b.s - a.s)[0];

  if (!best) return ranked;
  return [...ranked.slice(0, k - 1), best.m];   // drop the weakest, seat the constraint
}
```

Note what this does *not* do: it doesn't reorder the primary results and it doesn't invent a
similarity signal. It spends one slot of the output budget. **Ten lines, no new subsystem, and
it addresses the argument that actually survived.**

Everything below is the fallback for the case where similarity genuinely can't reach — build
it only if `constraint-far-sparse` proves that case is real.

### Domain extraction

A constraint needs to know *what it governs*. We already have the machinery — the constraint's
own embedding — so the domain is defined by proximity rather than by a taxonomy:

```js
/*
 * A constraint applies to a query when the query is semantically near the
 * constraint's DOMAIN, which is broader than the constraint's text.
 *
 * "I'm diabetic" -> domain includes food, sugar, dessert, recipes, snacks, health.
 *
 * We derive it without an LLM: take the constraint's neighborhood in the existing
 * association graph and use those memories as additional probes. This is precisely
 * what field.js already computes - we just consult it at a different moment.
 */
function constraintDomain(constraint, edges, records) {
  const near = field.neighborhood(edges, [constraint.id], { hops: 2, max: 12 });
  return {
    id: constraint.id,
    probes: [constraint.embedding, ...near.map(n => byId(records, n.id).embedding)].filter(Boolean),
    hops: new Map(near.map(n => [String(n.id), n.sim])),
  };
}
```

**Two hops, not one** — that's what carries `sugary recipe → walk → dog`. The graph is the
domain model; we don't need to build a second one.

### Surfacing

```js
// Reuses CONSTRAINT_GATE from the reserved-slot section above.
function applicableConstraints(queryVec, constraints, domains) {
  const hits = [];
  for (const c of constraints) {
    const d = domains.get(String(c.id));
    // Max over probes: near ANY part of the constraint's domain is enough.
    const score = Math.max(...d.probes.map(p => cosine(queryVec, p)));
    if (score >= CONSTRAINT_GATE) hits.push({ c, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 3);
}
```

Appended to recall as a **separate section**, not merged into the ranked list:

```
1. [id 12] Rex needs his heartworm meds monthly
2. [id 31] I usually walk 3 miles after dinner

Keep in mind:
- [id 7] I'm diabetic — no sugary recipes.
```

> ### ⚠️ Invariant check
> This does **not** violate "ranking = cosine only." The ranked list is untouched, in the same
> order, by the same rule. Constraints are an *additional section* — the same structural move
> the associative field already makes with its `Related:` block, which was accepted on exactly
> this basis. Nothing is reordered; something is added.

---

## Part 2 — Importance decay

Replace the write-only `importance = access_count` with something that actually means
"how much does this still matter."

```js
/*
 * Exponential decay with a floor, refreshed by use.
 *
 *   importance(t) = base * exp(-lambda * days_since_confirmed) + floor(kind)
 *
 * lambda is per-kind: a constraint should barely decay; an observation should
 * fade quickly if never touched again.
 */
const HALF_LIFE_DAYS = { constraint: Infinity, preference: 365, fact: 180, observation: 30 };

function importanceOf(r, now = Date.now()) {
  const hl = HALF_LIFE_DAYS[r.kind] ?? HALF_LIFE_DAYS.fact;
  if (hl === Infinity) return 1;                         // constraints never decay
  const days = (now - Date.parse(r.last_confirmed || r.created)) / 864e5;
  const lambda = Math.LN2 / hl;
  const base = Math.min(1, 0.3 + 0.1 * (r.access_count || 0));   // use raises the ceiling
  return base * Math.exp(-lambda * days);
}
```

Two properties worth stating:

- **`last_confirmed` is the clock, not `created`.** A ten-year-old fact you reaffirmed
  yesterday is fresh. `RM-04` put that field there for exactly this.
- **Access raises the ceiling, not the score.** Frequently-used memories decay from a higher
  base rather than getting a rank bonus. **Importance still never touches ranking** — it
  governs retention only, per the invariant.

---

## Part 3 — Pruning (proposal, never silent deletion)

```js
const PRUNE_FLOOR = 0.05;

function pruneCandidates(store, now = Date.now()) {
  return store.current()
    .filter(r => r.kind !== "constraint")          // never propose a constraint
    .filter(r => !r.pinned)                        // never propose a pin
    .map(r => ({ r, importance: importanceOf(r, now) }))
    .filter(x => x.importance < PRUNE_FLOOR)
    .filter(x => (x.r.access_count || 0) === 0)    // never recalled even once
    .sort((a, b) => a.importance - b.importance);
}
```

Superseded memories are a separate, safer case — their successor already carries the truth:

```js
// A superseded memory whose successor has itself been stable for months is
// history nobody is reading. Drop the EMBEDDING (the bulk), keep the TEXT.
function compactSuperseded(store, { afterDays = 180 } = {}) {
  for (const r of store.all()) {
    if (!r.valid_to || !r.embedding) continue;
    if ((Date.now() - Date.parse(r.valid_to)) / 864e5 > afterDays)
      store.update(r.id, { embedding: null, compacted: true });
  }
}
```

That reclaims ~95% of the bytes (768 floats vs a sentence) while keeping the historical record
readable. It directly answers the `store_growth` risk flagged in `proposed/0002`.

### The rule that matters

> **Nothing is ever deleted without the user seeing it first.**

Pruning produces a **review list in the panel**, with a one-click "keep" that pins the memory
and a "forget these" that batch-deletes. An idle pass may *propose*; only a human disposes.

This is not timidity. The asymmetry is real: a wrongly-kept memory costs a few bytes and a
slightly noisier graph. A wrongly-deleted memory is *gone*, the user finds out at the worst
possible moment, and they never trust the tool again. For a product whose entire pitch is
"this remembers for you," silent forgetting is the one unforgivable bug.

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `constraints` | `true` | Surface applicable constraints on recall |
| `constraint_gate` | `0.42` | Domain-proximity threshold |
| `decay` | `true` | Compute importance with decay |
| `prune_review` | `true` | Generate prune proposals during idle passes |
| `auto_prune` | **`false`** | Never default to true |

## Risks

| Risk | Mitigation |
|---|---|
| Constraint fires on every query (noise) | Gate tuned on `RM-00`; hard cap of 3; measured by a false-positive metric |
| Constraint *misses* when it matters | `constraint_surfacing ≥ 0.9` is the acceptance gate; 2-hop domain is generous by design |
| Decay drops something needed yearly ("my sister's birthday") | Never auto-prune; `last_confirmed` refresh on any access; pinning |
| Classifier mislabels a fact as a constraint | Over-inclusion is cheap here (a constraint just decays slower); under-inclusion is the costly error |
| `importanceOf` is recomputed on every read | Pure function of stored fields — memoize per read; no write amplification |

## Acceptance

- **`constraint_surfacing ≥ 0.9`** on `eval/constraints` — including the dog→walk→diabetes→
  sugar chain, which is the canonical case.
- Constraint false-positive rate < 0.1 on unrelated queries.
- **Zero** unreviewed deletions, ever.
- `store_growth` on the `RM-15` soak improves measurably with `compactSuperseded` on.
- Ranked recall order is **byte-identical** with constraints on vs off (they add a section;
  they do not reorder).
