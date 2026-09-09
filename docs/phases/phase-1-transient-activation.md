# Phase 1 — Transient activation

**Depends on:** Phase 0 ([[phase-0-edge-substrate]]) — needs the persistent edge substrate to
spread over. **Status:** ✅ **exit met** (observable-only; rank is still cosine). Route + status:
[[ROADMAP]].

> Buildable, individually testable work unit. Ephemeral spreading activation over the edge
> substrate: seeded from retrieval, attenuated per hop, bounded, **never persisted** (I7 —
> [[ARCHITECTURE]] §2). ⛔ Activation may **not** touch rank in this phase — it is observable and
> traced only; rank entry is the Phase 2.2 gate ([[phase-2-retrieval-dynamics]]).

---

## Scope

Give retrieval a short-lived, spreading "what's warm right now" signal computed over the edges
Phase 0 made persistent — without letting it change the answer yet. It exists to be *measured*
against rank before it is ever allowed near rank.

Implementation: `warm.js` (`WarmField`). The live recall hook in `memory-core.js` seeds, spreads,
and traces; it does not consult `out`. Rank remains cosine. The Phase 2.2 candidate record
(`semantic` · `hebbian` · `recency` · `activation` · `final_score: "semantic"`) is already the
trace shape, so fusion does not need a second hook.

A prior `warm.js` (pre-Phase-0) spread over `field.buildEdges` (ephemeral kNN) and decayed per
recall-turn. That graph is not the Phase 0 substrate, and turn-decay is not the Phase 0.2
discipline. This phase spreads over `EdgeStore` (pruned edges skipped by `incident()`) and
decays lazy wall-clock.

---

## Pre-declared metric — Activation Propagation Ratio (APR)

Declared **before** 1.3 was written. Not a recall metric; activation's own behaviour,
self-contained. The custom eval is `eval/substrate/activation-measure.js` (also asserted from
`test.js`). Tuned knobs live in `warm.js` and must not move without re-running that readout.

On a chain `A —w_ab— B —w_bc— C`, seed A from similarity `E_A = clamp(sim_A, 0, 1)`, spread
with per-hop attenuation `α` and conductance `γ(e) = s + h − s·h` (noisy-OR;
`s = clamp(semantic, 0, 1)`, `h = tanh(effectiveHebbian)`):

| # | Claim | Pass | Fail (the signature) |
|---|---|---|---|
| 1 | **Neighbor coupling.** A activating raises B through A↔B. `E_B = E_A · γ(A,B) · α`. | `E_B > 0` and `|E_B / (E_A · γ) − α| < 1e-9` | `E_B = 0` (no spread) or `E_B ≥ E_A` (no attenuation) |
| 2 | **Conductance monotonicity.** Stronger edge → stronger propagation. | `γ_hi > γ_lo ⇒ E_B(hi) > E_B(lo)` | equal or inverted |
| 3 | **Multi-hop attenuation.** Energy falls monotonically with hops. | `E_A > E_B > E_C > 0` at depth 2 | `E_C ≥ E_B` (amplification) or `E_C = 0` at depth 2 on a strong chain (over-attenuation) |
| 4 | **Hop bound.** Depth is real. | depth 1 ⇒ `E_C = 0` | 2-hop leak at depth 1 |
| 5 | **Bootstrap vs learned.** A 0.25 semantic-only edge transmits strictly less than the same pair with high Hebbian. | `E_B(0.25, w=0) < E_B(0.25, tanh(w)≈0.96)` | equal transmission |
| 6 | **Runaway bound.** Star of N=100, `γ=1`. Update is max-not-sum, cap holds. | `max(E) ≤ 1` and `size ≤ cap` | any `E > 1` or unbounded growth |
| 7 | **Half-life.** Lazy wall-clock, computed on access, injectable clock. | at `t = H`, `E = ½ E_0` | turn-count decay, or a 5s pause dumping energy |
| 8 | **Each signal is productive.** Hold `s = 0.70`, raise hebbian `0 → 0.3`. | `γ` rises (noisy-OR `0.70 → ~0.787`) | `γ` holds (the `max` mux: learning is invisible until `tanh(w) > s`) |

**Rank identity** and **I7** are not APR — they are the ⛔ gates (below). They must hold even
when APR is green.

### Tuned knobs (and why)

