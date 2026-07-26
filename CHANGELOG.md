# Changelog

All notable changes to Simple Memory are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to follow
[Semantic Versioning](https://semver.org/). The public tool surface — the four verbs
`save_memory` / `recall_memory` / `edit_memory` / `delete_memory` — is intended to stay
stable; sophistication grows in the substrate, not in the API.

## [Unreleased]

Beta-readiness pass:

### Added
- **Association graph view** in the panel — a live force-directed constellation of your
  memories; hover a dot to read it, line thickness = similarity, reinforced-by-use edges
  highlighted. Refreshes as the graph learns.
- **Demo graph** — a one-click, 100% synthetic sample (a fictional game dev's notes,
  pre-embedded in `demo-seed.jsonl`) so the panel shows non-obvious associative links on
  first launch with no setup and no real data. View-only; never written to your store.
- **"Support the Architect"** footer — Ko-fi + PayPal links.
- **`start-panel.vbs`** — launches the panel with **no console window**; the background
  process **shuts itself down ~12s after you close the tab** (heartbeat), so nothing lingers.
- **`uninstall.bat`** — disconnects from LM Studio / Claude Desktop and points you to your
  data file (never auto-deletes your memories).
- **`build-demo-seed.js`** — regenerates the demo seed from synthetic text via the embedder.

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
- **Single executable** (`memory.exe`, Node SEA via `build-exe.js`) — no Node install
  required. `memory.exe` opens the panel; `memory.exe --mcp` runs the server;
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
