# Competitive analysis — the AI memory layer market

*Compiled July 2026. Every claim here is sourced; re-verify before quoting numbers publicly,
because this market's published benchmarks are actively disputed (see §4).*

The goal of this document is not to cheer. It is to answer three questions honestly:

1. What do the paid incumbents actually do that we don't?
2. Where is their moat real, and where is it just funding and marketing?
3. What is the shortest credible path from where Resonance Memory is today to being
   the thing a person picks *instead of* paying $249/mo?

---

## 1. The field

| System | License | Hosted price | Local/self-host | Core idea |
|---|---|---|---|---|
| **Mem0** | Apache 2.0 core | Free (10K adds) → $19 → $79 → **$249** Pro | Yes, mature | LLM extracts facts on write; vector + KV, **graph only on Pro** |
| **Zep / Graphiti** | Graphiti OSS (Apache) | **$25** Flex (graph at every tier) → enterprise | Graphiti yes; **Zep community edition deprecated** | Bi-temporal knowledge graph, edge invalidation |
| **Letta (MemGPT)** | Apache 2.0 | Cloud + OSS | Yes | Agent *self-edits* memory blocks; sleep-time compute |
| **MemOS** | Research/OSS | — | Yes | "Memory OS", strong LOCOMO/LongMemEval numbers |
| **Supermemory / Cognee / EverMind / Hindsight** | Mixed OSS | Varies; Hindsight ships all features at every tier | Yes | Consolidation-focused, graph retrieval |
| **VEKTOR / OMEGA / Mnemosyne / memory-mcp** | OSS | Free | Yes, local-first | SQLite + `sqlite-vec` + FTS5, MCP-native, no cloud |
| **Resonance Memory** | **GPL-3.0** | **$0** | Local-only by design | kNN associative field + **Hebbian co-activation reshaping** |

### What the incumbents actually give you

**Mem0** — the market leader by mindshare (58.4K GitHub stars as of June 2026). Its
defining feature is *automatic extraction*: you feed it raw conversation, an LLM pass pulls
out structured facts, preferences and relationships, and it stores those instead of
transcripts. In 2026 they moved to **single-pass ADD-only extraction** — one LLM call to
extract, with conflict resolution deferred to retrieval time or handled async — which cut
write-time LLM calls 60–70%. That is a direct admission that *write-time conflict resolution
is the expensive, hard part*, and it is worth internalizing before we build ours.

**Zep/Graphiti** — the technically deepest. A **bi-temporal** knowledge graph: every fact
carries both *valid time* (when it was true in the world) and *ingestion/transaction time*
(when the system learned it), tracked as four timestamps (`t_valid`, `t_invalid`,
`t'_created`, `t'_expired`). When a new fact contradicts an old one over an overlapping
window, Graphiti **invalidates rather than deletes** — it sets the old edge's `t_invalid` to
the new edge's `t_valid`, producing a non-overlapping validity chain and preserving history.
This is the single most-copyable good idea in the market and it does **not** require a graph
database to implement (see `proposed/0002`).

**Letta** — memory as an OS. Three tiers (core / recall / archival) and the agent edits its
own memory via tool calls. **Sleep-time compute** is their sharpest idea: agents reflect on
history during idle periods and consolidate memories asynchronously, improving both latency
and memory quality. We can steal the *shape* of this (idle-time consolidation) without the
agent-framework baggage.

---

## 2. Where the moat is real

Be honest — three of these are genuine:

1. **Extraction quality under messy input.** Anyone can write an extraction prompt. Making
   it not-worse-than-nothing across thousands of real, weird conversations takes evaluation
   data and iteration. This is the gap the user correctly identified: *"the difference between
   'it has a conflict handler' and 'the conflict handler rarely makes things worse.'"*
2. **Distribution → failure-mode knowledge.** Incumbents see the long tail of how people and
   models actually abuse the tools. That's information, not code, and we can't shortcut it.
   Mitigation: ship telemetry that is **local-only and opt-in**, plus a public eval corpus so
   contributors can report failures reproducibly.
