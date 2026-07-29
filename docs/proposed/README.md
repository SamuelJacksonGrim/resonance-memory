# Proposed designs

RFC-style design documents. Each one states a problem, a design with real code or pseudocode,
the risks, and acceptance criteria. **Proposed ≠ decided** — these exist to be argued with
before anyone writes the implementation.

| # | Title | Backlog | Status |
|---|---|---|---|
| [0001](0001-write-pipeline.md) | Write pipeline: extraction, guarding, structuring | `RM-01` | proposed |
| [0002](0002-temporal-supersession.md) | Temporal metadata and supersession | `RM-03`, `RM-04` | proposed |
| [0003](0003-hybrid-retrieval.md) | Hybrid retrieval (semantic + keyword + graph) via RRF | `RM-05` | proposed ⚠️ |
| 0004 | *reserved* — scoping / multi-agent | `RM-06` | not drafted |
| [0005](0005-store-abstraction.md) | Store abstraction and the SQLite backend | `RM-07` | proposed |
| 0006 | *reserved* — decay, constraints, pruning | `RM-08` | not drafted |
| [0007](0007-eval-harness.md) | The evaluation harness | `RM-00` | proposed |

⚠️ **0003 touches a ratified invariant** (`ranking = cosine only`) and proposes a specific,
measured process for amending it. Read that section before implementing anything in it.

## Reading order

If you're picking this up cold:

1. **[0007](0007-eval-harness.md)** — why measurement comes first, and what it measures.
2. **[0002](0002-temporal-supersession.md)** — the headline capability gap vs Zep, and the
   cheapest to start (the schema half is a few hours).
3. **[0001](0001-write-pipeline.md)** — how facts get cleaned before they're stored.
4. **[0005](0005-store-abstraction.md)** — contains a latent data-loss bug worth knowing about
   now (every recall rewrites the whole store file).
5. **[0003](0003-hybrid-retrieval.md)** — the one with an invariant fight in it.

## Conventions

- **Four verbs, always.** If a design needs a fifth MCP tool, the design is wrong. Capability
  lives in the substrate; the interface may get simpler, never more demanding.
- **No unmeasured signal touches rank.** Anything affecting retrieval order ships behind a
  flag, off by default, until it wins on the golden set.
- **Nothing on the critical path requires a cloud.** LLM assistance is optional, local, and
  degrades silently.
- **Negative results are deliverables.** "We tried it and it lost" written down is worth more
  than an untested idea left open.
