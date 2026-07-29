# Resonance Memory — roadmap

*Last updated July 2026. Companion documents: [`BACKLOG.md`](BACKLOG.md) (itemized work),
[`COMPETITIVE-ANALYSIS.md`](COMPETITIVE-ANALYSIS.md) (why this ordering),
[`proposed/`](proposed/) (design docs with pseudocode).*

## The goal

Be the memory layer people choose **instead of** paying $19–$249/month to Mem0, Zep, or a
hosted competitor — by being free, local-only, copyleft, and *architecturally* better at the
thing memory is actually for: association.

## The strategy in one paragraph

We are behind on the **write path** (extraction, dedup, contradiction, temporal) and on
**evaluation**, and ahead on **substrate** (Hebbian associative field — genuinely unique) and
**distribution UX** (zero-terminal single file, no API key). So: build the evaluation harness
first so every later claim is measurable, then close the write-path gap in the order that
compounds, and only then chase infrastructure. Never enter the benchmark number war —
compete on *reproducibility* instead, which hosted vendors structurally cannot match.

---

## Phase ordering (and why)

```
Phase 0  Measurement          ← nothing ships without it
Phase 1  Write path           ← the actual competitive gap
Phase 2  Retrieval + shape    ← where our substrate advantage compounds
Phase 3  Scope + scale        ← multi-agent, real storage
Phase 4  Reach                ← SDKs, platforms, ecosystem
```

The ordering is not arbitrary. Three rules drive it:

1. **Measurement precedes cleverness.** Extraction, dedup and conflict handling are all
   features that can make the system *worse*. Without a regression suite you cannot tell.
   Mem0 and Zep are locked in a public credibility fight *precisely* because numbers shipped
   ahead of methodology. Phase 0 is the cheapest insurance we will ever buy.
2. **The write path gates everything downstream.** Retrieval quality is capped by what got
   stored. Temporal reasoning is impossible without temporal metadata written at save time.
   Scoping is impossible without a scope field. All of it is Phase 1 or earlier.
3. **Our moat compounds only after the basics.** The Hebbian field is our differentiator, but
   tuning it (`RM-09`) on top of a store full of duplicates and contradictions is tuning
   noise. It comes *after* the store is clean.

---

## Phase 0 — Measurement (the foundation)

**Goal:** any change to memory behaviour can be shown to help or hurt, on one command.

| Item | What |
|---|---|
| `RM-00` | Eval harness + seeded corpora + `npm run eval` |

**Deliverables**
- A fixture corpus of messy, realistic inputs — including the cases nobody benchmarks:
  contradictions, restatements, partial updates, "actually, no", relative dates.
- Metrics: recall@k, MRR, **staleness rate** (answered from a superseded fact),
  false-supersession (hard gate — must be zero), duplicate rate, constraint surfacing,
  extraction precision/recall, write-latency, store growth.
- A **golden-set** regression gate: a change that drops any metric fails loudly.
- Reproducible with fixed seeds, offline, no API key, in under a minute.

**Exit criteria:** `npm run eval` prints a scorecard; CI fails on regression; the corpus
includes ≥50 contradiction/update cases (the axis LOCOMO and LongMemEval both under-test).

> **This phase is the single highest-leverage thing in this document.** Everything after it
> is guesswork without it.

---

## Phase 1 — The write path (closing the real gap)

**Goal:** what gets stored is clean, current, and structured — without a cloud LLM.

| Item | What | Depends on |
|---|---|---|
| `RM-01` | Extraction on write (heuristics first, optional local LLM pass) | `RM-00` |
| `RM-02` | Near-duplicate detection + merge | `RM-00` |
| `RM-03` | Contradiction / supersession (mark deprecated, prefer newer) | `RM-02`, `RM-04` |
| ~~`RM-04`~~ | ~~Temporal metadata~~ — ✅ **shipped** | — |

**Sequencing note.** `RM-04` went first for a reason: a *schema* change is cheap, and both
`RM-03` and later retrieval work are impossible without the fields in place. It has shipped —
`valid_from` / `valid_to` / `last_confirmed` / `superseded_by` are live, recall filters to
currently-true memories, and `supersedePatches()` applies a supersession atomically. **Nothing
calls it yet**: deciding *when* one fact replaces another is `RM-03`, still open.

**Design stance (see `proposed/0001`, `proposed/0002`):**
- **Heuristics before LLMs.** A tiered write pipeline: cheap deterministic rules handle the
  common cases; the local LLM pass is *optional*, off by default, and never blocks the save.
  Mem0's own 2026 move to single-pass ADD-only extraction (cutting write LLM calls 60–70%)
  is evidence that write-time LLM work is the expensive mistake, not the feature.
- **Invalidate, never delete.** Follow Graphiti's bi-temporal model: a superseded fact gets
  `valid_to` set to the superseding fact's `valid_from`, producing a non-overlapping validity
  chain. History is preserved; recall just prefers the current one.
