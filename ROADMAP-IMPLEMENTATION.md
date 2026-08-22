# Resonance Memory — Full Implementation Roadmap

**Core Principle**

Time is a function, not a process.

Resonance Memory is a persistent, event-driven associative memory substrate, not an autonomous organism.

It should not need a permanent heartbeat, dream loop, rhythm engine, or background decay process.

Every operation follows:

    event
      ↓
    observe state at time T
      ↓
    calculate temporal effects
      ↓
    retrieve / activate / modify
      ↓
    persist durable changes

---

## Phase 0 — Lazy Time & Persistence

### 0.1 Edge Timestamps & Graph Initialization

- [ ] Add `last_updated` to every Hebbian edge.
- [ ] Add `last_accessed` for observation/logging.
- [ ] Do **not** use `last_accessed` as the decay clock.
- [ ] Persist timestamps with every edge.
- [ ] Preserve timestamps through reload.
- [ ] On `save()`, find the new memory's top‑K semantic neighbors.
- [ ] Start with approximately K = 5.
- [ ] Apply a minimum cosine similarity threshold to bootstrap edges.
- [ ] Initially test a threshold around 0.25.
- [ ] Only create bootstrap edges when cosine similarity exceeds the threshold.
- [ ] If fewer than K neighbors qualify, bind only the qualifying neighbors.
- [ ] Give bootstrap edges a tiny baseline weight such as 0.01.
- [ ] Distinguish bootstrap edges from learned/co‑activated associations where useful.
- [ ] Ensure bootstrap edges are subject to normal decay.
- [ ] Ensure bootstrap edges are subject to normal competition/normalization.
- [ ] Ensure bootstrap edges can later become genuinely reinforced associations.

**Conceptual distinction**

    semantic proximity
           ↓
    bootstrap edge
           ↓
    "these things are near each other"

    co‑activation + usefulness
           ↓
    Hebbian reinforcement
           ↓
    "these things have learned an association"

---

### 0.2 Lazy Decay

- [ ] Implement `effectiveWeight(edge, now)`.
- [ ] Calculate decay from `now - last_updated`.
- [ ] Do **not** run a background decay loop.
- [ ] Do **not** reset decay merely because an edge is read.
- [ ] Express decay using configurable half‑life rather than exposing raw lambda values.
- [ ] Convert internally using:

        lambda = ln(2) / halfLife

- [ ] Make half‑life configurable.
- [ ] Support different half‑lives by edge type or namespace where useful.
- [ ] Convert timestamps consistently to seconds before decay calculations.
- [ ] Guard against system‑clock changes.
- [ ] Clamp negative elapsed time to zero:

        delta = max(0, now - last_updated)

- [ ] Ensure clock drift can never produce anti‑decay.
- [ ] Verify decay is mathematically monotonic.

**Initial experimental half‑lives**

- constraints → ~30 days
- ordinary facts → ~7 days
- working context → ~1 hour

These are starting parameters, not permanent architectural constants.

---

### 0.3 Materialize on Mutation & Idempotency

When an edge is modified:

- [ ] Calculate its current effective weight first.
- [ ] Apply reinforcement to that effective weight.
- [ ] Store the resulting weight.
- [ ] Update `last_updated`.
- [ ] Preserve provenance of the mutation.
- [ ] Ensure reinforcement cannot bypass accumulated decay.
- [ ] Make reinforcement idempotent.
- [ ] Extract MCP/JSON‑RPC request IDs at the server boundary.
- [ ] Pass request/event IDs into mutation operations.
- [ ] Maintain a small LRU cache of recently processed mutation IDs.
- [ ] Ignore duplicate mutation events already processed.
- [ ] Prefer explicit event/request IDs over time‑window deduplication.
- [ ] Keep a short grace‑window circuit breaker as fallback when IDs are unavailable.
- [ ] Apply idempotency to reinforcement and other mutating operations, not just memory creation.

**Mutation flow**

    MCP request
      │
      ├── request/event ID
      │
      ▼
    memory engine
      │
      ├── duplicate? └── yes → ignore
      │
      └── no
            ↓
          lazy decay
            ↓
          reinforce
            ↓
          update timestamp
            ↓
          persist
            ↓
          record event ID

---

### 0.4 Pruning

