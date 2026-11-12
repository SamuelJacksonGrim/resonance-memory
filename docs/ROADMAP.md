# Resonance Memory — Roadmap

This document owns route, sequencing and phase-level status. This repository's docs are
the current authority. The earlier cross-repo plan in
[`resonance-memory-stack`](https://github.com/SamuelJacksonGrim/resonance-memory-stack)
is retained for history.

| Question | Owner |
|---|---|
| Item scope, remaining work and acceptance | [BACKLOG](BACKLOG.md), RM-00 through RM-21 |
| Runtime paths, defaults and invariants | [ARCHITECTURE](ARCHITECTURE.md) |
| Defects and unresolved exposure | [BUGS](BUGS.md) |
| Buildable phase contracts and the fusion promotion gate | [Phase specs](phases/) |
| Measurements and reproducible checks | [Eval guide](../eval/README.md), [results](../eval/RESULTS.md), [research](research/) |
| Shipped chronology | [CHANGELOG](../CHANGELOG.md) |
| External landscape and positioning | [COMPETITIVE-ANALYSIS](COMPETITIVE-ANALYSIS.md) |
| Contributor workflow and build/run/check commands | [DEVELOPERS](../DEVELOPERS.md) |

If a status here disagrees with its owner's evidence or acceptance, fix this summary.
History: this roadmap combines the earlier product roadmap and `ROADMAP-IMPLEMENTATION.md`;
their prior versions remain in repository history.

## Direction and current route

Resonance Memory provides local persistent memory through an MCP store and a memory-folder
system. [ARCHITECTURE](ARCHITECTURE.md#1-runtime-overview) describes how the representations
and their entry points connect. The product aims to make local, reproducible memory useful
without a hosted account. Market comparisons belong in [COMPETITIVE-ANALYSIS](COMPETITIVE-ANALYSIS.md).

The evaluation harness, write-side extraction/dedup/supersession, unified edge substrate and
observable transient activation are shipped. Retrieval improvement remains gated. Staleness
and false-supersession reporting exist; residual failures and fusion-specific evaluation
remain work, as recorded in [Phase 2.5](phases/phase-2-retrieval-dynamics.md#retrieval-evaluation).

The research campaign records measured negative results for the tested activation-rank and
leftover-discovery mechanisms. They remain flag-off; those results do not complete the wider
Phase 2 gate. L1-share remains a normalization candidate. See the [research map](research/).

## Phase route

✅ done · 🟡 partial · ⬜ open · ⛔ gated · 🔀 migration · ⏸ shelved · 🛑 rescinded.
A measured negative result is a completed experiment, distinct from rescinding a mechanism.

| Phase | Focus | Status | Owning spec |
|---|---|---|---|
| 0 | Unified time and edge persistence 🔀 | ✅ exit met | [Phase 0](phases/phase-0-edge-substrate.md) |
| 1 | Transient activation | ✅ exit met, observable-only by default | [Phase 1](phases/phase-1-transient-activation.md) |
| 2 | Retrieval and association dynamics | 🟡 experiments/tracing exist; ⛔ promotion remains the next retrieval gate | [Phase 2](phases/phase-2-retrieval-dynamics.md) |
| 3 | Episodic working context, overlaps RM-06 | ⬜ | [Phase 3](phases/phase-3-episodic-context.md) |
| 4 | Consolidation | ⬜ mechanism; RM-15 control instrument exists | [Phase 4](phases/phase-4-consolidation.md) |
| 5 | Temporal and predictive work 🔀 | ⬜ | [Phase 5](phases/phase-5-temporal-predictive.md) |
| 6 | Rich structure | ⬜ | [Phase 6](phases/phase-6-rich-structure.md) |
| 7 | Reconsolidation, extends RM-04/RM-03 | 🟡 | [Phase 7](phases/phase-7-reconsolidation.md) |
| 8 | Cognitive integration | ⬜ | [Phase 8](phases/phase-8-cognitive-integration.md) |

Each phase owns its substeps, metrics, failure signatures and exit criteria. Do not rebuild
the completed Phase 0/1 substrate or the RM-00 instrument. Later mechanisms earn their place
through their named measurements; visibility in this route is not a commitment to build them.

All phases preserve the [I1–I9 invariants](ARCHITECTURE.md#2-design-invariants-the-shape-is-load-bearing),
including I2b and the named I4/I5 backfill exception. Definitions and implementation limits live
there, rather than in a second invariant table here.

Fusion promotion remains gated by the single authoritative
[Phase 2 promotion contract](phases/phase-2-retrieval-dynamics.md#fusion-promotion).
An exploratory flag or a shipped metric does not satisfy that contract.

## Item status

Acceptance and detailed scope live in [BACKLOG](BACKLOG.md). This is the route-level index.

| Items | Work | Status |
|---|---|---|
| RM-00 | Evaluation harness | ✅ |
| RM-01–RM-04 | Extraction, deduplication, supersession detection, temporal metadata | ✅ scoped work; residuals remain named |
| RM-21 | Unified edge substrate | ✅ |
| RM-05 | Hybrid retrieval, including FTS5 and `searchDense` | ⬜; ⛔ default promotion |
| RM-08 / RM-09 | Record retention/constraints and further association tuning | ⬜ remaining mechanisms; measured/shipped substeps credited in BACKLOG |
| RM-07 | Store seam and SQLite backend | ✅; later retrieval work belongs to RM-05 |
| RM-06 | Scope and session separation | ⬜ |
| RM-10 | Consolidation | ⬜; trigger decision required before implementation |
| RM-11 | Cross-platform builds, path migration, signing | 🟡; signing remains open |
| RM-12 | Stable local API and SDKs | ⬜; panel request protection is shipped |
| RM-13 | Opt-in local failure capture | ⬜ |
| RM-14 | Hosted/enterprise product | ⛔ deliberately deferred; a separate product if pursued |
| RM-15 | Longitudinal coherence soak | 🟡 control instrument and baseline shipped; acceptance remains open |
| RM-16 | Poisoning/injection defense | ⬜ broader defense; import barrier shipped; gates rank promotion |
| RM-17 | Export/import/backup | ✅ |
| RM-18 | Optional encryption | ⬜ |
| RM-19 | Recall explainability | ⬜ |
| RM-20 | First-run quality | ✅ as scoped; signing belongs to RM-11 |

## Shipped product tracks

These releases extend the product without adding RM IDs or MCP verbs. CHANGELOG owns what
shipped when; the linked guides own setup and use.

| Release | Shipped track | Guides |
|---|---|---|
| [0.3.0 — 2026-10-12](../CHANGELOG.md#030---2026-10-12) | Memory-folder system, cabinet, hooks, app installation/updates and panel setup | [Memory system](guides/MEMORY-SYSTEM.md), [cabinet](guides/CABINET.md), [auto-recall](guides/AUTO-RECALL.md), [README setup](../README.md) |
| [0.4.0 — 2026-10-18](../CHANGELOG.md#040---2026-10-18) | Claude Code plugin and folder keyword fallback | [Plugin](../plugin/README.md), [memory system](guides/MEMORY-SYSTEM.md) |
| [0.5.0 — 2026-11-01](../CHANGELOG.md#050---2026-11-01) | Local-model auto-recall proxy and chunked folder recall, including ranked milestones | [Auto-recall](guides/AUTO-RECALL.md), [plugin](../plugin/README.md), [memory system](guides/MEMORY-SYSTEM.md) |

## Open route decisions and risks

- Fusion must earn its promotion gate; a negative result keeps the experimental path off.
- Consolidation must demonstrate retrieval gain. RM-10's idle-pass trigger and Phase 4's
  event-driven trigger disagree; resolve that decision before building either.
- Edge inheritance across supersession remains a Phase 7 decision.
- Phases 5–8 require their own evaluation designs before implementation.
- Learned edge state is irreplaceable on either storage adapter. Migration behavior belongs
  to [ARCHITECTURE storage](ARCHITECTURE.md#6-storage-and-the-sidecars); backup scope is RM-17.
- Field-on graph scaling and concurrent-writer exposure remain on the [defect watch list](BUGS.md#watch-list--unresolved-defects-and-risks).

Run the checks in [DEVELOPERS](../DEVELOPERS.md#checks) for current scores and test results.
The near-term measure is reproducible evaluation without regressions, with residual failure
rates visible. A better experience at substantial memory scale is an aim, not a measured
comparison with a hosted service.

## Related

[[ARCHITECTURE]] · [[BACKLOG]] · [[BUGS]] · [[COMPETITIVE-ANALYSIS]] · [[proposed/README]] · [[DEVELOPERS]] · [[RESULTS]]