- **The four verbs do not change.** All of this lives in the substrate. `save_memory` still
  takes `{content}`. This is a hard invariant (see DEVELOPERS.md).

**Exit criteria:** staleness rate and duplicate rate both drop measurably on the `RM-00`
corpus, with no regression in recall@k.

---

## Phase 2 — Retrieval and shape

**Goal:** find the right memory more often, and let the associative substrate earn its keep.

| Item | What | Depends on |
|---|---|---|
| `RM-05` | Hybrid retrieval — semantic + keyword (+ optional graph) via RRF | `RM-00` |
| `RM-08` | Soft constraints, importance decay, pruning rules | `RM-04` |
| `RM-09` | Neighborhood / Hebbian tuning | `RM-00`, Phase 1 |

**⚠️ Invariant conflict — must be resolved explicitly.** `DEVELOPERS.md` states
**"Ranking = cosine only"**, justified by a measurement showing durability-weighted ranking
inverts results. Hybrid retrieval *changes ranking*. This is a real conflict, not an
oversight. The resolution (detailed in `proposed/0003`):

- Hybrid ranking ships **behind a flag, off by default**.
- It is promoted to default **only** on an A/B win on the `RM-00` golden set.
- If it wins, `DEVELOPERS.md` is amended in the same PR with the measurement that earned it.
- The invariant's *spirit* — "no unmeasured signal touches rank" — is preserved, which is what
  actually matters. Rank changes are permitted; **unmeasured** rank changes are not.

**Exit criteria:** RRF hybrid beats cosine-only on the golden set, or is dropped and the
result documented.

---

## Phase 3 — Scope and scale

**Goal:** more than one user, more than one agent, more than a flat file.

| Item | What | Depends on |
|---|---|---|
| `RM-06` | Multi-user / multi-agent scoping; session vs long-term separation | `RM-00` |
| `RM-07` | Real store abstraction + SQLite backend | `RM-00` |
| `RM-10` | Idle-time consolidation ("sleep-time compute") | Phase 1 |

**`RM-07`'s dangerous half is already done.** `applyRecall()` used to rewrite the entire store
on every recall, which was both a stall and a whole-file data-loss window on power failure.
Both are fixed (`BUG-001`/`BUG-002` in [`BUGS.md`](BUGS.md)): writes are atomic, and access
counts moved to a sidecar so a recall performs no store writes at all. What remains is the
*performance* half — `all()` still parses the whole store per call and mutations still rewrite
it — which is a scaling limit, not a correctness one. SQLite with `sqlite-vec` + FTS5 is what
every local-first competitor already uses, and it makes `RM-05`'s keyword half nearly free.

**Exit criteria:** 100k-memory store recalls in <100ms p95; scoping isolates agents in the
eval; no MCP API change.

---

## Phase 4 — Reach

**Goal:** more places, more people, more failure modes observed.

| Item | What |
|---|---|
| `RM-11` | Cross-platform builds (macOS/Linux), signing |
| `RM-12` | SDKs — Python/TS client against a documented local HTTP API |
| `RM-13` | Opt-in, local-only telemetry + a reproducible failure-report bundle |
| `RM-14` | Hosted/enterprise — **deliberately deferred**, see below |

**On hosting and enterprise features.** This is the one item where the honest answer is
*"probably not, and that's a strategy, not a limitation."* The moment there is a hosted tier,
the local path starts to rot — that is visibly what happened to Zep's deprecated community
edition. Our whole claim is "nothing leaves this machine." If hosting ever happens it should
be a **separate product with a separate name**, so the local one can never be hollowed out to
protect revenue. Enterprise features that *don't* require hosting (SSO-free multi-user
scoping, audit logs, policy files) are fine and live in `RM-06`.

**On the distribution/failure-mode gap.** The competitive analysis identifies this as a
genuine moat we cannot code our way past: incumbents see the long tail of real abuse. `RM-13`
is the counter — *local-only, opt-in* telemetry plus a one-command "export a reproducible
failure bundle" so a user can hand us a case without handing us their memories. Ship it with
the eval corpus so contributions are directly runnable.

---

## What we are deliberately NOT doing

- **Not entering the benchmark number war.** No "we beat Mem0 on LOCOMO" marketing. The
  LOCOMO dispute (84% → 58.44% → 75.14%, all contested) is a cautionary tale. We publish a
  harness and let people run it.
- **Not adding a fifth verb.** Every capability here lands in the substrate. The tool surface
  may get *simpler*, never more demanding.
- **Not requiring a cloud LLM anywhere on the critical path.** Optional, local, off by default.
- **Not shipping a feature without its eval.** "It has a conflict handler" is worthless; "the
  conflict handler measurably reduces staleness" is the product.

## Success measures

| Horizon | Measure |
|---|---|
| Near | `npm run eval` is green and public; staleness + duplicate rates trending down |
| Mid | A user with 10k memories has a better experience than on Mem0 Starter, for $0 |
| Long | "Just use Resonance" is the default answer to "what memory layer should I use?" for anyone privacy-sensitive or price-sensitive |
