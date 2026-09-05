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
| `package.json` | No dependencies — scripts only (`test`, `build`, `panel`, `mcp`, `seed`, `inspect`, `dedup-existing`). Sole source of the version string; `server.js` reads it so `serverInfo` can't drift. |
| `field.js` | Associative layer (Phase 2a): kNN semantic graph over stored vectors; neighborhood expansion. |
| `ledger.js` | Retired Hebbian sidecar (Phase 2b). Off the live path; kept as the epoch-decay reference. |
| `edges.js` | Unified persistent edge store (Phase 0): two-signal record + one-way `.assoc.json` → `.edges.json` migration. On the live recall path. Save-time semantic neighbors persist on `save()` (K=5, min cosine 0.25); recall still uses `field.js`. Hebbian decay is lazy wall-clock via `effectiveHebbian` (I6). Reinforce materializes the decayed weight before applying α; MCP request-ID dedup LRU lives in the sidecar (Phase 0.3). Soft prune (0.4 / I8) is an explicit `pruneSweep()` (not recall/save); reactivation is in-place on save/edit of an endpoint. |
| `extract.js` | RM-01.c Tier 2: opt-in LLM extraction (prompt, parser, sanity, chat/sampling, capability detect). Off by default. |
| `panel.js` | Local 127.0.0.1 control panel: field toggle, LLM-extraction toggle (surfaced when a capable model is detected), Connect/Disconnect, association graph view, heartbeat auto-shutdown. |
| `install.js` | Detect + wire into LM Studio / Claude Desktop MCP config (preserves other servers, leaves `.bak`). |
| `entry.js` | Bundle dispatch: `--mcp` → server, `--install`/`--uninstall` → installer, `--dedup-existing` → RM-02.c backfill (dry-run default), else → panel. |
| `dedup-existing.js` | RM-02.c CLI. Reports (or `--apply`s) cosine-banded restatements/merges on a store written before 02.b. Calls `dedupExisting()` in `memory-core.js` — same bands as `save()`, no second decision. |
| `build-exe.js` | Embed runtime assets → esbuild → Node SEA blob → postject → flip PE subsystem to GUI → stage `dist/`. |
| `embedded-assets.js` | **Generated** each build (gitignored): `demo-seed.jsonl` + `system-prompt.md` baked in as strings so the shipped exe is one self-contained file. |
| `inspect_sidecar.js` | Dependency-free telemetry for the Hebbian ledger. |
| `build-demo-seed.js` | Regenerates `demo-seed.jsonl` (synthetic, pre-embedded) via the embedder. |

## Store & embeddings

- Flat JSONL at `MEMORY_FILE_PATH` (default `~/.lmstudio/resonance-memory.jsonl`), plus two
  sidecars beside it: `<store>.edges.json` (unified edge table — Hebbian source of truth)
  and `<store>.access.json` (access counts — kept out of the store so recall never
  rewrites it, see `BUG-002`). A leftover `<store>.assoc.json` is legacy /
  read-only-for-migration. Both live sidecars are regenerable: deleting them loses
  learned associations and access counts, never a memory.
- Embeddings via an OpenAI-compatible `/v1/embeddings` endpoint (default LM Studio on
  `localhost:1234`, `text-embedding-nomic-embed-text-v1.5`, 768-dim). Keyword-overlap fallback
  if the endpoint is down. The embedder is **not bundled** — the user downloads it via LM Studio;
  we depend on the `/v1/embeddings` *interface*, not a specific model (`EMBED_MODEL` env var).
- **Third-party attribution:** `nomic-embed-text-v1.5` is © Nomic AI, **Apache 2.0**
  (<https://huggingface.co/nomic-ai/nomic-embed-text-v1.5>). Not redistributed by this project.
  Apache 2.0 is one-way compatible with our AGPL-3.0, so bundling it later would be license-clean.
- Embed **once** at save; recall embeds only the query, then cosine vs stored vectors.
  Save also runs cosine-banded dedup (RM-02.b): ≥ 0.95 restates, 0.88–0.95 merges
  (longer original text, loser linked with `superseded_by`). Thresholds are config
  (`RESONANCE_DEDUP_HI` / `RESONANCE_DEDUP_LO`).
- **`--dedup-existing`** (RM-02.c) is the offline pass for stores written before
  02.b. Dry-run default (`npm run dedup-existing`); `--apply` is one durable
  rewrite. File-order, each record vs earlier survivors — the same
  `detectNearDuplicate` decision as `save()`. Vectorless rows skip if the
  embedder is down. Second `--apply` is a no-op.

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
