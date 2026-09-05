# Resonance Memory — developer notes

An MCP memory server for local LLMs that a small model can't misuse. Pure Node standard
library + built-in `fetch` (Node 18+), no SDK. Speaks MCP over stdio as line-delimited
JSON-RPC 2.0. The graph/store is the **substrate**; the model only ever sees four verbs and
an opaque `id`.

## Files

| File | What it is |
|---|---|
| `server.js` | The MCP server. Four verbs: `save_memory`, `recall_memory`, `edit_memory`, `delete_memory`. |
| `record.js` | The shared record schema (incl. temporal fields and `embedding_version`), durable atomic writes, and the access sidecar. |
| `store.js` | `JsonlStore` — the storage backend behind the Store seam. Separate module so it's testable without the stdio loop. |
| `test.js` | Dependency-free test suite: `npm test`. |
| `package.json` | No dependencies — scripts only (`test`, `build`, `panel`, `mcp`, `seed`, `inspect`). Sole source of the version string; `server.js` reads it so `serverInfo` can't drift. |
| `field.js` | Associative layer (Phase 2a): kNN semantic graph over stored vectors; neighborhood expansion. |
| `ledger.js` | Hebbian sidecar (Phase 2b): co-activation reinforcement, bounded `cosine + 0.3·tanh(w)`, decay + prune. |
| `panel.js` | Local 127.0.0.1 control panel: field toggle, Connect/Disconnect, association graph view, heartbeat auto-shutdown. |
| `install.js` | Detect + wire into LM Studio / Claude Desktop MCP config (preserves other servers, leaves `.bak`). |
| `entry.js` | Bundle dispatch: `--mcp` → server, `--install`/`--uninstall` → installer, else → panel. |
| `build-exe.js` | Embed runtime assets → esbuild → Node SEA blob → postject → flip PE subsystem to GUI → stage `dist/`. |
| `embedded-assets.js` | **Generated** each build (gitignored): `demo-seed.jsonl` + `system-prompt.md` baked in as strings so the shipped exe is one self-contained file. |
| `inspect_sidecar.js` | Dependency-free telemetry for the Hebbian ledger. |
| `build-demo-seed.js` | Regenerates `demo-seed.jsonl` (synthetic, pre-embedded) via the embedder. |

## Store & embeddings

- Flat JSONL at `MEMORY_FILE_PATH` (default `~/.lmstudio/resonance-memory.jsonl`), plus two
  sidecars beside it: `<store>.assoc.json` (Hebbian weights) and `<store>.access.json`
  (access counts — kept out of the store so recall never rewrites it, see `BUG-002`).
  Both are regenerable: deleting them loses learned associations and access counts, never
  a memory.
- Embeddings via an OpenAI-compatible `/v1/embeddings` endpoint (default LM Studio on
  `localhost:1234`, `text-embedding-nomic-embed-text-v1.5`, 768-dim). Keyword-overlap fallback
  if the endpoint is down. The embedder is **not bundled** — the user downloads it via LM Studio;
  we depend on the `/v1/embeddings` *interface*, not a specific model (`EMBED_MODEL` env var).
- **Third-party attribution:** `nomic-embed-text-v1.5` is © Nomic AI, **Apache 2.0**
  (<https://huggingface.co/nomic-ai/nomic-embed-text-v1.5>). Not redistributed by this project.
  Apache 2.0 is one-way compatible with our AGPL-3.0, so bundling it later would be license-clean.
- Embed **once** at save; recall embeds only the query, then cosine vs stored vectors.

## Build

```
node build-exe.js
```

Produces a **single self-contained** `resonance-memory.exe` (Windows; ~89 MB, no Node needed):
the demo seed and system prompt are baked in, so `dist/` is just the exe — nothing loose to
ship, unzip, or place beside it. The source files stay the editable truth; only the *output* is
one file. Edit anything, re-run `node build-exe.js`, get a new exe. The build flips the exe's PE
subsystem console→GUI so a double-click opens the panel with no console window; MCP mode is
unaffected because the client pipes stdio. The macOS binary must be built on a Mac (SEA is
per-platform).

## Design invariants (do not violate)

The full, ratified spec is [`INVARIANTS.md`](https://github.com/SamuelJacksonGrim/resonance-memory-stack)
in the `resonance-memory-stack` repo. The load-bearing ones:

- **Four verbs, nothing more** in the public tool surface (the interface may get simpler,
  never more cognitively demanding).
- **Ranking = cosine only.** `importance`/`access_count` govern *retention*, never *retrieval
  order* — measured: adding a durability weight to cosine inverts rankings.
- **The Hebbian layer is discovery, not ordering.** Co-activation expands the candidate set;
  it never reorders the primary cosine result.
- **Embed once at save; server owns all metadata; a `Store` abstraction sits behind the verbs**
  so the backend (JSONL now, SQLite later — see `docs/proposed/0005`) can be swapped without
  changing the MCP API. The seam lives in `store.js`.
- **All store writes go through `writeFileDurable()`, and nothing on a read path writes to the
  store.** Both were violated once; see `BUG-001`/`BUG-002`.

## Where the work is planned

| Document | What |
|---|---|
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | **Start here** — the scope/status map and phase index; current work is Phase 0 |
| [`docs/phases/`](docs/phases/) | The buildable phase specs (`phase-0` … `phase-8`): scope, steps, per-phase metrics + tests |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Itemized work (`RM-00` … `RM-20`) with acceptance criteria |
| [`docs/BUGS.md`](docs/BUGS.md) | Known defects, fixed and open, with a watch list |
| [`docs/COMPETITIVE-ANALYSIS.md`](docs/COMPETITIVE-ANALYSIS.md) | Mem0 / Zep / Letta capability + pricing landscape, and our gaps |
| [`docs/proposed/`](docs/proposed/) | RFC-style designs with code and pseudocode |

Things a contributor should know before touching the code:

- **`proposed/0003` proposes amending the "ranking = cosine only" invariant** (hybrid
  retrieval). It ships flag-off and is promoted only on a measured A/B win. Don't flip a
  ranking default without that measurement.
- **Run `npm test` before pushing.** It's dependency-free and takes under a second.
- **A behaviour change isn't done until the docs describing that behaviour change with it.**
  Six claims in `docs/` went stale in a single session this way — see `BUG-006`. Grep for what
  you changed before you push, and never assert how the system behaves without re-opening the
  file that decides it.

## Cross-repo plan

This is **Phase 1** of the Resonance memory stack. The portable work-order (roadmap +
per-repo backlog + architecture invariants) lives at
https://github.com/SamuelJacksonGrim/resonance-memory-stack.

---

## Related

[[README]] · [[ARCHITECTURE]] · [[ROADMAP]] · [[BACKLOG]] · [[CLAUDE]] · [[CHANGELOG]] · [[BUGS]]
