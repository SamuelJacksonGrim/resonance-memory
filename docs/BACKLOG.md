# Resonance Memory — backlog

Itemized work, each with acceptance criteria you can actually check off. Phases and rationale
live in [`ROADMAP.md`](ROADMAP.md); deep designs in [`proposed/`](proposed/).

**Effort key:** S = hours · M = a day or two · L = a week · XL = multi-week
**Status:** `todo` · `in progress` · `done` · `deferred`

**Invariant reminder for every item below:** the public tool surface stays at **four verbs**
(`save_memory` / `recall_memory` / `edit_memory` / `delete_memory`). Everything here lands in
the substrate. If an item seems to need a fifth verb, the design is wrong.

---

## Phase 0 — Measurement

### `RM-00` — Evaluation harness and corpora · **XL** · ✅ `done` — core harness shipped & in use
> *Blocked everything; it now exists. Built `2026-07-29` (`cf70448`), and every field
> experiment since ran against it. Extended corpora/metrics travel with the features they test.*

Build `eval/` with seeded, offline, reproducible scoring.

- [x] Fixture corpora in `eval/corpora/*.jsonl`: `basic`, `contradictions`, `constraints`,
      `adversarial`, plus `field-noise` / `field-stress`. *(`duplicates` / `temporal` / `messy`
      land with the features they test — RM-02 / RM-04 / RM-01.)*
- [ ] ≥50 contradiction/update cases — **the axis LOCOMO and LongMemEval both under-test.**
      *(4 today; expand as RM-03 detection matures.)*
- [~] Metrics: `recall@k` shipped, plus the field-experiment **ROC / TBR** split.
      *(`staleness_rate`, `false_supersession`, `duplicate_rate`, `extraction_precision/recall`
      land with RM-01 / RM-02 / RM-03.)*
- [x] Constraint cases run with the field **off and on**; report both and the gap.
- [x] Repeated cases (`repeat` / `contains_by_turn`) keep one store across turns and report
      `first_hit_turn`, so a constraint that lands by turn 4 isn't scored as a miss.
- [x] `npm run eval` → scorecard table. *(`--json` for CI still pending.)*
- [x] Golden-set regression gate: any metric drop fails with a diff of which cases flipped.
- [x] Deterministic: fixed seeds, cached embeddings committed, **no network, no API key**.
- [x] Runs in <60s on a laptop.

**Acceptance:** a deliberately-broken change (e.g. rank by recency) is caught by the gate.

**Why it's XL and worth it:** this is the difference between *"it has a conflict handler"* and
*"the conflict handler rarely makes things worse."* See `proposed/0007`.

---

## Phase 1 — Write path

### `RM-04` — Temporal metadata · **S** · ✅ `done`

- [x] Add to the record: `valid_from`, `valid_to` (null = currently true), `last_confirmed`,
      `superseded_by`, `supersedes`, `revision`, `needs_review` — in `record.js`.
- [x] `normalize()` backfills all of them for legacy rows — **no migration script, no breaking
      change**. Covered by tests incl. the oldest `ts`-only shape.
- [x] `save_memory` sets `valid_from = now`, `last_confirmed = now`.
- [x] Re-saving an *identical* memory bumps `last_confirmed` instead of appending a duplicate.
      (Near-duplicate detection is still `RM-02`.)
- [x] `store.current()` excludes superseded; `active()` keeps history.
- [x] Recall answers from current facts; superseded surface only on explicitly historical
      queries and are labelled "no longer current".
- [x] Panel: superseded nodes dimmed in the 3D graph, counted separately, flagged on hover.
- [x] `supersedePatches()` + `updateMany()` land a supersession as one atomic write — ready
      for `RM-03` to call.

**Shipped alongside:** `record.js` (shared schema), `store.js` (storage seam extracted from
`server.js`), `test.js` (the test suite), and the fixes for `BUG-001` / `BUG-002` / `BUG-007`
(the last one introduced *by* the `BUG-002` fix) — see [`BUGS.md`](BUGS.md).

**Remaining for `RM-03`:** the *detection* logic that decides when to call `supersedePatches`.

Design: [`proposed/0002`](proposed/0002-temporal-supersession.md).

