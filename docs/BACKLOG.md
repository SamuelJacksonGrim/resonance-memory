# Resonance Memory — backlog

This file owns item scope, remaining work and acceptance. [ROADMAP](ROADMAP.md) owns route
and phase-level status; [ARCHITECTURE](ARCHITECTURE.md) owns current mechanisms/defaults;
[phase specs](phases/) and [proposals](proposed/) own build contracts and designs.

**Effort:** S = hours · M = a day or two · L = a week · XL = multi-week.
**Status:** `todo` · `partial` · `done` · `deferred`. A completed scoped item can retain
explicitly named follow-up work without claiming every related problem is solved.

The four-verb contract and [I1–I9](ARCHITECTURE.md#2-design-invariants-the-shape-is-load-bearing)
apply throughout. CLI modes, hooks and panel actions are not additional MCP verbs.

The 0.3–0.5 product tracks use no new RM IDs. Their compact status/guide index is
[ROADMAP: shipped product tracks](ROADMAP.md#shipped-product-tracks), with release chronology
in [CHANGELOG](../CHANGELOG.md).

## Measurement

### `RM-00` — Evaluation harness and corpora · **XL** · ✅ `done`

Shipped in [0.2.0](../CHANGELOG.md#020---2026-09-10). The offline, seeded/cached instrument,
golden gate, field-off/on constraint checks and repeated-turn cases exist. It includes the
contradiction corpus required by the original ≥50-case acceptance. Feature-specific corpora
and reporting metrics travel with their features. Current inventory and reproduction commands:
[eval guide](../eval/README.md). The activation pool's design lives in
[Lane A](research/lanes/lane-a-testpool-design.md).

**Acceptance:** a deliberately broken rank change is caught by the gate; fixtures and cached
embeddings reproduce results without a network or key. The harness latency target is <60 s
on a laptop; run it to check the current result rather than quoting a test count here.
`--json` output for the golden runner remains open. Fusion-specific metric work is Phase 2.5.

## Write path

### `RM-04` — Temporal metadata · **S** · ✅ `done`

- [x] Temporal validity, confirmation, supersession-chain, revision and review fields, with legacy normalization.
- [x] Exact restatement confirms rather than duplicates.
- [x] Current recall excludes superseded rows; historical recall labels them.
- [x] Supersession writes are atomic; the panel distinguishes superseded memories.

**Acceptance:** old records normalize without losing history; current and historical queries
use the appropriate validity set. Schema/mechanism: [ARCHITECTURE §8](ARCHITECTURE.md#8-the-temporal-model-bi-temporal-after-graphiti).
Design: [0002](proposed/0002-temporal-supersession.md). Detection is RM-03.

### `RM-01` — Write-side extraction and summarization · **L** · ✅ `done`

- [x] Measurement seed and extraction precision/recall scoring.
- [x] Always-on deterministic normalization, filler removal and conservative fact splitting.
- [x] Always-on secret-shape refusal, not redaction, with prose/digit controls.
- [x] Opt-in ADD-only local LLM extraction or MCP sampling, capability detection and panel toggle.
- [x] Extraction failure degrades to the deterministic path rather than failing the save.

**Acceptance:** Tier 2 off gives extraction precision ≥0.9 on the messy corpus; Tier 2 improves
recall@5 without lowering precision; disabled Tier 2 leaves write p95 unchanged. The scoped
acceptance is met. The additional Tier 2 anti-flood precision floor was missed on the recorded
live run; it is not silently treated as passed. Evidence and limits: [RM-01 results](../eval/RESULTS.md#rm-01c--tier-2-opt-in-llm-extraction-messy-hard).
Current tiers: [ARCHITECTURE save flow](ARCHITECTURE.md#store-save).
Design: [0001](proposed/0001-write-pipeline.md).

### `RM-02` — Deduplication and merge · **M** · ✅ `done`

- [x] Measurement baseline and configurable, measured restatement/merge bands at save.
- [x] Restatement confirms; merge retains original text/metadata and a recoverable supersession link.
- [x] `--dedup-existing` uses the same decision, with dry-run default and explicit apply.
- [x] Backfill is idempotent; vectorless rows are not merged blindly.

**Acceptance:** duplicate rate drops ≥50% on the duplicates corpus with no recall@5 regression.
Met for both save-time and backfill paths; [results](../eval/RESULTS.md) own the A/B numbers.
The current bands/algorithm live in [ARCHITECTURE](ARCHITECTURE.md#store-save).

### `RM-03` — Contradiction and supersession · **L** · ✅ `done` for v2 detection

The cue-gated v1 and silent-slot v2 detection ship in [0.2.0](../CHANGELOG.md#020---2026-09-10).

- [x] Detect cue-gated corrections and silent exclusive-slot, polarity and numeric/date swaps.
- [x] Retire the old row by validity/successor links; keep both rows and history.
- [x] Recall current facts unless history is requested.
- [x] Keep ambiguous/hypothetical additions and mark review rather than guessing destructively.
- [ ] Optional Tier 2 adjudication; retain opt-in behavior and an explicit live measurement.

**Acceptance:** staleness drops ≥70% on the contradiction corpus, with zero wrongly invalidated
still-true facts. The detector meets the staleness target and the guard/ambiguous keep-set bar.
The broader corpus retains a preexisting RM-02 same-name merge error, plus named paraphrase/blob
misses; the global hard-zero aspiration is not claimed met. [RM-03 v2 results](../eval/RESULTS.md#rm-03-v2--silent-exclusive-slot-supersession)
own the evidence/residuals. Mechanism: [ARCHITECTURE](ARCHITECTURE.md#store-save).
Design: [0002](proposed/0002-temporal-supersession.md).

## Retrieval and shape

### `RM-21` — Edge substrate unification · **L** · ✅ `done` — roadmap Phase 0

One persistent two-signal EdgeStore, migration, save-time binding, wall-clock decay,
materialize-on-mutation, request-ID idempotency, soft pruning/reactivation and the threat
sketch are shipped. Ledger remains a test reference, not the live Hebbian path.

**Acceptance:** golden holds across substeps; frozen-clock reads do not advance edge decay;
migration preserves learned state; stale semantic versions are detectable; failure degrades
to plain recall. The full transition/build/test contract lives in
[Phase 0](phases/phase-0-edge-substrate.md). Supersession-edge inheritance remains Phase 7.
Poisoning implementation remains RM-16; record-importance decay remains RM-08.

### `RM-05` — Hybrid retrieval · **M** · `todo`

- [ ] First-class sparse/BM25 retrieval arm in the MCP store, distinct from fallback search.
- [ ] FTS5 / `searchSparse` support for that arm.
- [ ] `searchDense` retrieval interface/optimization, justified by scale measurements.
- [ ] RRF fusion and optional graph arm, initially behind the proposed hybrid flag and panel toggle.
- [ ] Golden/reporting-metric A/B, with a published positive or negative verdict.
- [ ] Field graph scaling (W-03): measure and choose a replacement for per-recall all-pairs kNN;
      FTS5 or a dense-search method alone is not proof this cost is removed.

FTS5 and `searchDense` are retrieval follow-up, not unfinished RM-07 storage acceptance.
Existing folder BM25 and exploratory activation combiners do not complete these items.

**Acceptance:** RRF improves recall@5 and MRR over cosine, or it is rejected with a recorded
negative result. Default promotion must satisfy the authoritative
[Phase 2 gate](phases/phase-2-retrieval-dynamics.md#fusion-promotion); completed RM-21 is not
a substitute for Phase 2.3 competition and 2.4 normalization. Design: [0003](proposed/0003-hybrid-retrieval.md).

### `RM-08` — Soft constraints, record decay and pruning · **M** · `todo`

- [x] Measure existing constraint rescue/learning with field off and on; [field experiments](../eval/RESULTS.md#rm-00-field-experiment-2--instrumentation-first-roc--tbr-split) record it.
- [ ] First-class soft-constraint kind, beyond the current server-derived constraint typing.
- [ ] Conditional cold-start constraint binding, two-hop rescue and reserved-slot work, only if measured necessary.
- [ ] Reassess the [0006 domain-probe proposal](proposed/0006-constraints-decay-pruning.md) against the shipped dynamic path before building it.
- [ ] Record-retention decay and panel-reviewed pruning; constraint/pinned records never auto-prune.

**Decision required:** the older access-refreshed importance proposal conflicts with I2b's
prohibition on access-frequency inputs to decay/pruning. Resolve a compliant retention signal
before implementation; do not change the invariant implicitly. Record retention is a different
object from shipped learned-edge decay.

**Acceptance:** constraints surface in ≥90% of topically related recalls, reported field off/on;
no unreviewed deletions. Current mechanism/defaults: [ARCHITECTURE §7](ARCHITECTURE.md#7-the-associative-substrate--where-were-different).

### `RM-09` — Neighborhood and Hebbian tuning · **M** · `todo` for further tuning

RM-21 unification is complete. The live discovery path already has node-max-normalized readout,
cosine-gated reinforcement and entity/polarity guards; [ARCHITECTURE §7](ARCHITECTURE.md#7-the-associative-substrate--where-were-different)
owns the current formulas. [Research](research/) owns exploratory combiner outcomes.

- [ ] Further measured sweeps of neighborhood, gate, hop, decay and bonus parameters.
- [ ] Evaluate directional association and additional edge types/visualization.
- [ ] Competition/total-neighborhood normalization beyond shipped per-edge/readout behavior.
- [ ] Preserve discovery-only default behavior; any rank promotion goes through the Phase 2 gate.

**Acceptance:** multi-hop association improves without direct-recall regression. Scope/tests:
[Phase 2](phases/phase-2-retrieval-dynamics.md).

## Scope and scale

### `RM-07` — Store abstraction and SQLite backend · **L** · ✅ `done`

- [x] Store seam, SQLite backend and both-backend conformance/golden parity.
- [x] Streaming JSONL migration, recovery behavior and default-backend switch.
- [x] Sovereignty export and panel export, available before the default switch.
- [x] Edges and request-ID persistence in the database; JSONL adapter remains supported.

**Acceptance:** 100k memories, field-off recall p95 <100 ms, no full-file rewrite on the default
backend, and golden scorecard parity. The dated S1 product measurements and parity evidence are
in [eval results](../eval/RESULTS.md); run [developer checks](../DEVELOPERS.md#checks) for current results.
Current backend/migration behavior: [ARCHITECTURE §6](ARCHITECTURE.md#6-storage-and-the-sidecars).
Designs: [0005](proposed/0005-store-abstraction.md), [0010](proposed/0010-sqlite-backend.md).
FTS5, `searchDense` and field graph scaling belong to open RM-05 work.

### `RM-06` — Multi-user/agent/session scoping · **L** · `todo`

- [ ] Scope, agent, session and session/long-term tier fields.
- [ ] Resolve identity from client/config, never a model-supplied namespace.
- [ ] Default reads stay in long-term plus current session; explicit config for cross-scope reads.
- [ ] Promotion of recurring session memory, session expiry and panel filtering.

**Acceptance:** agent A cannot recall agent B's memories; session expiry leaves long-term memory intact.

### `RM-10` — Consolidation · **M** · `todo`

**Trigger decision required before implementation:** the earlier backlog proposes a background
pass on panel idle, while [Phase 4](phases/phase-4-consolidation.md) specifies event-driven/lazy
consolidation with no daemon. These designs disagree; neither trigger is selected here.

- [ ] Choose the trigger and reconcile the phase contract before building.
- [ ] Evaluate merge/conflict sweeps, retention and recurring-session promotion off the recall hot path.
- [ ] Cancellable work, no overlap with active recall, panel account of changes and undo.

**Acceptance:** a store drifted over 500 simulated updates measurably re-coheres (staleness and
duplicate rates fall) without user-visible latency. The RM-15 control instrument is not a
consolidation treatment. [0011](proposed/0011-dream-consolidation.md) records the expanded design.

## Reach

### `RM-11` — Cross-platform builds and signing · **M** · 🟡 `partial`

- [x] Native Windows/Linux/macOS SEA builds, smoke checks and release artifacts/checksums.
- [x] Default-path relocation, BUG-004.
- [ ] Code signing / notarization; BUG-005 remains open.

Build procedure and platform limits: [BUILDING](guides/BUILDING.md). Path behavior:
[ARCHITECTURE storage](ARCHITECTURE.md#6-storage-and-the-sidecars).

### `RM-12` — SDKs and documented local API · **L** · `todo`

- [x] Panel Host/Origin/token protection, W-02.
- [ ] Version/document a stable local HTTP API and specify its client request requirements.
- [ ] Thin Python and TypeScript clients against that contract.

Panel routes are internal until that API is established. Current protection belongs to
[ARCHITECTURE configuration](ARCHITECTURE.md#11-configuration-surface), defect evidence to [BUGS](BUGS.md).

### `RM-13` — Failure-mode capture · **M** · `todo`

- [ ] Opt-in local failure bundle: query, redacted/hashed shapes and metrics; raw memory only by explicit opt-in.
- [ ] A bundle becomes a runnable eval fixture without a phone-home path.

### `RM-14` — Hosted / enterprise · `deferred`

A hosted offering, if pursued, is a separately named product. Local scoping and provenance
requirements stay RM-06/RM-16; a hosted product must not hollow out the local one.

## Cross-cutting

### `RM-15` — Longitudinal coherence soak · **M** · 🟡 `partial`

- [x] Deterministic evolving-persona control log and runner for 1,000 events.
- [x] Checkpoints at 100/250/500/1000 and a recorded control curve for staleness, duplicates,
      retention, storage and false merges; [soak guide](../eval/soak/README.md) owns the dated baseline.
- [ ] Complete coherence evidence for history integrity and graph fragmentation across checkpoints.
- [ ] Satisfy the flat-staleness acceptance; treatment arms/generalization remain unimplemented.

**Acceptance:** staleness stays flat from update 100 to 1000. The 2026-09-06 control baseline
has an early increase, so the instrument exists but that literal acceptance is not met.
`npm run soak` reproduces the instrument; its output is separate from the golden gate.

### `RM-16` — Poisoning / injection defense · **M** · `todo` for broader defense

The [0009 threat sketch](proposed/0009-edge-threat-model.md) defines the carry-forward threat
requirements for the [Phase 2 gate](phases/phase-2-retrieval-dynamics.md#fusion-promotion).
The implemented import barrier is credited under RM-17; it does not complete this defense.

- [ ] Preserve record/source provenance and prevent untrusted tool text becoming an asserted user preference.
- [ ] Define provenance-aware retrieval/panel filtering under I2 and the promotion gate.
- [ ] Carry source trust to edge reinforcement, not just record labels; bound untrusted influence.
- [x] Explicit edge-restore opt-in and raw-sidecar refusal in RM-17.
- [ ] Evaluate planted export content/provenance beyond that format/opt-in barrier; a manifest is not authentication.
- [ ] Re-evaluate the save-time persist net before rank promotion.
- [ ] Test parasite/co-recall, planted associations and constraint-cue attacks at the edge level.

**Acceptance:** adversarial content does not become high-confidence durable preference or buy
rank authority. All carry-forward requirements in 0009 §7 hold before default rank promotion;
otherwise I9 remains the fallback. Broader record/source defense is open.

### `RM-17` — Export / import / backup · **S** · ✅ `done`

- [x] CLI and panel export with documented, lossless JSONL interchange.
- [x] Dry-run-first import; explicit apply/merge with duplicate/id collision handling.
- [x] Preserve ids, embeddings and history without passing restore through `save()`.
- [x] Preserve learned edges in export; restore only by explicit edge opt-in from an RM export,
      refuse raw sidecars, and require explicit replacement of existing destination edges.
- [x] Panel import uses the same engine and explicit confirmation.

**Acceptance:** export/import round trips preserve memory and learned associations when explicitly
requested, and leave memory accessible outside this executable. [ARCHITECTURE §6](ARCHITECTURE.md#6-storage-and-the-sidecars)
owns format and restore behavior; main regression tests cover the refusal paths.

### `RM-18` — Optional encryption at rest · **M** · `todo`

- [ ] Opt-in passphrase encryption for the working store, off by default.
- [ ] Specify backup/export behavior and inspectability tradeoffs. Default SQLite already needs
      SQLite tooling; text-editor inspection applies to the JSONL adapter/export, not the default `.db`.

### `RM-19` — Recall explainability · **S** · `todo`

- [ ] Panel explanation of cosine, discovery bonus/hop and any gated fusion rank.
- [ ] Make RM-05/RM-09 tuning inspectable without confusing discovery with primary ordering.

### `RM-20` — First-run quality · **S** · ✅ `done` as scoped

- [x] Empty-store starter prompt and connected-but-empty nudge.
- [x] First-run import route for an existing backup.
- [x] Copyable connection instructions for clients outside one-click wiring.
- [x] Unsigned first-run instructions in the user entry path.
- [x] Live data location shown in the panel; BUG-004 relocation is complete.

Signing is RM-11. Setup/use belongs to [README](../README.md) and [guides](guides/).

## Related

[[ROADMAP]] · [[ARCHITECTURE]] · [[BUGS]] · [[phase-0-edge-substrate]] · [[phase-2-retrieval-dynamics]] · [[0009-edge-threat-model]] · [[proposed/README]] · [[RESULTS]]
