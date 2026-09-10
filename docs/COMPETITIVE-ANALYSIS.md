# How Resonance Memory compares

*A fair, current look at where Resonance Memory (RM) sits in the AI-memory landscape — what
the strong incumbents do well, where RM is genuinely different, and where it's honestly behind.
Last updated September 2026.*

This is a fast-moving space and the vendors' own published benchmark numbers are actively
disputed (see [On benchmarks](#on-benchmarks)). So this document does **not** claim a leaderboard
win. It describes real capabilities and real gaps, and everything about RM here is verifiable in
this repository.

---

## The landscape

A quick, fair sketch of what the notable systems actually do. Each of these is good at something.

- **Mem0** — the mindshare leader. Its defining strength is *automatic extraction*: an LLM pass
  reads raw conversation and stores structured facts, preferences, and relationships instead of
  transcripts. Vector store with an optional knowledge graph; hosted service plus an open core.
  Making extraction *not worse than nothing* across thousands of messy real conversations is a
  genuine, hard-won capability.
- **Zep / Graphiti** — the technically deepest on time. A **bi-temporal** knowledge graph: every
  fact carries both when it was true in the world and when the system learned it. When a new fact
  contradicts an old one, Graphiti *invalidates* rather than deletes, preserving a clean history.
  The temporal-invalidation idea is the best single idea in the market, and it doesn't actually
  require a graph database to adopt.
- **Letta (MemGPT)** — memory as an operating system: tiered memory (core / recall / archival)
  that the agent edits via tool calls, plus idle "sleep-time" consolidation. The consolidation
  shape is a strong idea.
- **MemOS** — positions itself as a "memory OS" with strong published benchmark results across
  long-context memory tasks.
- **Local-first OSS memory servers** (a growing set) — SQLite + vector + full-text, MCP-native,
  no cloud. Local storage is now table stakes, not a differentiator.

RM overlaps with the last group on being local, and borrows the *shape* of the best ideas from
the others (temporal supersession from Zep's invalidation; idle consolidation from Letta) — but
its center of gravity is different, and that's the point of the rest of this doc.

---

## On benchmarks

The headline agent-memory benchmarks (LOCOMO and friends) are the subject of an ongoing, public
dispute between vendors — competing scores, disagreements over which task categories are in scope,
and claims of misconfiguration in both directions. Independent observers advise treating any
single vendor's number with caution.

RM's stance is deliberate: **we do not publish a competitive benchmark score.** Instead we ship
the evaluation harness itself. It runs **offline and deterministic** — cached embeddings are
committed, there's no network call and no API key — gates every change against a frozen golden
scorecard, and finishes in well under a minute. "Verify our claims on your own machine" is a
stronger, more honest claim than a leaderboard number, and it's one the hosted vendors
structurally can't match, because their evaluation needs their cloud.

Worth noting: the common benchmarks don't systematically test *contradictory* memories, even
though conflicting updates ("memory poisoning") are where production systems actually rot. RM
treats contradiction handling as a first-class, measured concern rather than an afterthought.

---

## Where RM is genuinely different

1. **Fully local, zero-cost, sovereign.** No account, no cloud, no API key, no per-seat pricing.
   Your memory is a single file on your own disk. This isn't a privacy policy — it's an
   architecture. There is no key to leak and no server to trust.
2. **An associative substrate, not just a store.** RM carries a Hebbian co-activation layer and
   spreading activation over its edges, modeled on how biological memory links concepts. Recall
   can surface a *neighborhood* of related memories, not just a ranked list — and that associative
   boundary is tested, not assumed (below).
3. **A four-verb interface a weak model can't misuse.** The model only ever sees
   `save / recall / edit / delete` and an opaque id. All the machinery — embeddings, ranking,
   dedup, supersession, disambiguation — lives in the substrate, out of the model's reach.
4. **Server-side entity disambiguation and polarity.** RM distinguishes "my sister Naima" from
   "a coworker named Naima," and keeps "I love cilantro" from collapsing into "I can't stand
   cilantro" — without asking the model to help. (Honest ceiling: arbitrary antonyms and
   same-name-same-role collisions ultimately need a small entailment model, which isn't built
   yet.)
5. **Anti-lock-in by design.** Export produces a portable bundle whose `memories.jsonl` a
   *competitor* could read without RM's software. Import restores it losslessly. Hosted services
   *are* the lock-in; RM's exit door is always open.
6. **Open-core, copyleft.** AGPL-3.0 keeps every fork open; a commercial license exists for those
   who can't adopt AGPL. The sovereign thing is free and stays free.

### The associative boundary is validated, not asserted

RM's core design rule is that the associative layer is *discovery, not ordering* — it can surface
related memories but must never reorder the authoritative, cosine-ranked result. That's easy to
claim. So it was stress-tested in a pre-registered behavioral study against a real local model
(stock Qwen3.6-35B): when a related memory directly *contradicts* the primary answer, with all
wording advantages controlled away, the model followed the primary channel in 100% of the cases
where it committed to a channel, and sided with the contradicting related memory zero times. The
associative layer enriches recall without hijacking it — measured, with a replayable log in this
repo (`docs/phases/s2v2-result.md`).

---

## Where RM is honestly behind, or doesn't do (yet)

No spin. If you need these today, RM is not your tool yet:

- **Multi-user / multi-agent scoping and session-vs-long-term separation** — not implemented.
  RM is currently a single-user substrate.
- **First-class hybrid retrieval** (BM25 + vector + reranking) — keyword is a fallback only, not a
  fused first-class retriever.
- **Idle / sleep-time consolidation** — designed and on the roadmap, not built.
- **SDKs** — none yet; the integration surface is MCP.
- **A hosted option** — intentionally none, and there won't be one. That's a feature for the
  sovereignty use case and a genuine limitation for anyone who wants managed infrastructure.
- **Maturity** — RM is early and single-author. It's tested (624 unit tests, a golden regression
  gate, a reproducible eval harness) but it has not been through the long-tail abuse that a
  hosted product with heavy traffic accumulates. That distribution-driven failure-mode knowledge
  is a real advantage the incumbents have, and it can't be shortcut.

---

## Capability snapshot

Honest scoring of RM today against the field. ✅ have it · 🟡 partial · ❌ absent.
(Competitor columns are directional; capabilities and tiers change.)

| Capability | Mem0 | Zep | Letta | **Resonance** |
|---|:--:|:--:|:--:|:--:|
| Semantic recall | ✅ | ✅ | ✅ | ✅ |
| Embed-once on save | ✅ | ✅ | ✅ | ✅ |
| Automatic fact extraction on write | ✅ | ✅ | ✅ | ✅ *(Tier 0/1 always-on; LLM tier opt-in)* |
| Deduplication | ✅ | ✅ | 🟡 | ✅ *(cosine-banded + backfill)* |
| Contradiction / temporal supersession | 🟡 | ✅ | 🟡 | ✅ *(exclusive-slot / polarity / numeric + cues)* |
| Temporal metadata | 🟡 | ✅ | ❌ | ✅ |
| Entity disambiguation + polarity | 🟡 | 🟡 | ❌ | ✅ |
| Associative / graph retrieval | 💰 paid tier | ✅ | ❌ | ✅ **free** |
| Hebbian co-activation reshaping | ❌ | ❌ | ❌ | ✅ **unique** |
| Pre-registered behavioral validation of recall | ❌ | ❌ | ❌ | ✅ **unique** |
| Hybrid retrieval (semantic + keyword) | ✅ | ✅ | 🟡 | 🟡 *(keyword fallback only)* |
| Decay / pruning | 🟡 | ✅ | 🟡 | 🟡 *(lazy edge decay + soft prune)* |
| Pluggable store backend | ✅ | ✅ | ✅ | ✅ *(SQLite default, JSONL fallback)* |
| Lossless export **and** import | 🟡 | 🟡 | 🟡 | ✅ |
| Eval / regression harness | ✅ | ✅ | ✅ | ✅ *(offline, deterministic, golden-gated)* |
| Multi-user / agent scoping | ✅ | ✅ | ✅ | ❌ |
| Idle / sleep-time consolidation | 🟡 | ✅ | ✅ | ❌ *(planned)* |
| SDKs | ✅ | ✅ | ✅ | ❌ |
| Cross-platform single-binary install | ❌ | ❌ | ❌ | ✅ |
| Runs with no API key / no cloud | 🟡 | ❌ | 🟡 | ✅ |
| Hosted option | ✅ | ✅ | ✅ | ❌ *(deliberate)* |
| Copyleft (forks stay open) | ❌ | ❌ | ❌ | ✅ |

---

## In one line

**Resonance Memory is the memory layer that costs nothing, sends nothing, and remembers by
association instead of as a flat list — with the recall behavior tested, not just claimed.** If
you want managed infrastructure, multi-tenant scoping, or SDKs today, an incumbent is the right
call. If you want a local, sovereign, auditable substrate you fully own and can verify yourself,
that's what RM is for.

---

## Related

[[ROADMAP]] · [[README]] · [[ARCHITECTURE]] · [[research/README]]
