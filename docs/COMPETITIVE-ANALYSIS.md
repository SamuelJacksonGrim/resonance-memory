# Competitive analysis — the AI memory layer market

**Market verification note — 2026-11-12:** vendor prices, features, licenses, benchmarks and
competitive absence/uniqueness claims below were last checked **2026-09-10** and **need a fresh
check before quoting**. They remain the dated September market snapshot; this documentation
pass does not verify or revise them.

RM capability status is maintained against the local architecture/backlog. Run the
[developer checks](../DEVELOPERS.md#checks) for current tests and golden results.

> **What moved in the market:** Mem0 retired the $79 Growth tier, restoring the
> $19 → $249 cliff, and **removed graph memory from the OSS SDK** (v3). Zep's $25
> Flex is gone; self-serve Flex is **$125/month** billed monthly (annual ~$104).
> Letta's public pricing now lands on Letta Code. Local-first MCP memory servers
> proliferated; "local" is still not a differentiator.

The goal of this document is not to cheer. It is to answer three questions honestly:

1. What do the paid incumbents actually do that we don't?
2. Where is their moat real, and where is it just funding and marketing?
3. What is the shortest credible path from where Resonance Memory is today to being
   the thing a person picks *instead of* paying $249/mo?

---

## 1. The field

| System | License | Hosted price | Local/self-host | Core idea |
|---|---|---|---|---|
| **Mem0** | Apache 2.0 core | Hobby free (10K adds / **1K retrievals**) → **$19** Starter → **$249** Pro | Yes, but **OSS graph was deleted in v3** — graph is Platform | LLM extracts facts on write; vector + KV; graph/Dream gated on the hosted Pro page |
| **Zep / Graphiti** | Graphiti OSS (Apache 2.0) | Free 10K credits → **$125/mo** Flex (graph at every paid tier) → $375 Flex Plus → enterprise | Graphiti yes (needs a graph DB); **Zep Community Edition deprecated**; full Zep self-host is Enterprise BYOC | Bi-temporal knowledge graph, edge invalidation |
| **Letta (MemGPT)** | Apache 2.0 | Free (3 agents, BYOK) → **$20** Pro → $100 Max Lite / $200 Max; API $20 + usage | Yes (Docker / local) | Agent *self-edits* memory blocks; sleep-time compute; product gravity shifted to **Letta Code** |
| **MemOS** | Apache 2.0 | Cloud + OSS | Yes | "Memory OS", hybrid retrieval, vendor LoCoMo / LongMemEval numbers |
| **Supermemory / Cognee / Hindsight** | Mixed OSS | Varies; Hindsight ships features at every tier | Yes | Consolidation-focused, graph retrieval |
| **OMEGA / VEKTOR / Mnemosyne / memory-mcp** | OSS | Free (some have a Pro) | Yes, local-first | SQLite + embeddings + FTS5, MCP-native, no cloud |
| **Resonance Memory** | **AGPL-3.0** (or paid commercial) | **$0** | Local-only by design | kNN associative field + **Hebbian co-activation** + measured discovery-not-ordering boundary |

### What the incumbents actually give you

**Mem0** — the market leader by mindshare (~63k GitHub stars on
[mem0.ai/pricing](https://mem0.ai/pricing) as of 2026-09-10; third-party listings
around 65k). Its defining feature is still *automatic extraction*: you feed it raw
conversation, an LLM pass pulls out structured facts, preferences and relationships,
and it stores those instead of transcripts. In 2026 they moved to **single-pass
ADD-only extraction** — one LLM call to extract, with conflict resolution deferred
to retrieval time or handled async — which cut write-time LLM calls 60–70%. That is
a direct admission that *write-time conflict resolution is the expensive, hard
part*, and it is worth internalizing before we build ours (we already did, for
Tier 2).

The hosted bill is metered **separately on adds and retrievals**, not on stored
memories and not on seats. The free tier's 10,000 adds look generous; the number
that actually gates a chat agent is **1,000 retrievals/month**. Starter ($19) is
50,000 adds / 5,000 retrievals. Pro ($249) is 500,000 / 50,000 plus unlimited
projects, analytics, **Dream** (idle consolidation), and — on the pricing table —
**Graph memory (entity linking)**. The $79 Growth tier that briefly sat between
Starter and Pro was **retired in July 2026**, restoring a 13× jump.

Graph is no longer a single fact. Mem0's own docs now split it: entity extraction,
linking, and the retrieval boost are **all plans, automatic**; the interactive
**Graph view** is Pro/Enterprise. The pricing page still lists "Graph memory
(entity linking)" as a Pro row. Treat the contradiction as a contradiction — do
not launder either page into the other. What is not in dispute: the **open-source
SDK deleted graph memory in v3** (~4,000 lines of Neo4j / Memgraph / Kuzu /
Apache AGE / Neptune drivers). Self-host OSS is vector + KV. Graph is a Platform
feature.

**Zep/Graphiti** — the technically deepest. A **bi-temporal** knowledge graph:
every fact carries both *valid time* (when it was true in the world) and
*ingestion/transaction time* (when the system learned it). When a new fact
contradicts an old one over an overlapping window, Graphiti **invalidates rather
than deletes** — it sets the old edge's `t_invalid` to the new edge's `t_valid`,
producing a non-overlapping validity chain and preserving history. This is still
the single most-copyable good idea in the market and it does **not** require a
graph database to implement (see `proposed/0002`). We copied the *shape*; RM-03 v2
is that shape on a SQLite/JSONL store.

The commercial product moved upmarket. The old **$25/month Flex** (20,000 credits)
is gone. As of 2026-09-10, [getzep.com/pricing](https://www.getzep.com/pricing)
lists Flex at **$125/month** billed monthly (50,000 credits, then $25 / 10,000;
annual billing saves 17% → $1,250/year ≈ $104/mo) and Flex Plus at **$375/month**.
Retrieval, storage, and users are unmetered; you pay for Episode ingest (1 credit
per 350 bytes). Graph memory is on every paid tier. Free is 10,000 credits/month,
2 projects. **Zep Community Edition is deprecated** (April 2025); the OSS path is
Graphiti (~31k stars, Apache 2.0), which needs Neo4j 5.26+ / FalkorDB / Amazon
Neptune (Kuzu is deprecated because upstream is unmaintained) plus an LLM key by
default. Full Zep with orchestration, dashboard, and SLAs is cloud, or Enterprise
BYOC in your VPC. Self-hosting the *product* is no longer a community option.

**Letta** — memory as an OS. Three tiers (core / recall / archival) and the agent
edits its own memory via tool calls. **Sleep-time compute** is still their
sharpest idea: agents reflect on history during idle periods and consolidate
memories asynchronously. We can steal the *shape* of this (idle-time
consolidation, `RM-10`) without the agent-framework baggage. The commercial
center of gravity has shifted: `letta.com/pricing` now redirects to
[Letta Code pricing](https://docs.letta.com/letta-code/pricing). Personal Pro is
**$20/month** (up to 20 stateful agents, Letta Auto quota); Max Lite $100 / Max
$200 appeared on the marketing page; the API plan is $20/month plus $0.10 per
active agent per month and $0.00015/sec of server-side tool execution. OSS
self-host remains Apache 2.0. If you wanted a stable memory-as-a-service API for
something shipping this quarter, Letta is the riskiest of the three incumbents;
if you wanted a stateful coding agent with real memory, it is the most
interesting.

**MemOS** (MemTensor) — Apache 2.0, ~11.3k stars, a "memory operating system"
with hybrid retrieval, multi-modal cubes, and a dream/consolidation loop. Vendor
numbers (PyPI / README, 2026-07): LoCoMo **88.83**, LongMemEval **89.20**. Same
caveat as every other vendor number in §4.

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
   eval harness (`proposed/0007`) had to land **before** the clever features, not after — and
   why it did.

## 3. Where the moat is *not* real

1. **Graph memory is not worth $249/mo.** Mem0's pricing table still gates "Graph memory
   (entity linking)" and Dream to Pro — a 13× jump from the $19 Starter, and the $79
   Growth step that briefly plugged that gap is gone. Community frustration on that
   cliff is not theoretical. Zep includes the temporal graph at Flex, but Flex is no
   longer $25: it is **$125/month**. There is a large, visibly annoyed population
   between $0 and those two price points. **That is still our wedge** — it got wider
   on Zep's side, not narrower. The honest fine print on Mem0 graph: hosted docs now
   say the retrieval boost is all-plans and the *view* is Pro; OSS graph is simply
   gone. Either way, you do not get a self-hosted temporal graph from `pip install
   mem0ai` anymore.
2. **Token costs are a real, documented pain.** Mem0 GitHub issue
   [#2066](https://github.com/mem0ai/mem0/issues/2066) (Dec 2024, later closed stale)
   documents graph-mode costs 15× higher than generation, with 62 photo descriptions
   taking over an hour to save. Mem0's 2026 algorithm is a response to that class of
   problem (ADD-only, ~7K tokens/query vs 25K+ full-context on their own research
   page). Every LLM call on the write path is still a cost, a latency spike, and a
   privacy leak. Our embed-once-locally design has a **structural** advantage here
   that no amount of their funding erases. Independent serving-cost work
   (arXiv 2608.11879) found a memory system's bill cannot be predicted from
   conversation length alone — internal write-path behavior dominates.
3. **Self-hosting is being quietly de-prioritized.** Zep's community edition is
   deprecated; Graphiti is a library you operate with a graph DB, not the product.
   Mem0 OSS lost graph. Letta still self-hosts, but the marketed product is Letta
   Code. The hosted tier is where the money is, so the local path rots. We are
   local-*only*; ours can't rot.
4. **"Local-first" alone is not a differentiator anymore.** OMEGA (SQLite + ONNX,
   vendor 95.4% LongMemEval — self-reported, task-averaged; raw 466/500 = 93.2%),
   VEKTOR/Slipstream (50+ MCP tools, BM25+vector RRF), a small zoo of projects named
   Mnemosyne, and sqlite-memory-mcp all do local SQLite + embeddings + MCP. We must
   **not** market on "local" alone — it's table stakes now. Our differentiator has
   to be the associative substrate, the four-verb interface a small model cannot
   misuse, the measured discovery-not-ordering boundary, and the zero-terminal UX.

## 4. The benchmark situation is a mess — use it

LOCOMO is the headline benchmark and its numbers are *actively disputed*:

- Zep published **84%**.
- Mem0 responded that Zep included adversarial categories the spec excludes → **58.44%**.
- Zep rebutted that Mem0 misconfigured Zep → corrected **75.14%**, ~10% over Mem0's best.
- Mem0's 2026 algorithm claims **92.5 LoCoMo / 94.4 LongMemEval** (managed Platform,
  top_200, their judge; they say OSS users should expect "directionally similar"
  gains, not identical numbers).
- MemOS claims **88.83 LoCoMo / 89.20 LongMemEval**.
- OMEGA claims **95.4%** LongMemEval (task-averaged; GPT-4.1 judge; Feb 2026).
- Zep has also published **94.7%** LoCoMo in later 2026 marketing, under a different
  model/setup than the 2025 paper.

Independent observers advise treating *any* single vendor number with caution, and
the 2026 reproductions justify that:

- [Maximem, May 2026](https://www.maximem.ai/blog/state-of-ai-memory-2026-claimed-vs-observed):
  hosted Mem0 LongMemEval **57.5%** before the April algorithm, **73.8%** after —
  a real 16-point product lift, and still not 94.4%. They audited Mem0's own
  answer/judge prompts in `mem0ai/memory-benchmarks`.
- [Mnemoverse](https://mnemoverse.com/docs/technology/benchmarks/locomo): the same
  answers under four graders move Mem0 (conv-26 slice) from 0.66 to 0.26. Dakera:
  Mem0's 92.5% and Zep's 94.7% "use different models and evaluation setups — not
  directly comparable."
- Judge, slice (adversarial in or out), retrieval budget (top_50 vs top_200), and
  whether you score the Platform or the OSS SDK are enough to manufacture a
  leaderboard.

Two takeaways:

- **Do not enter the number war.** Publishing "Resonance scores X on LOCOMO" invites the same
  credibility spiral.
- **Do compete on reproducibility.** Ship the harness, the corpus, the seeds, and a one-command
  reproduce script. "Run it yourself in 30 seconds on your own machine" is a *better* claim
  than a number, and it's one the hosted vendors structurally cannot match — their eval needs
  their cloud. RM supplies offline main tests and a cached-embedding golden gate. The
  [developer checks](../DEVELOPERS.md#checks) print current results; [eval](../eval/README.md)
  owns the instrument and reproduction conditions.

Also note: **neither LOCOMO nor LongMemEval systematically tests contradictory memories**,
even though conflict resolution is where production systems rot ("memory poisoning"). The
`Supersede` paper (arXiv 2606.27472) exists specifically to diagnose this *memory-update gap*.
That's an under-served evaluation axis where we can lead rather than follow — and where
the [contradiction instrument and results](../eval/RESULTS.md#rm-03-measurement-seed--staleness_rate-false_supersession-50-contradiction-cases)
already live.

The associative field itself is not a leaderboard claim. RM-00's honest verdict: the
field **does not beat cosine in general**; it earns its keep on **typed-constraint
rescue**, with a retained polysemy failure. [Eval results](../eval/RESULTS.md) own that
measurement and the scorecard. We do not market "learns which
memories belong together" past what that scorecard shows.

---

## 5. Capability gap matrix

Competitor columns preserve the **September 2026 market snapshot** above. The RM column
summarizes scoped shipped work; [BACKLOG](BACKLOG.md) owns acceptance and residual work.
✅ have it · 🟡 partial · ❌ absent.

| Capability | Mem0 | Zep | Letta | **Resonance (today)** | Backlog item |
|---|:--:|:--:|:--:|:--:|---|
| Semantic recall | ✅ | ✅ | ✅ | ✅ | — |
| Embed-once-on-save | ✅ | ✅ | ✅ | ✅ | — |
| Automatic fact extraction on write | ✅ | ✅ | ✅ | ✅ *(Tier 0/1 always-on; Tier 2 LLM opt-in, off by default)* | `RM-01` ✅ |
| Deduplication | ✅ | ✅ | 🟡 | ✅ *(cosine-banded at save + `--dedup-existing` backfill)* | `RM-02` ✅ |
| Contradiction / supersession | 🟡 | ✅ | 🟡 | ✅ *(scoped v2 detection; residuals in BACKLOG RM-03)* | `RM-03` v2 ✅ |
| Temporal metadata (valid-from/to) | 🟡 | ✅ | ❌ | ✅ | `RM-04` ✅ |
| **Entity-id + polarity disambiguation** | 🟡 *(Platform entity linking; OSS graph gone)* | ✅ | ❌ | ✅ *(server-assigned; Related: + Hebbian only — never primary cosine)* | — |
| Hybrid retrieval (semantic+keyword) | ✅ | ✅ | 🟡 | 🟡 *(keyword only as fallback)* | `RM-05` |
| Graph retrieval | 💰 Pro *view*; retrieval-boost docs say all-plans; **OSS ❌** | ✅ | ❌ | ✅ **free** | — |
| **Hebbian / co-activation reshaping** | ❌ | ❌ | ❌ | ✅ **unique** | `RM-09` |
| **Discovery-not-ordering, behaviorally validated** | ❌ | ❌ | ❌ | ✅ **unique** *([scoped S2v2 evidence](research/s2v2/s2v2-result.md))* | — |
| Importance decay / pruning | 🟡 | ✅ | 🟡 | 🟡 *(retention signal only; edges have wall-clock half-life + soft prune)* | `RM-08` |
| Multi-user / agent scoping | ✅ | ✅ | ✅ | ❌ | `RM-06` |
| Session vs long-term separation | ✅ | ✅ | ✅ | ❌ | `RM-06` |
| Idle/sleep-time consolidation | 🟡 *(Dream @ Pro)* | ✅ | ✅ | ❌ | `RM-10` |
| Pluggable store backend | ✅ | ✅ | ✅ | ✅ *(SQLite default, JSONL pin / fail-open / export)* | `RM-07` ✅ |
| Lossless export / anti-lock-in | 🟡 | 🟡 | 🟡 | ✅ *(`--export` zip + `--export-jsonl` + `--import`; a competitor reads `memories.jsonl` without our exe)* | `RM-07` 2b + `RM-17` ✅ |
| Eval harness / regression suite | ✅ | ✅ | ✅ | ✅ *([run the checks](../DEVELOPERS.md#checks))* | `RM-00` ✅ |
| Provenance on records (poisoning defense) | 🟡 | 🟡 | 🟡 | 🟡 *(`source` field seeded; recall-weighting + filter open)* | `RM-16` |
| SDKs | ✅ | ✅ | ✅ | ❌ | `RM-12` |
| Hosted option | ✅ | ✅ | ✅ | ❌ *(deliberate)* | — |
| Zero-terminal install | ❌ | ❌ | ❌ | ✅ **unique** | — |
| Runs with no API key / no cloud | 🟡 | ❌ | 🟡 | ✅ | — |
| Copyleft (forks stay open) | ❌ | ❌ | ❌ | ✅ *(AGPL; commercial license available)* | — |

The remaining RM gaps are itemized in [BACKLOG](BACKLOG.md), including first-class hybrid
retrieval, scoping, consolidation and SDKs. ARCHITECTURE owns the [two runtime representations](ARCHITECTURE.md#1-runtime-overview)
and current defaults; [eval results](../eval/RESULTS.md) and [research](research/) own
measurement scope and residual failures. The [shipped product-track index](ROADMAP.md#shipped-product-tracks)
also covers the memory folder/cabinet/installer, Claude Code plugin and keyword fallback,
and auto-recall proxy/chunked folder recall. Competitor support for those later dimensions
is not assessed by the preserved September matrix.

---

## 6. Positioning

> **Resonance Memory is the memory layer that costs nothing, sends nothing, and remembers
> like a mind instead of a filing cabinet.**

RM positioning, subject to the dated market verification note:

1. **Free local memory, graph included.** The download includes semantic recall and
   associative discovery, shipped write-path features and lossless store export/import.
   [BACKLOG](BACKLOG.md) names the remaining capabilities; this is not a claim to include
   every feature in a paid vendor plan.
2. **Nothing leaves the machine.** Not a privacy policy — an architecture. No API key exists to leak.
3. **Association, not just retrieval.** The Hebbian field is genuinely not in any competitor.
   Memories reinforce each other through use; recall surfaces a *neighborhood*, not a list.
   The neighborhood is **discovery, not ordering** (I3/I9).
   [S2v2](research/s2v2/s2v2-result.md) supplies scoped behavioral evidence for one driver,
   corpus and injected-recall format; it is not a universal driver guarantee.
4. **Reproducible, not benchmarked.** The eval harness ships with offline checks and a
   cached-embedding golden gate; [DEVELOPERS](../DEVELOPERS.md#checks) owns the commands. "Verify our
   claims on your own machine" is a claim the hosted vendors structurally cannot match,
   and it sidesteps the LOCOMO number war entirely (§4).
5. **You can leave.** The working copy is SQLite for speed; the interchange format is
   the same JSONL RM already uses, lossless, as `memories.jsonl` inside a ZIP64 bundle
   (`--export`) or as a raw file (`--export-jsonl`). `--import` is the return trip
   (dry-run default; `--apply` writes; `--with-edges` opt-in). Copy the `.db` between
   devices (RM↔RM), or export and hand the jsonl to a competing provider. Hosted
   Mem0/Zep *are* the lock-in — your memory lives in their cloud so leaving costs a
   migration you don't control. Local-only is necessary but not sufficient (OMEGA et
   al. are local too); **export that a competitor can read without our exe** is the
   anti-hoarding claim, and it is a CLI + panel path on purpose (four verbs stay four
   — a model that can dump the store is an exfil path). We do not sanitize the export.

Claims remain bounded by evidence: no cross-vendor leaderboard win is established here.
Unqualified contradiction handling or field-on production readiness at large scale exceeds
the named residuals and graph-scaling limits in [BACKLOG](BACKLOG.md), [BUGS](BUGS.md) and
[eval results](../eval/RESULTS.md). Default SQLite changes the storage limitation, not every
retrieval or long-term coherence question.

---

## Sources

Pricing and product pages were re-fetched 2026-09-10.

- [Mem0 pricing (official)](https://mem0.ai/pricing) — Hobby / $19 Starter / $249 Pro; graph + Dream on the Pro row; 62,590 GitHub stars on the page
- [Mem0 Graph Memory docs](https://docs.mem0.ai/platform/features/graph-memory) — retrieval boost "all plans"; Graph view Pro/Enterprise
- [Mem0 OSS v3: graph memory removed](https://github.com/mem0ai/mem0/commit/30469ae) — ~4,000 lines of graph drivers deleted; "Use the Platform API for graph features"
- [Mem0 2026 algorithm + LoCoMo 92.5 / LongMemEval 94.4 (vendor, Platform)](https://github.com/mem0ai/mem0)
- [Mem0 research page](https://mem0.ai/research)
- [Mem0 2026 token optimization playbook](https://mem0.ai/blog/the-2026-token-optimization-playbook-cut-ai-agent-memory-costs-3%E2%80%934x)
- [Mem0 state of AI agent memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Mem0 GitHub issue #2066 — graph-mode token cost](https://github.com/mem0ai/mem0/issues/2066)
- [Mem0 Growth tier retired (UsagePricing, Jul 2026)](https://www.usagepricing.com/blueprint/activity/mem0-2026-07-21-growth-tier-retired)
- [Mem0 alternatives + pricing (Atlan)](https://atlan.com/know/mem0-alternatives/)
- [Zep pricing (official)](https://www.getzep.com/pricing) — Flex $125/mo monthly / $1,250/yr; Flex Plus $375/mo; retrieval unmetered
- [Zep vs Mem0 (Atlan)](https://atlan.com/know/zep-vs-mem0/)
- [Zep: temporal knowledge graph](https://www.getzep.com/ai-agents/temporal-knowledge-graph/)
- [Zep paper (arXiv 2501.13956)](https://arxiv.org/pdf/2501.13956)
- [Graphiti README](https://github.com/getzep/graphiti) — CE deprecated; Neo4j/FalkorDB/Neptune; Kuzu deprecated
- [Zep: new direction for OSS (CE discontinued)](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/)
- [Graphiti on Neo4j blog](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Zep: "Is Mem0 really SOTA?"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- [Corrected LoCoMo claim (getzep/zep-papers#5)](https://github.com/getzep/zep-papers/issues/5)
- [Letta Code pricing (official; letta.com/pricing redirects here)](https://docs.letta.com/letta-code/pricing)
- [Letta memory blocks](https://www.letta.com/blog/memory-blocks/)
- [Letta agent memory](https://www.letta.com/blog/agent-memory/)
- [Letta sleep-time compute](https://www.letta.com/)
- [Mem0 vs Letta (Vectorize)](https://vectorize.io/articles/mem0-vs-letta)
- [MemOS (MemTensor) GitHub](https://github.com/MemTensor/MemOS) — ~11.3k stars, Apache 2.0
- [MemOS eval numbers (PyPI / README)](https://pypi.org/project/MemoryOS/)
- [The consolidation problem in agent memory (Hindsight)](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation)
- [Supersede: diagnosing the memory-update gap (arXiv 2606.27472)](https://arxiv.org/html/2606.27472v1)
- [LongMemEval-V2 (arXiv 2605.12493)](https://arxiv.org/pdf/2605.12493)
- [Maximem: claimed vs observed (Mem0 73.8% reproduced vs 94.4% claimed)](https://www.maximem.ai/blog/state-of-ai-memory-2026-claimed-vs-observed)
- [Mnemoverse LoCoMo — judge-sensitivity](https://mnemoverse.com/docs/technology/benchmarks/locomo)
- [Total Recall at What Cost? (arXiv 2608.11879)](https://arxiv.org/html/2608.11879)
- [OMEGA LongMemEval 95.4% (vendor, task-averaged)](https://omegamax.co/benchmarks)
- [Agent memory platforms compared (DevToolLab, Aug 2026)](https://devtoollab.com/blog/ai-agent-memory-platforms)
- [Hybrid search: BM25, vector & reranking reference 2026](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)
- [Understanding reciprocal rank fusion](https://glaforge.dev/posts/2026/02/10/advanced-rag-understanding-reciprocal-rank-fusion-in-hybrid-search/)
- [Memory MCP servers directory](https://mcpservers.org/category/memory)
- RM facts in this repo: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`eval/RESULTS.md`](../eval/RESULTS.md), [`phases/s2v2-result.md`](research/s2v2/s2v2-result.md), [`eval/substrate/entity-layer-results.md`](../eval/substrate/entity-layer-results.md)

---

## Related

[[ROADMAP]] · [[README]] · [[BACKLOG]] · [[LICENSING]] · [[ARCHITECTURE]] · [[s2v2-result]]
