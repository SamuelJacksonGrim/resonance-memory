# Phase 0 — Unify time & persistence (edge substrate) 🔀 **← current work**

**Backlog:** `RM-21` · **Depends on:** `RM-00` (golden gate), `RM-04` (temporal schema),
`BUG-008` (fixed in PRE-0) · **Scope owner:** this doc. Route + status: [[ROADMAP]].

> This is a **buildable, individually testable** work unit. It carries the full spec so it can be
> built and verified on its own. Deeper rationale that predates it lives in the RFCs it links
> under **Related**; this doc is the canonical build spec — where they disagree, this wins and the
> RFC is reference only.

---

## Scope — two mechanisms describing one idea

The associative substrate is today **two mechanisms with different lifetimes**, cooperating but
not unified:

```
field.js    semantic edges    ephemeral   rebuilt every recall    not persisted
ledger.js   learned weights   persistent  epoch-decayed           JSON sidecar
```

Save-time edges are meant to be persisted, to compete, and to accrue Hebbian weight over time.
That only works if save-time and learned edges live in **one table**. Phase 0 unifies `field.js`
and `ledger.js` into a single persistent edge substrate with **independently stored semantic and
learned signals**, typed provenance, and shared temporal/competition machinery.

**Not one weight.** Collapsing `cosine(a,b)` and the Hebbian weight into a single scalar throws
away the distinction the whole design rests on, and contradicts Phase 2.1 (signals must stay
independently observable). **One edge substrate, two signals.**

### The asymmetry is load-bearing

| | Semantic | Learned (Hebbian) |
|---|---|---|
| Source | Derived from stored embeddings | Accumulated from use |
| If lost | Recomputable | **Gone forever** |
| Decays? | **No** — a structural fact, not a memory trace | Yes. Wall-clock once 0.2 lands; recall-count today |
| Invalidated by | `edit()` re-embedding either endpoint | Nothing |

```
embedding            source of truth   (what the memory means)
edge semantic score  derived cache     (recomputable from the above)
hebbian weight       source of truth   (irreplaceable; nothing else encodes it)
```

Consequences that drive real behaviour: backup/export (`RM-17`) must preserve learned weight and
may drop semantic; a corrupt semantic score is recoverable, a corrupt learned weight is not; and
because `edit()` re-embeds, cached semantic scores must be validated by **version comparison
against their endpoints**, not by trusting an invalidation event to have fired.

This is a **migration with a compatibility path for existing `.assoc.json` sidecars**, not
greenfield — built fresh, it produces a second parallel associative system beside the one shipping.

---

## The unified edge record

```js
{
  a, b,                                           // endpoints (canonical: edgeKey sorts them)
  semantic: { value, src_versions: { a, b } },    // DERIVED cache; validity is a comparison
  hebbian:  { weight, last_updated },             // SOURCE OF TRUTH; the only thing that decays
  provenance: { origin, migrated_from },          // how the edge came to exist
  created_at,                                      // provenance only; never decay, never rank
  // last_accessed is deliberately ABSENT — persisting it means an edge write on every recall,
  //   which I5 forbids (the BUG-002 class). Hold it in memory or the AccessLog sidecar.
  pruned_at,                                       // current-state marker (null = active)
  prune_count, first_pruned_at, last_reactivated_at // bounded history (I8), O(1), no arrays
}
```

- **No bare `last_updated`** — it nests inside `hebbian`, the only thing it clocks. The nesting
  answers "does re-embedding update this?" before anyone asks.
- **`provenance.origin`** records *how the edge came to exist* (`save-time-neighbor` |
  `co-activation`), not what it currently is; state is read off the signals (`hebbian.weight === 0`
  is unreinforced). No bootstrap→learned *transition* — an edge simply accrues weight.
- **`provenance.migrated_from`** is separate, not an origin value: a legacy sidecar edge genuinely
  arose from co-activation, so folding migration into the origin enum would overwrite a true fact
  with a bookkeeping one. Record both.
- **`created_at`** is "provenance only" = never touches rank/decay/pruning, **not** unimportant.
  Only history tells these two apart: `created → never reinforced → pruned` vs.
  `created → reinforced 37× → decayed → pruned → reactivated → reinforced again`.