---

### `RM-01` — Write-side extraction and summarization · **L** · `todo`

A **tiered** pipeline. Cheap deterministic work first; the LLM pass is optional, local,
off by default, and never blocks the save.

- [ ] **Tier 0 (always on, no LLM):** trim, normalize whitespace, strip filler openers
      ("I think you should know that…"), drop imperatives aimed at the assistant, split
      multi-fact runs on `; ` / ` and also ` when both halves stand alone.
- [ ] **Tier 1 (always on):** secret/PII guard — refuse to store anything matching
      API-key/password/card shapes; return a clear refusal string.
- [ ] **Tier 2 (opt-in, local):** a single-pass extraction prompt against the *already
      configured local endpoint*, emitting `{facts: [...], skip: bool}`. One call, ADD-only,
      conflict resolution deferred to `RM-03` — mirroring Mem0's 2026 move that cut write-time
      LLM calls 60–70%.
- [ ] Tier 2 failures degrade silently to Tier 0/1. **A save never fails because extraction did.**
- [ ] Panel toggle, same live-config pattern as the associative field.

**Acceptance:** `extraction_precision ≥ 0.9` on `eval/messy` with Tier 2 off; Tier 2 improves
recall@5 without lowering precision; write latency p95 unchanged when Tier 2 off.

Design: [`proposed/0001`](proposed/0001-write-pipeline.md).

---

### `RM-02` — Deduplication and merge · **M** · `todo`

- [ ] Near-duplicate detection at save: cosine ≥ `DEDUP_HI` (~0.95) → treat as restatement.
- [ ] Restatement → bump `last_confirmed` + `access_count`, do **not** append.
- [ ] Band `DEDUP_LO..DEDUP_HI` (~0.88–0.95) → candidate merge; keep the longer/more specific
      text, union the metadata, link the loser with `superseded_by`.
- [ ] Thresholds are config, not constants, and are **tuned on `RM-00`, not vibes**.
- [ ] Backfill mode: `--dedup-existing` reports what it *would* merge before doing it.

**Acceptance:** `duplicate_rate` drops ≥50% on `eval/duplicates` with zero recall@5 regression.

---

### `RM-03` — Contradiction and supersession · **L** · `in progress` — v1 (cue-gated) shipped & ON

Follow Graphiti's proven shape: **invalidate, never delete.** v1 landed in `b143e2d`
(cue-gated, argmax-limited, on by default — worst case retires nothing).

- [x] On save, find high-similarity prior memories that are *not* duplicates (the
      "same subject, different value" band) via a contradiction check.
- [~] Detection: **explicit correction markers shipped** (cue-gated — "actually", "now",
      "no longer", "moved to"…, argmax-limited). *(negation-flip and numeric/date-change
      heuristics + optional Tier 2 LLM adjudication reusing the `RM-01` endpoint: still open.)*
- [x] On confirmed contradiction: set old `valid_to = new.valid_from`, `superseded_by = new.id`.
      **Both rows are kept** — non-overlapping validity chain, history preserved. *(first live
      writer of the bi-temporal model, via `supersedePatches()`.)*
- [x] Recall prefers current facts; superseded surface only when the query is explicitly
      historical ("used to", "before", "last year").
- [~] Ambiguous cases keep **both** and mark `needs_review` — never guess destructively.
      *(the conservative cue-gate covers this today; richer adjudication rides with the
      heuristics above.)*

**Acceptance:** `staleness_rate` drops ≥70% on `eval/contradictions`; **zero** cases where a
still-true fact is wrongly invalidated (this metric is a hard gate — a false supersession is
worse than a miss).

Design: [`proposed/0002`](proposed/0002-temporal-supersession.md).

---

## Phase 2 — Retrieval and shape

### `RM-21` — Edge substrate unification (one store, two signals) · **L** · `todo` — **roadmap Phase 0, current work** 🔀

> **Migration, not greenfield.** `field.js` (static kNN, rebuilt per recall, persists nothing)
> and `ledger.js` (Hebbian sidecar, persists, decays on a recall-count clock) merge into **one
> persistent edge store with two independent signals**: `semantic` (derived / recomputable) and
> `learned` (source-of-truth / irreplaceable). Building it fresh produces a *second* parallel
> associative system beside the one already running. Design: [`phases/phase-0`](phases/phase-0-edge-substrate.md).