- [ ] Evaluate effective weights during relevant operations.
- [ ] Define a configurable pruning threshold.
- [ ] Initially use **soft pruning**.
- [ ] Soft‑pruned edges become inactive rather than immediately disappearing.
- [ ] Record `pruned_at`.
- [ ] Preserve the edge record for provenance/debugging.
- [ ] Prevent pruned edges from participating in normal retrieval.
- [ ] Allow future reactivation if explicitly justified.
- [ ] Add hard‑compaction later.
- [ ] Create an explicit cleanup/compaction operation.
- [ ] Test that soft‑pruned data survives persistence/reload.

---

### 0.5 Phase 0 Tests

- [ ] Use a fake clock.
- [ ] Test decay at multiple elapsed times.
- [ ] Test half‑life calculations.
- [ ] Test negative clock deltas.
- [ ] Test persistence/reload.
- [ ] Test bootstrap edge creation on `save()`.
- [ ] Test bootstrap cosine threshold.
- [ ] Test fewer‑than‑K qualifying neighbors.
- [ ] Test bootstrap edges begin at the expected weak weight.
- [ ] Test bootstrap edges decay normally.
- [ ] Test bootstrap edges can later be reinforced.
- [ ] Test reinforcement after long inactivity.
- [ ] Test soft pruning.
- [ ] Test pruned edges survive persistence.
- [ ] Test duplicate reinforcement handling.
- [ ] Test MCP request/event ID deduplication.
- [ ] Explicitly test that reading does **NOT** reinforce:
    - [ ] Read the same edge 100 times.
    - [ ] Verify its effective weight is unchanged by those reads.
    - [ ] Verify reading does **not** reset `last_updated`.
    - [ ] Verify genuine reinforcement changes the edge.
- [ ] Test interrupted/failed persistence behavior.
- [ ] Test atomic recovery where applicable.

---

### Phase 0 Exit Condition

    A ↔ B
      ↓
    time passes
      ↓
    weight decays mathematically

    read A ↔ B
      ↓
    nothing about decay changes

    reinforce A ↔ B
      ↓
    current decayed weight materialized
      ↓
    reinforcement applied
      ↓
    new timestamp stored

Do **not** proceed until this behavior is reliable.

---

## Phase 1 — Transient Activation

### 1.1 Activation State

- [ ] Add ephemeral activation values associated with memory IDs.
- [ ] Store activation in an in‑memory `Map`.
- [ ] Example conceptual structure:

        activationCache
          memory_A → { value, timestamp }
          memory_B → { value, timestamp }
          memory_C → { value, timestamp }

- [ ] Store the timestamp associated with each activation.
- [ ] Keep activation separate from persistent memory strength.
- [ ] Do **not** persist activation to disk.
- [ ] Activation naturally disappears on process restart.
- [ ] Clear activation when a corresponding memory is soft‑pruned.
- [ ] Bound activation cache size if necessary.

### 1.2 Initial Activation

- [ ] Seed activation from semantic retrieval.
- [ ] Keep semantic similarity separate from activation internally.
- [ ] Record initial activation values during development.
- [ ] Establish an initial activation normalization strategy.
- [ ] Prevent raw embedding similarity from creating unbounded activation.

### 1.3 Spreading Activation

- [ ] Propagate activation through Hebbian edges.
- [ ] Attenuate activation at each hop.
- [ ] Limit propagation depth.
- [ ] Prevent runaway activation.
- [ ] Test stronger edges transmitting more activation.
- [ ] Test weak/noisy bootstrap edges transmitting appropriately little activation.
- [ ] Prevent pruned edges from participating.

### 1.4 Activation Decay

- [ ] Apply temporal decay to activation.
- [ ] Make activation decay lazy/event‑driven.
- [ ] Store activation timestamps.
- [ ] Calculate effective activation when accessed.
- [ ] Allow activation to persist between MCP calls while the server remains alive.
- [ ] Reset transient activation on process restart.
- [ ] Ensure activation cannot resurrect a soft‑pruned memory.

### 1.5 Activation Tests

- [ ] Activate A.
- [ ] Verify B receives activation through A↔B.
- [ ] Verify stronger edges produce stronger propagation.
- [ ] Verify multiple hops attenuate.
- [ ] Verify activation decays.
- [ ] Verify activation survives between calls while the server remains alive.
- [ ] Verify restart clears activation.
- [ ] Verify pruning clears activation.
- [ ] Verify activation never reaches disk.