Preserved unchanged: bounded bonus `maxBonus·tanh(w)` (I2/I9), provenance-discounted reinforcement
(`alphaPP`/`alphaPN`/zero N↔N), fails-open (I3), discovery-not-ordering (I9 — primary cosine result
byte-identical field on/off).

---

## Validity by version comparison (not remembered invalidation)

Give each memory an `embedding_version`, incremented on every re-embed. An edge's cached
`semantic.value` is valid **iff** `semantic.src_versions` match both endpoints' current versions.
Stale is then *structurally self-evident* — no invalidation event has to fire, and none can be
silently missed. *(Event-based invalidation has a failure window: memory persists → invalidation
throws → embedding is v13 while the edge still describes v12, and nothing knows.)*

`embedding_version` is a **store schema change** — it lands in `record.js normalize()` alongside
the `RM-04` fields, defaulting existing records to `1`. **`BUG-008` dependency:** an embed
*failure* must never increment the version (that would falsely assert the vector is current).
Text-drifted-from-vector is a known, recoverable state that must stay distinguishable from a real
re-embed — which is why `BUG-008` was fixed in PRE-0 before this schema hardens.

---

## Build steps (each sub-phase is independently buildable + testable)

### 0.0 — Edge store unification 🔀 *(start here)*
- [ ] One edge table, two signals, typed provenance.
- [ ] `embedding_version` in `record.js normalize()` (legacy rows default `1`).
- [ ] Migrate every `.assoc.json` edge in: weight → `hebbian.weight`; stamp `hebbian.last_updated`
      + `created_at` at migration time (both **lower bounds** — note it); origin `co-activation`,
      `migrated_from: "assoc.json"`; semantic empty, computed on first use.
- [ ] **Migration is one-way:** an old build reading a new sidecar fails cleanly, never silently
      drops edges.
