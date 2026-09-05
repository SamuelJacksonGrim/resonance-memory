# Changelog

All notable changes to Resonance Memory are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to follow
[Semantic Versioning](https://semver.org/). The public tool surface — the four verbs
`save_memory` / `recall_memory` / `edit_memory` / `delete_memory` — is intended to stay
stable; sophistication grows in the substrate, not in the API.

## [Unreleased]

Beta-readiness pass:

### Changed
- **Relicensed GPL-3.0 → AGPL-3.0.** Closes the SaaS / network-use loophole in plain GPL: a
  hosted or networked derivative must now also release its source. `LICENSE`, `package.json`
  (`AGPL-3.0-or-later`), and every per-file source header updated. This is the
  "revisit only if hosted resale looms" trigger the backlog pre-registered, now pulled.

### Added
- **Lazy wall-clock Hebbian decay (Phase 0.2 / I6).** Decay applies to `hebbian.weight` only
  (semantic never fades) and is **computed on read** via `effectiveHebbian(edge, now)` —
  `w · 2^(−Δt/H)`, `λ = ln(2)/H`, `Δt = max(0, now − last_updated)` in seconds. It is not
  written back (materialization-on-mutation is 0.3). The recall-epoch `tick()` is gone from
  the live path: reading no longer drives the decay clock. `reinforceRecall` is retained.
  Starting half-lives (parameters, not constants): constraint ~30 days, fact ~7 days,
  working ~1 hour. Per-type/namespace override via `opts.halfLives` / `hebbianDecayType`.
  Golden did not move (eval cases are single-recall on a fresh store; epoch ticks never
  fired, and Δt≈0 in an instant eval). See
  [`docs/phases/phase-0-edge-substrate.md`](docs/phases/phase-0-edge-substrate.md).
- **Save-time semantic edges (Phase 0.1).** On `save()` of a record with a real vector, persist
  its top-5 neighbors above cosine 0.25 into the EdgeStore (`semantic.value` + canonical
  `src_versions`, `hebbian.weight = 0`, origin `save-time-neighbor`). Embedder down → bind
  nothing. Recall is unchanged: `Related:` still comes from `field.js` at minSim 0.55 — the
  two thresholds serve different jobs and are not unified. Cost sweep
  (`eval/save-time-cost.js`): pre-declared p95 budget 250 ms; measured p95 at N=100k is
  77.1 ms → `RM-07` is **not** forced by the neighbor scan. See
  [`docs/phases/phase-0-edge-substrate.md`](docs/phases/phase-0-edge-substrate.md).
- **Unified edge store (`edges.js`, Phase 0.0).** One undirected edge record carrying two
  independent signals — `semantic` (derived cache, validated by `src_versions` vs each
  endpoint's `embedding_version`) and `hebbian` (source of truth; `last_updated` nests
  here because that's the only thing it clocks). Typed provenance (`origin` is how the
  edge came to exist; `migrated_from` is a separate fact). Existing `.assoc.json`
  sidecars migrate losslessly and one-way into `<store>.edges.json` (`kind: "resonance-edges"`;
  an old-format reader refuses rather than dropping edges). **On the live recall path:**
  Hebbian bonus/reinforce/save go through EdgeStore (`tick()` retired in 0.2); `ledger.js`
  is retired from recall. Semantic kNN + constraint-rescue still run in `field.js` at recall; save-time
  neighbor persist is the 0.1 entry above. See
  [`docs/phases/phase-0-edge-substrate.md`](docs/phases/phase-0-edge-substrate.md).
- **`embedding_version` on every memory** (Phase 0.0 schema). `record.js` `normalize()`
  backfills it to `1` for legacy rows. A successful `edit()` re-embed increments it; an
  embedder failure does not — the version moves in lockstep with the vector so a
  text-drifted-from-vector record stays distinguishable from a genuine re-embed
  (`BUG-008` class). See [`docs/phases/phase-0-edge-substrate.md`](docs/phases/phase-0-edge-substrate.md).
- **Association graph view** in the panel — a live 3D force-directed constellation of your
  memories; hover a dot to read it, line thickness = similarity, reinforced-by-use edges
  highlighted. Refreshes as the graph learns.
- **Demo graph** — a one-click, 100% synthetic sample (a fictional game dev's notes,
  pre-embedded in `demo-seed.jsonl`) so the panel shows non-obvious associative links on
  first launch with no setup and no real data. View-only; never written to your store.
- **"Support the Architect"** footer — Ko-fi + PayPal links.
- **Windowless single-click** — `resonance-memory.exe` opens the control panel with **no
  console window** (the build flips the Windows PE subsystem to GUI). One thing to click,
  no separate launcher, no stray terminal. The background process **shuts itself down ~12s
  after you close the tab** (heartbeat), so nothing lingers. MCP mode is unaffected.
- **`uninstall.bat`** — disconnects from LM Studio / Claude Desktop and points you to your
  data file (never auto-deletes your memories).
- **`build-demo-seed.js`** — regenerates the demo seed from synthetic text via the embedder.
- **GPL-3.0 licensing** — full `LICENSE` at the repo root plus per-file copyright headers; the
  build collapses them to a single notice in the bundle.
- **Planning docs** — [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/BACKLOG.md`](docs/BACKLOG.md)
  (`RM-00`…`RM-20`), [`docs/COMPETITIVE-ANALYSIS.md`](docs/COMPETITIVE-ANALYSIS.md), and
  [`docs/proposed/`](docs/proposed/) design docs covering the write path (extraction, dedup,
  supersession), temporal metadata, hybrid retrieval, the store abstraction, and the
  evaluation harness.

- **Temporal groundwork (`RM-04`).** Memories now carry `valid_from` / `valid_to` /
  `last_confirmed`, recall answers from the ones still marked current, and superseded ones are
  kept rather than deleted — surfacing only when you ask about the past. **Nothing sets a
  memory superseded yet**; the detection that decides *when* one fact replaces another is
  `RM-03`, still to come. This release is the schema and the plumbing under it.
  Saving text you've already saved word-for-word confirms the existing memory instead of
  storing a copy. Old stores gain the new fields on first read; **no migration step**.
- **`test.js`** — a dependency-free test suite (`npm test`), plus a `package.json` so the
  usual entry points (`npm test`, `npm run build`, `npm run panel`) work.

### Fixed
- **Your memories can no longer be truncated by a crash.** Store writes replaced the live file
  in place, so a crash or power loss partway through could leave it empty. Writes are now
  atomic (temp → fsync → rename). Same fix applied to the Hebbian ledger. (`BUG-001`)
- **Recall no longer rewrites the entire memory file.** Every `recall_memory` used to re-serialize
  the whole store just to bump an access counter — O(store) work on a *read*, and a whole-file
  data-loss window. Access counts moved to a sidecar; recall now performs **zero** writes to
  the store in steady state. (`BUG-002`)

See [`docs/BUGS.md`](docs/BUGS.md) for the full write-up and the open watch list.

### Changed
- **Association graph is now 3D.** Memories are placed by association: each semantic/Hebbian
  link is a spring whose rest length shrinks as similarity rises, so related memories cluster
  and unrelated ones stay reachable only through what bridges them. Drag to rotate. More-
  connected memories carry more mass and draw larger.
- **The graph no longer re-settles on a timer.** Node positions persist across polls; the
  layout re-settles only when the set of memories changes. The render loop idles to zero CPU
  once settled.

## [0.1.0] - 2026-07-26

First packaged, double-click build. Everything below is the baseline going forward.

### Added

- **Four-verb MCP memory server** (`server.js`) a small local model cannot misuse:
  `save_memory`, `recall_memory`, `edit_memory`, `delete_memory`, spoken over stdio as
  JSON-RPC 2.0. The model only ever sees the four verbs and an opaque `id`.
- **Embed-on-save.** Each memory is embedded once at save time and the vector stored in
  the record; recall embeds only the query, then ranks by cosine. No re-embedding the
  whole store on every recall.
- **Server-owned metadata** (`id`, timestamps, `access_count`, `importance`, `deleted`),
  never assigned by the model. Soft delete + startup `vacuum()`.
- **Swappable store** (`JsonlStore`) behind the verbs, so the JSONL backend can be
  replaced later without touching the MCP API.
- **Ranking is cosine only.** Importance/recency govern retention, never retrieval order.
- **Associative field** (`field.js`, opt-in) — a kNN semantic graph built from the stored
  vectors (no extra LLM calls); recall can surface a related-memory neighborhood, not just
  a flat list. Measured kNN edge precision k=2 = 0.90 vs 0.20 chance.
- **Hebbian reshaping** (`ledger.js`, opt-in) — a sidecar that reinforces co-recalled
  memories (provenance-discounted so it learns from your queries, not its own guesses),
  with a bounded `cosine + 0.3·tanh(weight)` blend, decay, and pruning.
- **Zero-terminal control panel** (`panel.js`) — a local 127.0.0.1 page with a live toggle
  for the associative field and one-click Connect/Disconnect for your AI app.
- **Auto-installer** (`install.js`) — detects LM Studio and Claude Desktop, wires the
  server into their MCP config, preserves other servers, and leaves a `.bak`.
- **Single executable** (`resonance-memory.exe`, Node SEA via `build-exe.js`) — no Node install
  required. `resonance-memory.exe` opens the panel; `resonance-memory.exe --mcp` runs the server;
  `--install` / `--uninstall` are also available on the CLI.
- **Proactive save/recall nudge** — the four tool descriptions now encode *when* to act
  (save durable facts proactively with anti-spam guards; recall at conversation start and
  on back-references), plus an optional `system-prompt.md` for weaker models.
- **Telemetry** (`inspect_sidecar.js`) — dependency-free inspection of the association
  ledger: breathing, high-weight/low-cosine "semantic leaps", provenance, and size.

### Known limitations

- The executable is **unsigned** — Windows SmartScreen / macOS Gatekeeper will prompt to
  "run anyway" on first launch.
- The **macOS binary must be built on a Mac** (SEA is per-platform); only the Windows
  build ships today.
- The data directory currently defaults to `~/.lmstudio/…` even for Claude-only users.
- The associative field is **off by default** pending validation on a real corpus.

---

## Related

[[README]] · [[ROADMAP]] · [[BACKLOG]] · [[BUGS]] · [[DEVELOPERS]]