3. **Coherence at scale over time.** A prototype that handles one contradiction is easy. One
   that stays coherent after *hundreds* of updates is a different artifact. This is why the
   eval harness (`proposed/0007`) must land **before** the clever features, not after.

## 3. Where the moat is *not* real

1. **Graph memory is not worth $249/mo.** Mem0 locks graph memory to Pro — a 13× jump from
   the $19 Starter — and the $19→$249 cliff is the single most-cited community frustration on
   HN and developer forums. Zep undercuts this by including the temporal graph at $25. There
   is a large, visibly annoyed population between those price points. **That is our wedge.**
2. **Token costs are a real, documented pain.** Mem0 GitHub issue #2066 documents graph-mode
   costs 15× higher than generation, with 62 photo descriptions taking over an hour to save.
   Every LLM call on the write path is a cost, a latency spike, and a privacy leak. Our
   embed-once-locally design has a **structural** advantage here that no amount of their
   funding erases.
3. **Self-hosting is being quietly de-prioritized.** Zep's community edition is deprecated.
   The hosted tier is where the money is, so the local path rots. We are local-*only*; ours
   can't rot.
4. **"Local-first" alone is not a differentiator anymore.** VEKTOR, OMEGA, Mnemosyne and
   memory-mcp all do local SQLite + embeddings + MCP, and OMEGA claims 95.4% on LongMemEval.
   We must **not** market on "local" alone — it's table stakes now. Our differentiator has to
   be the associative substrate and the zero-terminal UX.

## 4. The benchmark situation is a mess — use it

LOCOMO is the headline benchmark and its numbers are *actively disputed*:

- Zep published **84%**.
- Mem0 responded that Zep included adversarial categories the spec excludes → **58.44%**.
- Zep rebutted that Mem0 misconfigured Zep → corrected **75.14%**, ~10% over Mem0's best.
- Mem0's 2026 algorithm claims **92.5 LOCOMO / 94.4 LongMemEval**.
- MemOS claims best-average across task categories.

Independent observers advise treating *any* single vendor number with caution. Two
takeaways:

- **Do not enter the number war.** Publishing "Resonance scores X on LOCOMO" invites the same
  credibility spiral. 
- **Do compete on reproducibility.** Ship the harness, the corpus, the seeds, and a one-command
  reproduce script. "Run it yourself in 30 seconds on your own machine" is a *better* claim
  than a number, and it's one the hosted vendors structurally cannot match — their eval needs
  their cloud.

Also note: **neither LOCOMO nor LongMemEval systematically tests contradictory memories**,
even though conflict resolution is where production systems rot ("memory poisoning"). The
`Supersede` paper (arXiv 2606.27472) exists specifically to diagnose this *memory-update gap*.
That's an under-served evaluation axis where we can lead rather than follow.

---

## 5. Capability gap matrix

Honest scoring of Resonance Memory **today** against the field. ✅ have it · 🟡 partial · ❌ absent.

