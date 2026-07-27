# Resonance Memory — developer notes

An MCP memory server for local LLMs that a small model can't misuse. Pure Node standard
library + built-in `fetch` (Node 18+), no SDK. Speaks MCP over stdio as line-delimited
JSON-RPC 2.0. The graph/store is the **substrate**; the model only ever sees four verbs and
an opaque `id`.

## Files

| File | What it is |
|---|---|
| `server.js` | The MCP server. Four verbs: `save_memory`, `recall_memory`, `edit_memory`, `delete_memory`. `JsonlStore` behind them. |
| `field.js` | Associative layer (Phase 2a): kNN semantic graph over stored vectors; neighborhood expansion. |
| `ledger.js` | Hebbian sidecar (Phase 2b): co-activation reinforcement, bounded `cosine + 0.3·tanh(w)`, decay + prune. |
| `panel.js` | Local 127.0.0.1 control panel: field toggle, Connect/Disconnect, association graph view, heartbeat auto-shutdown. |
| `install.js` | Detect + wire into LM Studio / Claude Desktop MCP config (preserves other servers, leaves `.bak`). |
| `entry.js` | Bundle dispatch: `--mcp` → server, `--install`/`--uninstall` → installer, else → panel. |
| `build-exe.js` | esbuild → Node SEA blob → postject → flip PE subsystem to GUI → stage `dist/`. |
| `inspect_sidecar.js` | Dependency-free telemetry for the Hebbian ledger. |
| `build-demo-seed.js` | Regenerates `demo-seed.jsonl` (synthetic, pre-embedded) via the embedder. |

## Store & embeddings

- Flat JSONL at `MEMORY_FILE_PATH` (default `~/.lmstudio/resonance-memory.jsonl`); Hebbian
  sidecar at `<store>.assoc.json`.
- Embeddings via an OpenAI-compatible `/v1/embeddings` endpoint (default LM Studio on
  `localhost:1234`, `text-embedding-nomic-embed-text-v1.5`, 768-dim). Keyword-overlap fallback
  if the endpoint is down.
- Embed **once** at save; recall embeds only the query, then cosine vs stored vectors.

## Build

```
node build-exe.js
```

Produces `resonance-memory.exe` (Windows; ~88 MB, no Node needed) and stages a clean `dist/`
with only the shippable files. The build flips the exe's PE subsystem console→GUI so a
double-click opens the panel with no console window; MCP mode is unaffected because the client
pipes stdio. The macOS binary must be built on a Mac (SEA is per-platform).

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
  so the backend (JSONL now, Lantern later) can be swapped without changing the MCP API.

## Cross-repo plan

This is **Phase 1** of the Resonance memory stack. The portable work-order (roadmap +
per-repo backlog + architecture invariants) lives at
https://github.com/SamuelJacksonGrim/resonance-memory-stack.