- [ ] Preserve `field.js` constraint-rescue + mutual-kNN through the move (measured — [[RESULTS]]
      field experiment #2).

### 0.1 — Edge timestamps & save-time edges
- [ ] On `save()`, bind top-K semantic neighbors (start **K ≈ 5**) above a min cosine (**test
      ~0.25**; note `field.js` uses 0.55 at *recall* — reconcile deliberately, don't diverge).
- [ ] Save-time edges store measured `semantic.value` (+ `src_versions`) and `hebbian.weight = 0`
      — **no seeded baseline** (an unreinforced edge's Hebbian signal is genuinely zero).
- [ ] **Cost sweep:** record `save_latency` p50/p95/p99 at N = 100 / 1k / 10k / 50k / 100k;
      **pre-declare** the p95 budget that triggers `RM-07` *before* running the sweep.

### 0.2 — Lazy wall-clock decay 🔀 *(replaces `ledger.js tick()/decay()`)*
- [ ] Decay applies to **`hebbian.weight` only** (semantic is structural, does not fade).
- [ ] `effectiveHebbian(edge, now)` decaying from `now − hebbian.last_updated`; remove the
      recall-epoch clock; no background loop.
- [ ] **Reading never resets decay — this is where I6 becomes true** (today `recall()` calls
      `tick()`; that call goes away). `reinforceRecall` is untouched.
- [ ] Configurable **half-life**, not raw lambda: `lambda = ln(2)/halfLife`; per-type/namespace
      half-lives; normalize to seconds; clamp `delta = max(0, now − last_updated)`; verify
      monotonic. Start: constraints ~30d · facts ~7d · working ~1h (**parameters, not constants**).
- [ ] Ships with `RM-08` (same decay/pruning surface) — see [[0006-constraints-decay-pruning]].

### 0.3 — Materialize on mutation & idempotency
- [ ] On mutation: materialize effective weight → apply reinforcement to *that* → store → stamp
      `hebbian.last_updated` → keep provenance. Reinforcement can never bypass accumulated decay.
- [ ] **One MCP request ID = one mutation transaction.** Extract request IDs at the server
      boundary; thread into mutations. Two distinct requests reinforcing A↔B both apply; one
      request retried applies once.
- [ ] **Dedup record + weight change commit atomically** (I5 makes each write durable, not the
      *pair* atomic). Cheapest correct form: dedup LRU *inside the sidecar* so one
      `writeFileDurable` commits both. If not atomic, **order dedup-first** (a missed reinforcement
      decays out harmlessly; a doubled one is corrupted learning that never self-corrects).
- [ ] Bounded LRU of processed IDs; apply to **all** mutating ops. Relates to `W-04` ([[BUGS]]).

### 0.4 — Soft pruning
- [ ] **An edge whose Hebbian signal decays to zero is not pruned if semantic still clears the
      gate** — it reverts to an unreinforced semantic edge. Prune only edges that are *both*
      unreinforced and semantically weak. *(This is why the two signals can't share one scalar: a
      merged weight would prune a semantically-strong, rarely-recalled pair and break constraint
      rescue — [[RESULTS]] field experiment #2.)*
- [ ] **Soft prune first** (I8): mark inactive, set `pruned_at`, keep the record. Pruned edges do
      not participate in retrieval. Hard compaction later, explicit — mirror `vacuum()`.
- [ ] **Reactivation is server-side only** (guards I1): a consequence of an existing mutation
      (`save`/`edit` touching an endpoint), never a new tool. Revive in place; `created_at`
      preserved; `hebbian.weight` carries its decayed value; `pruned_at` → `null` while
      `prune_count`/`first_pruned_at`/`last_reactivated_at` keep bounded history.

### 0.5 — Phase 0 tests *(see Test plan below)*
### 0.6 — Threat-model sketch *(design only; `RM-16` implementation stays gated to Phase 2)*
- [ ] On paper: what can cause an edge to exist? raise Hebbian weight? make a memory a
      constraint-rescue bridge? survive indefinitely? Record that **semantic is recomputable,
      Hebbian is not** — a poisoned reinforcement is a durable *false memory*. Carry the answers
      that change at the Phase 2.2 gate into `RM-16`.

---

## Edge state transition table (PRE-0 ratifiable artifact)

The `Writes?` column makes **I5** checkable at a glance. Ratifying = every cell decided.

| Event | `semantic` | `hebbian.weight` | `hebbian.last_updated` | `created_at` | `pruned_at` | Writes? |
|---|---|---|---|---|---|---|
| **save** creates edge | compute + cache w/ `src_versions` | `0` | = `created_at` | set | `null` | yes |
| **save** where edge exists | recompute if versions stale | unchanged | unchanged | unchanged | unchanged | only if semantic recomputed |
| **recall** (read) | unchanged | unchanged — decay *computed*, not stored | unchanged | unchanged | unchanged | **no** |
| **reinforce** | unchanged | materialize decay → apply α | `now` | unchanged | `null` (reactivation) | yes, atomic w/ dedup record |
| **edit** endpoint | self-invalidates by version mismatch | unchanged | unchanged | unchanged | unchanged | **no edge write at all** |
| **soft prune** | unchanged | unchanged (keeps decayed value) | unchanged | unchanged | `now`, `prune_count++` | yes |
| **reactivate** | self-heals by version mismatch | unchanged | unchanged | **preserved** | `null`, `last_reactivated_at = now` | yes |
| **migration** | empty; computed on first use | imported from sidecar | migration time *(lower bound)* | migration time *(lower bound)* | `null` | yes, once |
| **hard compaction** | dropped with the edge | dropped | — | — | — | yes |

Filling this found a conflict: `last_accessed` cannot be a persisted edge field written on recall
(the `BUG-002` class **I5** prevents). It is **not written on the read path** — kept in memory or
batched through the `AccessLog` pattern. Telemetry does not get to violate an invariant.

---

## Success metrics

- **Golden set does not regress** (`npm run eval`) at **any** sub-phase boundary. This is the
  primary gate — do not proceed past a red one.
- **I6 true:** a store recalled N times under a **frozen clock** shows **zero** learned-edge decay;
  decay appears only as wall-clock advances.
- **Migration lossless + one-way:** every `.assoc.json` edge survives into the new store.
- **Stale-semantic self-heals:** an `edit()` bumps `embedding_version` so incident edges fail the
  `src_versions` match on next read **with no invalidation event run**.
- **Signals stay separate:** heavy reinforcement leaves `semantic.value` unmoved; decay-to-zero
  leaves the edge alive with semantic intact.
- **Cost sweep produces a decision:** the pre-declared p95 budget is compared against measured
  `save_latency`, yielding a go/no-go on `RM-07` — a *number*, not a guess.

## Failure signatures *(pre-declared — a clean pass is the alarm, not the trophy)*

- A read moves `hebbian.last_updated` or changes effective weight → I6 violated.
- An `.assoc.json` edge silently absent after migration → data loss; migration is not lossless.
- A stale semantic score served after an `edit()` with no version bump caught → validity broken.
- A corrupt sidecar throws or empties recall → I3 (fails-open) violated.
- A retried MCP request double-reinforces → idempotency broken.
- A merged/collapsed scalar prunes a strong-semantic rarely-recalled edge → constraint rescue
  regressed (the thing 0.4 exists to prevent).
- An embed *failure* increments `embedding_version` → `BUG-008` class reintroduced.

## Test plan *(fake clock throughout; every transition-table row incl. the negatives)*

- [ ] Decay at multiple elapsed times · half-life math · negative clock deltas.
- [ ] Persistence/reload; legacy `.assoc.json` migration (weight lands, nothing dropped).
- [ ] **Signals stay separate** (reinforce → semantic unmoved; decay to zero → edge survives).
- [ ] **Stale semantic structurally detectable** (edit → version++ → incident edges fail
      `src_versions` on read, no event run; also: persist memory, crash before touching edges,
      edge still seen stale).
- [ ] `edit()` with a dead embedder does **not** increment `embedding_version`.
- [ ] **Reading does not reinforce (I6):** read one edge 100× → weight + `last_updated` unchanged,
      *then* genuine reinforcement does change them.
- [ ] Reactivation preserves history (`created_at` unmoved, `prune_count === 1`, weight carried).
- [ ] Save-time edges (creation, threshold, fewer-than-K, weight starts 0, semantic cached).
- [ ] Reinforcement after long inactivity materializes decay first.
- [ ] Soft-pruned edges survive persistence; duplicate reinforcement / request-ID dedup.
- [ ] Interrupted/failed persistence, atomic recovery.
- [ ] **Field fails open (I3):** corrupt sidecar → recall still returns cosine.
- [ ] Negatives: recall writes nothing to the edge store; edit writes nothing to the edge store.

---

## The two decays, kept distinct

| | Object | Signal | Law | Clock | Owner |
|---|---|---|---|---|---|
| **Learned-edge decay** | an *edge* | `hebbian.weight` | half-life `w·2^(−Δt/H)` then prune | **wall-clock** (this doc) | `RM-21` / Phase 0.2 |
| **Importance decay** | a *record* | `importance` | `importance·exp(−λ·Δt)`, refreshed on access/confirm | wall-clock | `RM-08` / [[0006-constraints-decay-pruning]] |

Never wire one into the other — a single `Δt` for both couples association strength to record
retention, the hidden coupling that inverts behaviour under load.

## Risks

1. **Save-time cost unmeasured** — the sweep decides whether `RM-07` becomes mandatory.
2. **Two cosine thresholds disagree** — recall `minSim` 0.55 vs. save-time bind ~0.25; deliberate,
   documented, not accidental.
3. **`null`-through-`Object.assign` class** (`BUG-008` is one instance) — sweep every
   `store.update()` caller before 0.0 adds more.
4. **Edge inheritance across supersession undecided** (Phase 7 — [[phase-7-reconsolidation]]) — the
   quietest data-loss path; deferred there on purpose.
5. **Migration is one-way** — the learned signal is irreplaceable, so `RM-17` (backup) rises.
6. **Cached semantic scores are derived** — residual cost is recompute-on-read for stale edges + a
   periodic full-recompute escape hatch for bulk drift.

## Exit

```
A ↔ B    semantic → unchanged by time; recomputed only when an endpoint's version moves
         hebbian  → time passes → decays mathematically
read     → last_accessed moves in memory/AccessLog only; no edge write; no decay change
reinforce→ decayed weight materialized → α applied → last_updated stamped → durable
edit A   → version++ → incident edges structurally stale on next read → hebbian untouched
```

Golden set green and reliable. Do not proceed to [[phase-1-transient-activation]] until it is.

---

## Related

[[ROADMAP]] · [[BACKLOG]] · [[ARCHITECTURE]] · [[BUGS]] · [[phase-1-transient-activation]] · [[0006-constraints-decay-pruning]] · [[0005-store-abstraction]] · [[RESULTS]] · [[eval/README]] · [[CLAUDE]] · [[roadmap-dissemination-log]]