---

## Phase 2 — Retrieval & Association Dynamics

### 2.1 Separate Signals

Keep these independently observable:

- [ ] Semantic similarity.
- [ ] Hebbian association.
- [ ] Activation.
- [ ] Recency.
- [ ] Context.
- [ ] Constraint/salience signals where applicable.

Do **not** collapse everything into one opaque score too early.

### 2.2 Retrieval Scoring

- [ ] Avoid arbitrary permanent linear weighted sums.
- [ ] Evaluate rank‑based fusion/RRF.
- [ ] Evaluate multiplicative gating.
- [ ] Test which approach behaves better empirically.
- [ ] Prefer a model that remains stable across score‑scale changes.
- [ ] Prevent Hebbian association from completely overriding semantic relevance.
- [ ] Log every score component independently:
    - [ ] Record query ID.
    - [ ] Record candidate memory ID.
    - [ ] Record final score.
- [ ] Implement structured retrieval tracing.
- [ ] Emit one structured JSON record per candidate during debug mode.
- [ ] Include fields such as:
    - `query_id`
    - `candidate_id`
    - `semantic`
    - `hebbian`
    - `recency`
    - `activation`
    - `final_score`
- [ ] Allow retrieval tracing to be toggled through configuration/environment.
- [ ] Keep verbose tracing disabled in normal production operation.
- [ ] Use traces to tune thresholds, half‑lives, attenuation, and boost factors empirically.

### 2.3 Association Competition

- [ ] Prevent frequently accessed memories from becoming universal hubs.
- [ ] Introduce neighborhood competition.
- [ ] Test competing associations.
- [ ] Test high‑frequency nodes.
- [ ] Test dense graph formation.
- [ ] Ensure bootstrap edges participate in the same competition rules.

### 2.4 Homeostatic Normalization

- [ ] Bound total associative strength.
- [ ] Prevent unlimited Hebbian accumulation.
- [ ] Test repeated reinforcement.
- [ ] Test whether strengthening one association excessively suppresses/weakens others.
- [ ] Prevent association weights from becoming meaningless due to scale inflation.
- [ ] Ensure normalization doesn't erase genuinely strong learned relationships.

### 2.5 Retrieval Evaluation

- [ ] Build a repeatable retrieval corpus.
- [ ] Measure recall@k.
- [ ] Measure MRR.
- [ ] Measure false associations.
- [ ] Measure hub formation.
- [ ] Measure staleness.
- [ ] Measure duplicate retrieval.
- [ ] Measure constraint surfacing.
- [ ] Measure retrieval latency.
- [ ] Compare semantic‑only retrieval against Resonance retrieval.
- [ ] Compare before/after Hebbian learning.

---

## Phase 3 — Episodic Working Context

### 3.1 Context Buffer

- [ ] Maintain temporary recent context.
- [ ] Store recent queries.
- [ ] Store recently retrieved memories.
- [ ] Keep context separate from long‑term memory.
- [ ] Bound context size.
- [ ] Avoid permanently writing every context state.

### 3.2 Context Representation

- [ ] Build a temporary context representation/vector.
- [ ] Update it as new events occur.
- [ ] Test different context aggregation strategies.
- [ ] Preserve the distinction between context and durable memory.

### 3.3 Context Decay

- [ ] Apply lazy temporal decay.
- [ ] Give context its own configurable half‑life.
- [ ] Allow old context to disappear naturally.
- [ ] Prevent stale context from dominating current retrieval.

### 3.4 Context‑Biased Retrieval

- [ ] Add contextual relevance as a retrieval signal.
- [ ] Test topic continuity.
- [ ] Test indirect references (e.g., "that", "it", "the previous one").
- [ ] Test whether context improves retrieval without overwhelming semantic relevance.
- [ ] Log contextual contributions during debugging.

---

## Phase 4 — Consolidation

### 4.1 Detect Recurring Structures

- [ ] Track repeated co‑activation.
- [ ] Identify stable clusters.
- [ ] Distinguish recurrence from accidental co‑occurrence.
- [ ] Require sufficient evidence before consolidation.
- [ ] Track provenance for candidate structures.

### 4.2 Crystal Candidates

- [ ] Identify candidate clusters.
- [ ] Generate candidate generalized representations (e.g., centroid/summary).
- [ ] Preserve links to source memories.
- [ ] Track confidence/evidence.