- [ ] **PRE-0:** `BUG-008` fixed (✅, see [`BUGS.md`](BUGS.md)); **edge state-transition table
      ratified** — including the `superseded → inherited?` cell (deferred-decision, Phase 7).
- [ ] **0.0** One edge store, two signals (semantic derived, learned source-of-truth), typed
      provenance. `embedding_version` added to `record.js normalize()` (defaults legacy rows to
      `1`). **Migrate every `.assoc.json` edge in, one-way**: an old build reading a new sidecar
      fails cleanly, never silently drops edges. `field.js` constraint-rescue + mutual-kNN
      preserved through the move.
      *(store module `edges.js` is in; `embedding_version` + lossless one-way migration tested
      standalone. Constraint-rescue through the move is the remaining 0.0 item — recall wiring.)*
- [ ] **0.1** Save-time semantic edges (K≈5, cosine ~0.25, `hebbian.weight=0`) + edge timestamps.
      **Cost sweep:** record `save_latency` p50/p95/p99 at N=100/1k/10k/50k/100k; **pre-declare**
      the p95 budget that triggers `RM-07` *before* running it.
- [ ] **0.2** **Lazy wall-clock decay of the learned signal** (configurable half-life), replacing
      the recall-count clock (`ledger.tick`). `reinforceRecall` untouched — **this is where `I6`
      becomes true.** Not `RM-08` *importance* decay (different object, different law — see there).
- [ ] **0.3** Materialize-on-mutation + MCP request-ID idempotency. **Dedup record and weight
      change must commit atomically** (I5 makes each write durable, not the *pair* atomic — keep
      the dedup LRU inside the sidecar); if not atomic, order dedup-first. Relates to `W-04`.
- [ ] **0.4** Soft pruning — an edge whose learned signal hits zero survives if semantic still
      clears the gate. Mirror soft-delete + `vacuum()` (`I8`). **Reactivation is server-side only**
      (I1): revive in place, `created_at` preserved, `prune_count`/`first_pruned_at`/
      `last_reactivated_at` kept bounded; no `reactivate_edge()` tool.
- [ ] **0.5** Phase 0 tests — every transition-table row incl. the negatives (recall/edit write
      nothing to the edge store), *reading ≠ decay-clock advance*, *signals stay separate*,
      *stale-semantic self-heals by version compare*, *fails-open*.
- [ ] **0.6** Threat-model sketch (design only; `RM-16` implementation stays gated to Phase 2).

**Acceptance:** the `RM-00` golden set does **not** regress at any sub-phase boundary
(`npm run eval`); a store recalled N times under a frozen clock shows **zero** learned-edge decay;
migration is lossless and one-way; an `edit()` bumps `embedding_version` so incident edges fail the
`src_versions` match on next read **with no invalidation event run**; a corrupted edge store
degrades to plain cosine with no throw. Full criteria + mechanism in
[`phases/phase-0`](phases/phase-0-edge-substrate.md).

> **Ordering:** unify the substrate **before** tuning what sits on it (`RM-09`) or promoting a
> fusion arm (`RM-05`) — tuning against a substrate that is about to change tunes noise.

---

### `RM-05` — Hybrid retrieval · **M** · `todo`

> **⚠️ Touches the "ranking = cosine only" invariant.** Ships behind a flag, off by default;
> promoted only on an A/B win, and `DEVELOPERS.md` is amended in the same PR with the
> measurement that earned it. Unmeasured rank changes stay forbidden.

- [ ] Promote `keywordScore` from *fallback-only* to a **first-class retrieval arm** (BM25-ish).
- [ ] Fuse with **Reciprocal Rank Fusion**, `score = Σ 1/(k + rank_i)`, `k = 60` (standard;
      RRF fuses *ranks*, sidestepping the score-incompatibility that breaks weighted averaging).
