# 0003 — Hybrid retrieval (semantic + keyword + graph) via RRF

**Status:** proposed · **Backlog:** `RM-05` · **Depends on:** `RM-00`

> **Design history — included in 0.2.0 (2026-09-10):** the problem statement and pseudocode
> below describe the earlier implementation, not current function locations or defaults.
> Current behavior and I2/I2b live in [ARCHITECTURE](../ARCHITECTURE.md#2-design-invariants-the-shape-is-load-bearing);
> item acceptance belongs to [BACKLOG RM-05](../BACKLOG.md). Default promotion must satisfy
> the full [Phase 2 gate](../phases/phase-2-retrieval-dynamics.md#fusion-promotion).

## Problem

Retrieval today is cosine-only, with `keywordScore` used **only as a fallback when the
embedding endpoint is down** — it appears exactly once in `server.js`, inside the `catch` of
`recallMemory()`. That means we lose on exactly the queries dense vectors are worst at:

| Query type | Why cosine struggles | Example |
|---|---|---|
| Rare proper nouns | Not well represented in embedding space | "what did I say about **Kwaltz**" |
| Exact identifiers | Tokenized into meaningless pieces | "invoice **AC-9931**" |
| Numbers / dates | Embeddings smear numeric distinctions | "the **$4,200** quote" |
| Negation | Dense vectors famously ignore it | "the client who **didn't** sign" |

Meanwhile keyword search is terrible at synonymy and paraphrase — which cosine is great at.
They fail in *complementary* directions, which is the textbook case for fusion.

## Design: Reciprocal Rank Fusion

Fuse **ranks**, not scores:

```
RRF(d) = Σ  1 / (k + rank_i(d))          k = 60
        arms
```

Why RRF rather than a weighted score blend:

- **It sidesteps score incompatibility.** Cosine ∈ [-1,1], BM25 ∈ [0,∞) and is corpus-
  dependent. Naïve weighted averaging of incommensurable scales is the classic production RAG
  bug. RRF ignores magnitudes entirely.
- **`k = 60` is the well-established default.** It damps the influence of deep results; lower
  `k` over-weights top ranks, higher `k` dilutes the fusion.
- **It degrades gracefully.** An arm that returns nothing simply contributes nothing — no
  renormalization, no special-casing. Given our embedding endpoint can be *down*, this
  property is worth a lot.

### Arms

1. **Dense** — existing cosine over stored vectors. Unchanged.
2. **Sparse** — BM25 over memory text. A real BM25, replacing the naïve `keywordScore`
   (which is unnormalized set-overlap and rewards long documents).
3. **Graph** *(optional)* — `field.js` neighborhood expansion from the top dense hits. This is
   where **our** substrate enters the ranking, which no competitor's fusion has.

### Implementation

```js
// retrieve.js
function rrfFuse(arms, { k = 60, limit = 5 } = {}) {
  const scores = new Map();                 // id -> { score, arms: {} }
  for (const [armName, ranked] of Object.entries(arms)) {
    ranked.forEach((id, i) => {
      const key = String(id);
      const cur = scores.get(key) || { score: 0, arms: {} };
      cur.score += 1 / (k + i + 1);         // rank is 1-based
      cur.arms[armName] = i + 1;            // keep per-arm rank for RM-19 explainability
      scores.set(key, cur);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([id, v]) => ({ id, score: v.score, arms: v.arms }));
}
```

BM25 over a local store, no dependencies:

```js
// bm25.js - k1/b are the standard defaults; tune only with RM-00 evidence.
class Bm25 {
  constructor(docs, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.docs = docs.map(d => ({ id: d.id, terms: tokenize(d.text) }));
    this.avgdl = this.docs.reduce((s, d) => s + d.terms.length, 0) / (this.docs.length || 1);
    this.df = new Map();
    for (const d of this.docs)
      for (const t of new Set(d.terms)) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.N = this.docs.length;
  }
  idf(t) {
    const n = this.df.get(t) || 0;
    return Math.log(1 + (this.N - n + 0.5) / (n + 0.5));      // BM25+ style, always positive
  }
  search(query, limit = 20) {
    const q = tokenize(query);
    return this.docs.map(d => {
      let s = 0;
      const len = d.terms.length;
      for (const t of new Set(q)) {
        const f = d.terms.filter(x => x === t).length;
        if (!f) continue;
        s += this.idf(t) * (f * (this.k1 + 1)) /
             (f + this.k1 * (1 - this.b + this.b * len / this.avgdl));
      }
      return { id: d.id, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.id);
  }
}
```

> **Once `RM-07` lands, delete most of this.** SQLite FTS5 gives BM25 natively and
> incrementally — no in-memory index rebuild per query. The class above is the JSONL-era
> bridge, and it is deliberately written to be thrown away.

### Wiring

```js
async function recallHybrid(query, k = 5) {
  const mems = store.current();
  const arms = {};

  try {
    const qv = (await embed([query]))[0];
    arms.dense = mems.map(m => ({ id: m.id, s: cosine(qv, m.embedding) }))
                     .sort((a, b) => b.s - a.s).slice(0, 20).map(x => x.id);
  } catch { /* endpoint down: sparse arm alone still answers */ }

  arms.sparse = new Bm25(mems).search(query, 20);

  if (fieldEnabled() && arms.dense) {
    const edges = field.buildEdges(mems, { k: 2, minSim: 0.55, bonus });
    arms.graph = field.neighborhood(edges, arms.dense.slice(0, 3), { hops: 1, max: 10 })
                      .map(e => e.id);
  }

  return rrfFuse(arms, { k: 60, limit: k });
}
```

Note the failure behaviour: **if embedding is down, hybrid still returns good results** from
the sparse arm rather than falling off a cliff. That is a robustness win independent of the
ranking-quality question.

---

## 5. The invariant question

I2 forbids unmeasured rank signals; I2b separately excludes access-frequency inputs.
[ARCHITECTURE](../ARCHITECTURE.md#2-design-invariants-the-shape-is-load-bearing) owns both
definitions and their measured rationale. This proposal does not amend them.

An implementation begins flag-off. A positive experiment alone does not authorize default
promotion: the complete [Phase 2 gate](../phases/phase-2-retrieval-dynamics.md#fusion-promotion)
owns the requirements, including competition, normalization, poisoning defense and the
measurement/documentation obligations. A failed gate leaves the flag off and records the
negative result.

---

## Risks

| Risk | Mitigation |
|---|---|
| BM25 index rebuild per query is O(N) | Cache/invalidate on write; FTS5 retrieval follow-up belongs to RM-05, not completed RM-07 |
| Keyword arm surfaces literal-but-irrelevant matches | RRF requires cross-arm agreement to rank highly |
| Graph arm amplifies its own Hebbian feedback loop | Graph is a *fusion input*, not a multiplier; ledger stays provenance-discounted |
| Fusion masks a broken dense arm | Per-arm ranks recorded and surfaced via `RM-19` |
| `k=60` is cargo-culted | Sweep `k ∈ {10,30,60,100}` in the A/B; publish the curve |

## Acceptance

- RRF beats cosine-only on `recall@5` **and** `MRR` on the golden set, **or** it's dropped and
  documented.
- Wins specifically on the `rare_noun`, `identifier`, and `negation` eval categories.
- With the embedding endpoint killed, hybrid still returns non-empty, sane results.
- Per-arm rank contributions visible in the panel (`RM-19`).

---

## Related

[[phase-2-retrieval-dynamics]] · [[BACKLOG]] · [[ARCHITECTURE]] · [[ROADMAP]] · [[proposed/README]]