### 4.3 Consolidation

- [ ] Create durable generalized memories when justified.
- [ ] Connect consolidated memories back to their source memories.
- [ ] Ensure consolidation itself is measurable.
- [ ] Prevent consolidation from silently destroying episodic information.
- [ ] Make consolidation event‑driven/lazy rather than requiring a permanent daemon.

### 4.4 Redundancy Control

- [ ] Detect duplicate crystals.
- [ ] Prevent uncontrolled graph growth.
- [ ] Preserve original episodic memories.
- [ ] Avoid creating a crystal every time a topic is repeatedly queried.
- [ ] Test whether consolidation actually reduces retrieval complexity or improves recall.

### 4.5 Consolidation Evaluation

- [ ] Test repeated‑topic scenarios.
- [ ] Test generalized knowledge retrieval.
- [ ] Test false generalization.
- [ ] Test provenance.
- [ ] Test storage growth.
- [ ] Test retrieval quality before/after consolidation.
- [ ] Remove/rework consolidation if it does not demonstrate measurable value.

---

## Phase 5 — Temporal & Predictive Associations

### 5.1 Directed Edges

- [ ] Add `A → B` relationships separately from `A ↔ B`.
- [ ] Preserve existing undirected associative relationships.
- [ ] Distinguish association from prediction.

### 5.2 Sequence Learning

- [ ] Track temporal ordering.
- [ ] Learn repeated transitions.
- [ ] Record temporal evidence.
- [ ] Separate sequence evidence from simple co‑occurrence.
- [ ] Prevent simultaneous retrieval from automatically implying causality.

### 5.3 Prediction

- [ ] Use learned transitions for prediction.
- [ ] Distinguish prediction from semantic similarity.
- [ ] Track prediction accuracy.
- [ ] Decay unsupported predictions.

### 5.4 Confidence

- [ ] Track evidence count.
- [ ] Track confidence.
- [ ] Track provenance.
- [ ] Decay unsupported predictions.
- [ ] Prevent weak temporal correlations from becoming strong predictions.

---

## Phase 6 — Rich Memory Structure

### 6.1 Entities

- [ ] Separate persistent entities from individual memories.
- [ ] Link memories to entities.
- [ ] Track entity identity across memories.
- [ ] Test entity resolution.

### 6.2 Events

- [ ] Represent experiences as events.
- [ ] Attach temporal relationships.
- [ ] Link events to entities.
- [ ] Link events to memories.
- [ ] Preserve event provenance.

### 6.3 Causal Relationships

- [ ] Represent causal hypotheses separately from associations.
- [ ] Track evidence.
- [ ] Track uncertainty.
- [ ] Track source/provenance.
- [ ] Never treat correlation as automatic causation.

### 6.4 Inhibitory Relationships

- [ ] Support negative associations.
- [ ] Support suppression/inhibition.
- [ ] Test competition between activation and inhibition.
- [ ] Ensure negative relationships remain bounded.
- [ ] Keep inhibitory structure separate from ordinary similarity.

---

## Phase 7 — Reconsolidation

### 7.1 Recall → Update

- [ ] Allow recalled memories to be re‑evaluated against new evidence.
- [ ] Distinguish recall from modification.
- [ ] Require evidence before changing durable facts.

### 7.2 Contradiction Handling

- [ ] Detect conflicting information.
- [ ] Preserve competing versions.
- [ ] Create supersession/revision relationships.
- [ ] Track confidence and provenance.
- [ ] Avoid destructive overwrites.

### 7.3 Reconsolidation

- [ ] Update memories when sufficient evidence accumulates.
- [ ] Preserve historical versions.
- [ ] Re‑evaluate associated edges when beliefs change.
- [ ] Prevent accidental rewriting of established history.

---

## Phase 8 — Cognitive Integration

### 8.1 Goals

- [ ] Add goal relevance to retrieval.
- [ ] Distinguish "relevant to the query" from "relevant to what the system is trying to accomplish."
- [ ] Test goal‑conditioned retrieval.

### 8.2 Working Memory

- [ ] Expand episodic context into explicit working memory.
- [ ] Track currently active concepts.
- [ ] Track currently relevant memories.
- [ ] Integrate activation and context.

### 8.3 Multi‑Hop Reasoning