| Knob | Value | Why this number |
|---|---|---|
| `α` attenuation per hop | **0.5** | Independent of edge strength. 2-hop through two 0.25 bootstrap edges from `E=1`: `0.125` then `0.0156` — below floor, so weak structure dies at 2 hops. Two 0.8 edges: `0.40` then `0.16`, still observable. That's the split claim 1 / 5. |
| depth bound | **2** | Claim 3 is untestable at 1 hop. 3 hops on 0.25 edges is noise under the floor. |
| floor | **0.05** | Below this, warm ≈ cold. Combined with `α=0.5` it is the 2-hop bootstrap kill. |
| cache cap | **256** | Conversation working set; evict lowest-effective first. Bound is the point. |
| half-life | **300 s** | Conversation-scale "right now". A 5s think-pause is ~1.1% decay (the trap the old `λ_turn` was invented to avoid — a proper wall-clock H makes that trap imaginary). 5 min → ½. ~13 min → floor. |
| seed norm | **clamp(sim, 0, 1)** | Cosine is already bounded; this stops keyword-fallback or a >1 sneak from creating unbounded activation. Top-hit is **not** renormalized to 1.0 — that would throw away "how good was this retrieval." |
| conductance | **noisy-OR `s + h − s·h`** | Either channel carries alone (`γ(s,0)=s`, `γ(0,h)=h`). Both corroborate: holding `s=0.70` and raising hebbian 0→0.3 raises γ (claim 8); `max` would not. Weak bootstrap still transmits 0.25. |
| spread cap (`WARM_EDGE_CAP`) | **512** vectors | Skip spread (not seed) on a huge store. Related: is not this cap. |

Idle-TTL (the old 30 min map wipe) did **not** earn its place: with wall-clock half-life + floor,
energy is already gone before 30 min. One clock, like Phase 0.2.

---

## Build steps

### 1.1 Activation state
- [x] Ephemeral activation keyed by memory ID in an in-memory `Map`: `id → { value, similarity, timestamp }`.
- [x] Separate from persistent strength; **never persisted** (I7).
- [x] Cleared on process restart and on soft-prune / soft-delete of the memory (`forget` / `pruneTo`). Bound cache size (256).

### 1.2 Initial activation
- [x] Seed from semantic retrieval (`seedFromRetrieval({ id, similarity })`); similarity and activation are separate fields on the node.
- [x] Normalization: `clamp(sim, 0, 1)` so raw similarity can't create unbounded activation.

### 1.3 Spreading activation
- [x] Propagate through Phase 0 edges (`activationEdgesFromStore` / `EdgeStore.incident`); attenuate per hop (`α=0.5`); bound depth (2).
- [x] Stronger edges transmit more; weak bootstrap edges transmit appropriately little (APR #2, #5).
- [x] Pruned edges never participate (`pruned_at` ⇒ conductance 0; `incident()` already skips). Prevent runaway (max-not-sum, cap, floor).

### 1.4 Activation decay
- [x] Lazy/event-driven, timestamped, computed on access: `E(t) = v · 2^(−Δt / H)` (same discipline as Phase 0.2 `effectiveHebbian`). A `get()` does not write the decayed number back.
- [x] Persists between MCP calls while the server lives (one `WarmField` per process); resets on restart (a new Map is empty).
- [x] Can never resurrect a soft-pruned memory (`live` set on `spread`; `forget` on `remove`; `pruneTo` drops ids not in `mems`).

### 1.5 Tests → see Test plan.

---

## Failure signatures

- Any activation value found on disk or in the store schema → I7 violated.
  (`test.js` JSONL walk + SQLite `PRAGMA table_info` on `memories` / `edges` after a warm recall.)
- Activation touching rank in this phase → the ⛔ gate breached.
  (byte-identical `recall()` output, warm on vs off; RM-00 golden 27/31 unchanged with activation **computed**.)
- Activation resurrecting a soft-pruned memory → prune semantics broken.
  (`forget` + `live`-gated spread; pruned edge conductance 0.)
- Unbounded/runaway spread → attenuation or depth bound missing. (APR #4, #6.)
- A 5s wall pause dumping energy → seconds were fed into a per-turn lambda. (APR #7.)

---

## Test plan
- [x] A activates → B receives through A↔B; stronger edge → stronger propagation; multi-hop attenuates. (`test.js` + `activation-measure.js`)
- [x] Activation decays; survives between calls; restart clears; prune clears.
- [x] **Activation never reaches disk.**
- [x] Recall output is byte-identical with activation computed vs disabled.
- [x] Trace emits the Phase 2.2 candidate shape (`activation` its own field; `final_score` stays `"semantic"`).

---

## Exit

Activation is observable and traced, provably ephemeral, and provably not affecting rank. Then
[[phase-2-retrieval-dynamics]].

---

## Related

[[ROADMAP]] · [[phase-0-edge-substrate]] · [[phase-2-retrieval-dynamics]] · [[ARCHITECTURE]] · [[BACKLOG]]