- [ ] Optional third arm: graph neighborhood from `field.js` as a fusion input.
- [ ] Flag `RESONANCE_MEMORY_HYBRID` + panel toggle.
- [ ] A/B on the golden set; publish the delta either way.

**Acceptance:** RRF beats cosine-only on `recall@5` and `MRR`, **or** it is dropped and the
negative result is written down (a negative result is a real deliverable here).

**Promotion gate (all four, per `ROADMAP.md`).** Fusion becomes default *only* when: (1) an A/B
win on the `RM-00` golden set — **the metrics it needs (`MRR`, `staleness_rate`,
`false_supersession`, `duplicate_rate`) don't exist yet** and building them is a prerequisite
(they land with the features they test — see `RM-00`); (2) `RM-21` has landed (competition +
normalization must exist before learned weight enters rank, or ranking reinforces what already
ranked); (3) `RM-16` (poisoning defense) has landed; (4) `DEVELOPERS.md` + `CLAUDE.md` amended
in the same PR with the measurement that earned it. A failed gate keeps the flag off and writes
the negative result down.

Design: [`proposed/0003`](proposed/0003-hybrid-retrieval.md).

---

### `RM-08` — Soft constraints, decay, pruning · **M** · `todo`

- [ ] **Soft constraints** as a first-class memory kind (`kind: "constraint"`): "I'm diabetic —
      no sugary recipes."
- [ ] **Start by measuring what already works.** `field.js` + `ledger.js` *already* surface
      constraints by association and *already* strengthen that path with use — the Hebbian
      bonus is applied before the `minSim` gate, so a reinforced edge clears a gate that raw
      cosine misses. Run `constraint-learning` and the `field: true` / `false` pair
      (`proposed/0007`) before writing any new retrieval code.