- [ ] Add controlled graph traversal.
- [ ] Track traversal provenance.
- [ ] Bound traversal depth.
- [ ] Prevent associative explosion.
- [ ] Distinguish discovered relationships from established facts.

### 8.4 Autonomous Behavior — Optional

- [ ] Only add autonomous cycles if a consuming system actually needs them.
- [ ] Do **not** turn Resonance Memory itself into RFE‑Core2.
- [ ] Keep the MCP boundary clean.
- [ ] Keep autonomous cognition in the consuming agent/system.

---

## Cross‑Cutting Architecture Rules

### Persistence

- [ ] Keep Resonance Memory as one repository / one system.
- [ ] Keep responsibilities modular inside the repository.
- [ ] Preserve the MCP interface as the external boundary.
- [ ] Keep durable state separate from transient state.
- [ ] Persist memories, embeddings, learned edges, timestamps, provenance, and durable metadata.
- [ ] Never persist transient activation.
- [ ] Never persist temporary retrieval context unless explicitly promoted to durable memory.

### Time

- [ ] Treat time as a mathematical input.
- [ ] Do **not** require a permanent decay daemon.
- [ ] Use lazy evaluation.
- [ ] Use half‑life parameters.
- [ ] Clamp negative elapsed times.
- [ ] Keep different temporal processes independently configurable.

### Learning

- [ ] Semantic proximity ≠ learned association.
- [ ] Bootstrap edge ≠ learned association.
- [ ] Retrieval ≠ co‑activation.
- [ ] Co‑activation ≠ usefulness.
- [ ] Reading ≠ reinforcement.
- [ ] Reinforcement ≠ permanent strengthening.
- [ ] Strong associations must compete.
- [ ] Association strength must remain bounded.
- [ ] Learning must remain measurable and reversible where appropriate.

### Reliability

- [ ] MCP mutations should be idempotent.
- [ ] Prefer explicit request/event IDs.
- [ ] Maintain a bounded duplicate‑ID cache.
- [ ] Preserve provenance.
- [ ] Preserve mutation timestamps.
- [ ] Preserve event/request identifiers where appropriate.
- [ ] Make mutations transactional where possible.
- [ ] Use atomic temp‑file → rename writes for JSON persistence.
- [ ] Test interrupted writes.
- [ ] If using SQLite, enable WAL/journaling appropriately.
- [ ] Test recovery after simulated failure.

### Performance & Safety

- [ ] Bootstrap edges must obey normal competition/normalization.
- [ ] Bootstrap edges start weak.
- [ ] Bootstrap edges decay normally.
- [ ] Activation is never persisted.
- [ ] Soft‑pruned memories have their activation cache entries cleared.
- [ ] Prevent stale activation from resurrecting pruned memories.
- [ ] Require explicit reactivation/reinforcement before a pruned association participates again.
- [ ] Bound activation propagation depth.
- [ ] Bound activation cache size where necessary.
- [ ] Bound duplicate‑request cache size.
- [ ] Keep debug tracing configurable.
- [ ] Prevent instrumentation from becoming a production bottleneck.
- [ ] Measure storage growth and retrieval latency as the graph grows.

---

## Development & Scientific Validation Loop

For every mechanism:

1. **Hypothesis**
2. **Implement ONE mechanism**
3. **Write tests**
4. **Measure behavior**
5. **Deliberately break it**
6. **Find the failure mode**
7. **Fix it**
8. **Document what was learned**
9. **Only then** add the next mechanism

**Core principle**

Never implement a future phase just because you can see where it eventually needs to go.

The architecture can anticipate future mechanisms.

The code should **earn** them.

---

## Current Build Target

**Phase 0.1 ONLY**

    Phase 0.1
      │
      ├── Edge timestamps
      │   ├── last_updated
      │   └── last_accessed
      ├── Persist timestamps
      ├── Save‑time semantic neighbor discovery
      ├── K ≈ 5 bootstrap neighbors
      ├── Minimum cosine threshold
      ├── Bootstrap weight ≈ 0.01
      └── Distinguish bootstrap edges from learned associations

Then:

    0.1
      ↓
    0.2 Lazy decay
      ↓
    0.3 Mutation + idempotency
      ↓
    0.4 Soft pruning
      ↓
    0.5 Tests
      ↓
    GREEN
      ↓
    Phase 1

---

**End of Roadmap**