| Capability | Mem0 | Zep | Letta | **Resonance (today)** | Backlog item |
|---|:--:|:--:|:--:|:--:|---|
| Semantic recall | ✅ | ✅ | ✅ | ✅ | — |
| Embed-once-on-save | ✅ | ✅ | ✅ | ✅ | — |
| Automatic fact extraction on write | ✅ | ✅ | ✅ | ❌ | `RM-01` |
| Deduplication | ✅ | ✅ | 🟡 | 🟡 *(exact-match only)* | `RM-02` |
| Contradiction / supersession | 🟡 | ✅ | 🟡 | 🟡 *(applies it; can't yet detect it)* | `RM-03` |
| Temporal metadata (valid-from/to) | 🟡 | ✅ | ❌ | ✅ | — |
| Hybrid retrieval (semantic+keyword) | ✅ | ✅ | 🟡 | 🟡 *(keyword only as fallback)* | `RM-05` |
| Graph retrieval | 💰 Pro | ✅ | ❌ | ✅ **free** | — |
| **Hebbian / co-activation reshaping** | ❌ | ❌ | ❌ | ✅ **unique** | `RM-09` |
| Importance decay / pruning | 🟡 | ✅ | 🟡 | 🟡 *(retention signal only)* | `RM-08` |
| Multi-user / agent scoping | ✅ | ✅ | ✅ | ❌ | `RM-06` |
| Session vs long-term separation | ✅ | ✅ | ✅ | ❌ | `RM-06` |
| Idle/sleep-time consolidation | 🟡 | ✅ | ✅ | ❌ | `RM-10` |
| Pluggable store backend | ✅ | ✅ | ✅ | 🟡 *(seam extracted, one impl)* | `RM-07` |
| Eval harness / regression suite | ✅ | ✅ | ✅ | ❌ | `RM-00` |
| SDKs | ✅ | ✅ | ✅ | ❌ | `RM-12` |
| Hosted option | ✅ | ✅ | ✅ | ❌ *(deliberate)* | — |
| Zero-terminal install | ❌ | ❌ | ❌ | ✅ **unique** | — |
| Runs with no API key / no cloud | 🟡 | ❌ | 🟡 | ✅ | — |
| Copyleft (forks stay open) | ❌ | ❌ | ❌ | ✅ | — |

**Reading the matrix:** we are competitive on *substrate* and *distribution UX*, and behind on
the entire **write path** (extraction, dedup, conflict, temporal) plus **evaluation**. That is
exactly the ordering the roadmap encodes.

---

## 6. Positioning

> **Resonance Memory is the memory layer that costs nothing, sends nothing, and remembers
> like a mind instead of a filing cabinet.**

Three claims we can defend, and should lead with:

1. **$0 forever, graph included.** Everything Mem0 gates behind $249 is in the free download.
2. **Nothing leaves the machine.** Not a privacy policy — an architecture. No API key exists to leak.
3. **Association, not just retrieval.** The Hebbian field is genuinely not in any competitor.
   Memories reinforce each other through use; recall surfaces a *neighborhood*, not a list.

Three claims we must **not** make until earned:
- ❌ "Beats Mem0 on LOCOMO" — not until `RM-00` lands and the number is independently reproducible.
- ❌ "Handles contradictions" — not until `RM-03` ships *with* its eval.
- ❌ "Production ready at scale" — JSONL rewrites the whole file on every recall (see `RM-07`).

---

## Sources

- [Mem0 2026 token optimization playbook](https://mem0.ai/blog/the-2026-token-optimization-playbook-cut-ai-agent-memory-costs-3%E2%80%934x)
- [Mem0 state of AI agent memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Mem0 alternatives + pricing (Atlan)](https://atlan.com/know/mem0-alternatives/)
- [Zep vs Mem0 (Atlan)](https://atlan.com/know/zep-vs-mem0/)
- [Zep: temporal knowledge graph](https://www.getzep.com/ai-agents/temporal-knowledge-graph/)
- [Zep paper (arXiv 2501.13956)](https://arxiv.org/pdf/2501.13956)
- [Graphiti on Neo4j blog](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Zep: "Is Mem0 really SOTA?"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- [Corrected LoCoMo claim (getzep/zep-papers#5)](https://github.com/getzep/zep-papers/issues/5)
- [Letta memory blocks](https://www.letta.com/blog/memory-blocks/)
- [Letta agent memory](https://www.letta.com/blog/agent-memory/)
- [Mem0 vs Letta (Vectorize)](https://vectorize.io/articles/mem0-vs-letta)
- [The consolidation problem in agent memory (Hindsight)](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation)
- [Supersede: diagnosing the memory-update gap (arXiv 2606.27472)](https://arxiv.org/html/2606.27472v1)
- [LongMemEval-V2 (arXiv 2605.12493)](https://arxiv.org/pdf/2605.12493)
- [Governed shared memory for multi-agent LLM systems (arXiv 2606.24535)](https://arxiv.org/pdf/2606.24535)
- [Hybrid search: BM25, vector & reranking reference 2026](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)
- [Understanding reciprocal rank fusion](https://glaforge.dev/posts/2026/02/10/advanced-rag-understanding-reciprocal-rank-fusion-in-hybrid-search/)
- [Memory MCP servers directory](https://mcpservers.org/category/memory)