- [ ] Two small fixes, if measurement shows they're needed: **seed constraint edges at write
      time** (cold start — the loop can't reinforce an edge that never fired once), and allow
      **2 hops for `kind: "constraint"`** (one hop can't carry dog→walk→diabetes→sugar).
- [ ] **Reserved slot** (~10 lines) for the cold-start case only.
- [ ] The domain-probe machinery in `proposed/0006` is **probably redundant** — it statically
      reimplements what the field does dynamically. Build only if the above doesn't close it.
- [ ] **Importance decay** (a *retention* signal on **records**): `importance *= exp(-λ·Δt)`,
      refreshed on access/confirm. Distinct from `RM-21`'s **learned-edge** decay (an
      *association* signal on **edges**) — different object, different law; never wire one into
      the other (see [`phases/phase-0`](phases/phase-0-edge-substrate.md) §5).
- [ ] Pruning proposals surfaced **in the panel for review** — never silent deletion.
- [ ] Never auto-prune anything with `kind: "constraint"` or a manual pin.

**Acceptance:** constraint memories appear in ≥90% of topically-related recalls in
`eval/constraints`, **reported with the field both off and on** — the gap is what the
associative field is worth, and it may show most of this item is already done. No unreviewed
deletions, ever.

---

### `RM-09` — Neighborhood and Hebbian tuning · **M** · `todo`

> Our actual differentiator. Tune it *after* Phase 1 (or you're tuning noise in a store full of
> duplicates and contradictions) **and after `RM-21`** — tune the *unified* substrate, not the
> two pre-unification mechanisms that are about to merge.

- [ ] Sweep `k`, `minSim`, hop count, decay rate, bonus cap against `RM-00`.
- [ ] Asymmetric edges (A→B ≠ B→A) — association is directional in minds.
- [ ] Edge *types*: semantic / co-activation / supersession / constraint-bridge, distinctly
      colored in the 3D panel.
- [ ] Revisit the bounded `cosine + 0.3·tanh(w)` blend now that there's a measurement to justify it.
- [ ] Guard the invariant: co-activation still **expands** the candidate set, never reorders
      the primary cosine result — unless `RM-05`'s A/B says otherwise, explicitly.

**Acceptance:** measured lift on multi-hop association cases with no regression on direct recall.

---

## Phase 3 — Scope and scale

### `RM-07` — Store abstraction + SQLite backend · **L** · `todo`
> **Update:** the *data-loss* half of this is **fixed** — writes are atomic and recall no
> longer rewrites the store (`BUG-001`/`BUG-002` in [`BUGS.md`](BUGS.md)). What remains is the
> *performance* half: `all()` still parses the whole store per call, and mutations still
> rewrite the file. Comfortable ceiling is **estimated** at ~10k memories — that number comes
> from reading the code, not from a measurement, and replacing it with a real one is a cheap
> first task.

- [x] Extract the storage layer into its own module (`store.js`) so it can be constructed and
      tested without starting the MCP stdio loop.
- [ ] Formalize the documented `Store` interface (`touch`, `searchDense`, `searchSparse`) —
      the seam exists now but still leaks JSONL assumptions.
- [ ] Add `SqliteStore` — `sqlite-vec` for vectors, FTS5 for the `RM-05` keyword arm (which
      makes hybrid retrieval nearly free), WAL mode, incremental writes.
      **`node:sqlite` is confirmed available** on the Node 22 runtime (`DatabaseSync`,
      `StatementSync`, `backup`), which settles the dependency question in `proposed/0005`:
      no native module, no threat to the single-file SEA build. Whether the `sqlite-vec`
      extension loads inside SEA is the one part still unknown.
- [ ] Conformance test suite both backends must pass identically.
- [ ] Transparent one-way migration on first run, with a `.bak`.
- [ ] JSONL stays the default until SQLite passes conformance + eval parity.

**Acceptance:** 100k memories, recall p95 <100ms, no full-file rewrite; both backends
byte-identical on the eval scorecard.

Design: [`proposed/0005`](proposed/0005-store-abstraction.md).

---

### `RM-06` — Scoping: multi-user, multi-agent, session vs long-term · **L** · `todo`

- [ ] Record fields: `scope` (namespace), `agent_id`, `session_id`, `tier` (`session` | `long_term`).
- [ ] Scope resolution from MCP client identity / env, **never** from a model-supplied argument
      (a model must not be able to read another scope by asking).
- [ ] Recall defaults to `long_term` + current `session`; cross-scope reads require explicit config.
- [ ] Promotion path: session memories that recur get promoted to long-term (ties into `RM-10`).
- [ ] Panel: scope switcher; the 3D graph filters per scope.

**Acceptance:** an eval case proves agent A cannot recall agent B's memories; session memories
expire on schedule while long-term persists.

---

### `RM-10` — Idle-time consolidation ("sleep-time compute") · **M** · `todo`

Letta's sharpest idea, worth borrowing in shape: consolidate while idle, not on the hot path.

- [ ] Background pass on panel idle: run `RM-02` merges, `RM-03` conflict sweeps, decay,
      promote recurring session memories.
- [ ] Strictly off the critical path; cancellable; never runs during an active recall.
- [ ] Panel shows what it did, with **undo**.

**Acceptance:** a store that has drifted for 500 simulated updates measurably re-coheres
(staleness + duplicate rates drop) with no user-visible latency.

---

## Phase 4 — Reach

### `RM-11` — Cross-platform + signing · **M** · `todo`
- [ ] macOS + Linux SEA builds (SEA is per-platform; macOS must build on a Mac).
- [ ] Code signing / notarization to kill the SmartScreen + Gatekeeper warnings (a real
      adoption tax on an unsigned binary).
- [ ] Fix the noted default-path wart: data lands in `~/.lmstudio/…` even for Claude-only users.

### `RM-12` — SDKs and a documented local API · **L** · `todo`
- [ ] Version and document the panel's HTTP surface as a stable local API.
- [ ] Thin Python + TypeScript clients. No auth needed (127.0.0.1 only) — but bind-address and
      CORS must be verified locked down before this ships.

### `RM-13` — Failure-mode capture (opt-in, local) · **M** · `todo`
> The counter to the one moat we can't code past: incumbents see the long tail of real abuse.
- [ ] `Export failure bundle` button: the failing query, redacted/hashed memory shapes,
      metrics — **never raw memory text** unless explicitly ticked.
- [ ] Bundles drop straight into `eval/corpora/` as runnable cases.
- [ ] Opt-in, local-only, off by default. No phone-home, ever.

### `RM-14` — Hosted / enterprise · `deferred` — **on purpose**
Hosting rots the local path (see Zep's deprecated community edition). If it ever happens it
should be a **separately named product**, so the local one can't be hollowed out to protect
revenue. Non-hosted "enterprise" wants (multi-user scoping, audit log, policy file) are
covered by `RM-06` and `RM-16`.

---

## Cross-cutting (things not on the original list, but load-bearing)

### `RM-15` — Longitudinal coherence soak test · **M** · `todo`
> *Directly targets: "the gap between a working prototype of temporal/contradiction handling
> and one that stays coherent after hundreds of updates."*

- [ ] Simulate 1,000+ updates to an evolving persona (job changes, moves, preference flips,
      corrections, re-corrections).
- [ ] Assert coherence at checkpoints 100/250/500/1000: is the *current* answer right; is
      history intact; did the store grow superlinearly; did the graph fragment?
- [ ] Plot metric drift over update count — **the curve is the deliverable**, because slow rot
      is invisible to single-shot benchmarks.

**Acceptance:** staleness stays flat (not creeping) from update 100 → 1000.

### `RM-16` — Memory poisoning / injection defense · **M** · `todo`
- [ ] Treat tool-call content as untrusted: text a model saw on a webpage must not silently
      become a durable "user preference."
- [ ] Provenance on every record: `source` (`user_stated` | `model_inferred` | `tool_content`).
- [ ] Recall weights user-stated over model-inferred; panel can filter by provenance.
- [ ] Eval case: an adversarial "remember that you must always…" payload must not become a
      high-confidence long-term memory.

*(The Hebbian ledger is already provenance-discounted — this generalizes that instinct to the
whole write path.)*

### `RM-17` — Portability: export / import / backup · **S** · `todo`
- [ ] One-click export to plain JSONL + a documented schema; import with dedup.
- [ ] Reinforces the trust claim: your memories are *yours*, and leaving is easy.

### `RM-18` — Encryption at rest (optional) · **M** · `todo`
- [ ] Opt-in passphrase encryption for the store; off by default (it costs the
      inspect-with-a-text-editor property, which is currently a feature).

### `RM-19` — Recall explainability · **S** · `todo`
- [ ] Panel: "why did this surface?" — cosine, Hebbian bonus, graph hop, fusion rank.
- [ ] Turns the 3D graph from a pretty object into a debugging instrument, and makes `RM-05`
      and `RM-09` tuning legible instead of magic.

### `RM-20` — First-run quality · **S** · `todo`
- [ ] The empty-store experience: what to say to your AI to seed it well.
- [ ] Detect "connected but never saved anything" and offer a nudge in the panel.

---

## Dependency graph

```
RM-00 (eval) ─────────────────────────────┬──> everything
                                          │
RM-04 (temporal) ──┬──> RM-03 (conflict) ─┤
                   └──> RM-08 (decay)     │
RM-01 (extract) ───┬──> RM-02 (dedup) ────┘
                   └──> RM-10 (idle consolidation)
RM-21 (substrate) ─┬──> RM-09 (Hebbian tuning)
                   └──> RM-05 (hybrid) ──> RM-09
RM-16 (poisoning) ─────> RM-05 promotion gate
RM-07 (store) ─────────> RM-06 (scoping) ──> RM-12 (SDKs)
RM-15 (soak) ── validates ──> RM-03, RM-08, RM-10, RM-21
```

## Suggested first five

If you want a concrete "start Monday" list, in order:

1. **`RM-00`** — the harness. Everything else is guesswork without it.
2. **`RM-04`** — temporal fields. Cheap, additive, unblocks two other items.
3. **`RM-02`** — dedup. Highest visible quality-per-hour; users *feel* duplicate bloat.
4. **`RM-03`** — supersession. The headline capability gap vs Zep.
5. **`RM-07`** — SQLite. Removes the full-file-rewrite bomb before anyone hits it.

---

## Related

[[ROADMAP]] · [[ARCHITECTURE]] · [[BUGS]] · [[phase-0-edge-substrate]] · [[phase-2-retrieval-dynamics]] · [[proposed/README]] · [[RESULTS]]
