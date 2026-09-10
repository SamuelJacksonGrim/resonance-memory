# CLAUDE.md

Guidance for AI assistants (Claude Code and others) working in this repository.

## What this is

**Resonance Memory** is an MCP (Model Context Protocol) memory server for local LLMs —
a persistent memory that survives across conversations, stored entirely on the user's
machine, tied to no account, sent to no cloud. It ships as a **single self-contained
executable** (~89 MB, no Node install needed on the user's machine) that runs in one of
three modes: an MCP server over stdio, a local browser control panel, or an installer.

The guiding design principle: **a small model cannot misuse it.** The model only ever
sees four verbs (`save_memory`, `recall_memory`, `edit_memory`, `delete_memory`) and an
opaque `id`. All the sophistication — embeddings, ranking, temporal supersession, the
associative field — lives in the *substrate*, never the interface. The interface may get
*simpler*, never more cognitively demanding.

This repo is **Phase 1** of a larger cross-repo effort. The ratified architecture spec,
roadmap, and per-repo backlog live in the companion repo
[`resonance-memory-stack`](https://github.com/SamuelJacksonGrim/resonance-memory-stack).

## Tech stack & constraints

- **Pure Node.js standard library + built-in `fetch`** (Node ≥ 22.5; `node:sqlite`
  for SqliteStore). Speaks MCP over stdio
  as line-delimited JSON-RPC 2.0.
- **Zero runtime dependencies.** `package.json` has no `dependencies` block — only scripts.
  Do not add npm dependencies without a very strong reason; the dependency-free property is
  load-bearing (it keeps the exe small, the build simple, and the test suite instant).
  Build-time tools (`esbuild`, `postject`) are invoked via `npx --yes`, not installed.
- **CommonJS** (`"type": "commonjs"`), not ESM.
- Runs on Windows, macOS, and Linux. The shipped binary is per-platform (SEA is per-platform;
  the macOS binary must be built on a Mac — a `macos-latest` CI runner counts, and is the
  shipping path since this project has no Mac hardware). See `docs/BUILDING.md`.

## Repository layout

### Core runtime (the source of truth — edit these)

| File | Role |
|---|---|
| `entry.js` | Bundle entry point / mode dispatch: `--mcp` → server, `--install`/`--uninstall` → installer, `--dedup-existing` → RM-02.c backfill (dry-run default; `--apply` mutates), `--migrate` → RM-07 slice 2a JSONL→SQLite (opt-in), `--export` / `--export-jsonl` → RM-07 slice 2b sovereignty export (read-only), `--import` → RM-17 restore (dry-run default), else → panel. |
| `dedup-existing.js` | RM-02.c CLI: scan a pre-02.b store, report (or apply) the same banded restatements/merges `save()` would have made. Thin wrapper over `dedupExisting()` in `memory-core.js` — no second decision. |
| `server.js` | The MCP server. Declares the four verbs (tool schemas + descriptions), wires the environment (network embed, live field toggle, live extract toggle, lazy ledger) into the shared core, and runs the JSON-RPC stdio loop. Reads the version from `package.json` so `serverInfo` can't drift. Outbound MCP `sampling/createMessage` is the Tier 2 path when the client advertised sampling. |
| `memory-core.js` | **The four cognitive verbs, as ONE implementation.** `createCore({ store, embed, fieldEnabled, getEdgeStore, dedupThresholds, fieldMinSim, extractEnabled, extract })` returns `{ save, recall, edit, remove }`. Also owns `dedupExisting` / `planDedupExisting` (RM-02.c) so the `--dedup-existing` backfill cannot fork the 02.b bands. Everything environment-specific is *injected*, nothing reached for — so `server.js` (network embedder) and `eval/pipeline.js` (cached embedder) build on the exact same code. This is deliberate: two copies of the recall path is the drift the RM-00 harness exists to catch. |
| `extract.js` | RM-01.c Tier 2: the opt-in LLM extraction pass (prompt, parser, sanity gate, chat POST, MCP sampling, capability detect). `save()` in `memory-core.js` is the only caller. Off by default. |
| `record.js` | The shared record schema (`normalize()`), durable atomic writes (`writeFileDurable()`), the access sidecar (`AccessLog`), and the lexical heuristics (constraint typing, historical-query detection, supersession cues + `detectSupersession`, cosine-banded `detectNearDuplicate` + `pickMergeSurvivor`). Owned here so the server and panel agree on a record byte-for-byte. |
| `store.js` | Store seam. `openStore()` is the default-switch path (RM-07 slice 4): SQLite is the default; existing JSONL auto-migrates on first open via the 2a protocol; a failed migrate fail-opens to JSONL. Slice 5 also ingests a leftover `.edges.json` into the edges table on that first-open. `RESONANCE_STORE=jsonl` / live-config `store: "jsonl"` pins JSONL. Same method surface so `memory-core.js` does not change. See `docs/proposed/0010`. |
| `store-sqlite.js` | RM-07 `SqliteStore`: `node:sqlite` `DatabaseSync`, WAL + `synchronous=FULL`, BLOB embeddings, in-process Float32 cache, in-table access counts. Never constructs `AccessLog`. |
| `migrate-sqlite.js` | RM-07 slice 2a: streaming JSONL→SQLite migrator (10-step protocol). Opt-in CLI (`--migrate`); `openStore()` calls the same function on first open of an existing JSONL (slice 4). `.bak` is a recovery snapshot, not the sovereignty export. |
| `zip.js` | Zero-dep ZIP64 writer (RM-07 slice 2b). `createDeflateRaw` (not `createDeflate` — zlib wrapper makes Explorer reject the entry), `zlib.crc32`, stream to `.zip.tmp` + rename at EOCD. ZIP64 extra + ZIP64 EOCD + locator on every archive (classic zip caps at 65,535 entries). |
| `export-memory.js` | RM-07 slice 2b sovereignty export. `--export` writes the zip bundle; `--export-jsonl` is the raw scripting primitive the zip wraps. READ-ONLY. Not a fifth MCP verb. The panel button (slice 2c) shells this same engine. |
| `import-memory.js` | RM-17 sovereignty import. `--import <zip-or-jsonl>` dry-run default; `--apply` restores. Direct store write (not `save()`). `--with-edges` opt-in for Hebbian. The panel button shells this same engine. Not a fifth MCP verb. |
| `entity.js` | Server-assigned person-entity ids + polarity features (I4). Closed-class relation (family/work/friend) + relation-anchored names; store-wide resolve so "sister Naima the chemist" and "call my sister Naima on Sunday" share E1 while coworker-Naima is E2. Feeds Related: `conflict` and Hebbian `pairScale` only — never primary cosine (I2/I3). |
| `embed-invoke.js` | Per-embedder input formatting. Nomic stays raw (verified best); Qwen queries get Instruct-query; jina gets `Query:`/`Document:`. Keyed off panel `config.embedder` then `EMBED_MODEL`. |
| `field.js` | Associative layer (Phase 2a): a kNN semantic graph over stored vectors, neighborhood expansion, and constraint rescue. No new embedding calls, no LLM extraction — built from vectors already stored at save. Related: minSim default 0.70; `conflict` callback drops entity/polarity mismatches. |
| `ledger.js` | Retired Hebbian sidecar (Phase 2b). Off the live recall/reinforce path as of Phase 0 Slice C; kept as the reference implementation of the epoch-decay math so tests can prove EdgeStore produces the same numbers. |
| `edges.js` | Unified persistent edge store (Phase 0): one undirected record, two independent signals (`semantic` derived cache + `hebbian` source of truth), typed provenance, one-way `.assoc.json` → `.edges.json` migration. **On the live recall path** — Hebbian bonus (via `effectiveHebbian`)/reinforce/save. Decay is lazy wall-clock half-life (I6); `tick()` is retired. A reinforcing mutation materializes the effective weight before applying α (0.3). MCP request-ID idempotency: a 256-entry LRU of processed JSON-RPC ids. **RM-07 slice 5:** persistence is an adapter — SqliteStore shares the `.db` (`edges` + `edge_processed_ids` tables; id claim + weight UPDATE are one txn); JsonlStore keeps the `.edges.json` sidecar. `effectiveHebbian` is never stored. Save-time semantic neighbors persist here (K=5, min cosine 0.25, Hebbian weight 0); `field.js` still computes semantic kNN at recall (minSim 0.70). Soft prune (0.4 / I8): `pruneSweep()` marks `pruned_at` only when both unreinforced and semantically weak (gate 0.25); hard drop is `vacuum()`, explicit. Reactivation is in-place on save/edit/reinforce of an endpoint. Phase 1 spreads activation over this table. |
| `warm.js` | Ephemeral spreading activation (Phase 1 / I7). In-process Map, never persisted. Seeded from retrieval cosine, spread over Phase 0 edges, attenuated per hop, lazy wall-clock half-life 300 s. Does not touch rank unless `RESONANCE_WARM_RANK` is on (exploratory, default off; shape via `RESONANCE_WARM_RANK_SHAPE`). Trace shape is the Phase 2.2 candidate record. |
| `panel.js` | The local `127.0.0.1` control panel (largest file): field toggle, LLM-extraction toggle (surfaced when a capable model is detected), Connect/Disconnect, embedder-tuning selector (`/api/embedder`), the 3D association-graph view, demo graph, first-run empty-store nudge (RM-20), **Export my memories** (slice 2c: confirm modal, POST `/api/export` shells `export-memory.js`, heartbeat pause + yield so a long zip cannot starve `/api/ping`), **Import memories** (RM-17: confirm modal, POST `/api/import` shells `runImport()`, `--with-edges` checkbox default-off, merge into a non-empty store an explicit opt-in — never pre-checked, mirrors the CLI `--merge` refusal), heartbeat auto-shutdown. **W-02:** Host must be loopback; Origin (when present) must be this panel; mutating POSTs require a per-process `X-Resonance-Token` baked into the page. No CORS. Not an MCP tool. |
| `install.js` | Detect + wire into LM Studio / Claude Desktop MCP config. Preserves other configured servers, leaves a `.bak`. |
| `inspect_sidecar.js` | Dependency-free telemetry for the Hebbian ledger. |

### Build & assets

| File | Role |
|---|---|
| `build-exe.js` | The build. Embeds runtime assets → esbuild bundle → Node SEA blob → postject inject → OS finish (Windows PE flip / macOS ad-hoc codesign / chmod +x) → stage `dist/`. `--target win\|linux\|macos`; refuses to cross-compile. |
| `ci/smoke-exe.js` | RM-11 CI smoke: spawn a SEA binary `--mcp`, feed initialize + `tools/list`, assert `serverInfo.name` and exactly the four verbs, timeout-kill. A hang must not ship. |
| `ci/release-meta.js` | RM-11 CI: tag vs `package.json`, runner arch/Node-floor asserts, `SHA256SUMS`, Release notes. |
| `.github/workflows/ci.yml` | Always-on PR/main gate. `ubuntu-latest`, Node 24: `node test.js` + `node eval/run.js`. Complements the release matrix; does not build binaries. Checks UI: `CI / gate`. |
| `.github/workflows/release.yml` | RM-11 release matrix. `v*` tag (or `workflow_dispatch`): gate → native build on windows/ubuntu/macos-latest → smoke → GitHub Release. The macOS binary is made here; this project has no Mac hardware. |
| `build-demo-seed.js` | Regenerates `demo-seed.jsonl` (synthetic, pre-embedded) via the embedder. |
| `demo-seed.jsonl` | The synthetic demo graph (a fictional game dev's notes). **Tracked** and shipped — it's the first-launch showcase. 100% synthetic; never real user data. |
| `system-prompt.md` | Optional copy-in system prompt for weaker models that forget to call tools. Baked into the exe. |
| `sea-config.json` | Node SEA config (points at `build/bundle.js`). |
| `embedded-assets.js` | **Generated every build (gitignored).** Bakes `demo-seed.jsonl` + `system-prompt.md` in as strings so the exe is one self-contained file. Do not edit; do not commit. |
| `uninstall.bat` | Windows uninstaller (disconnects, points to the data file, never deletes memories). |

### Tests, eval & docs

| Path | Role |
|---|---|
| `test.js` | The dependency-free unit/regression suite (`npm test`). Runs in under a second. |
| `eval/` | **RM-00**, the evaluation harness — the measurement system the roadmap depends on. `eval/pipeline.js` wires `memory-core.js` to a cached embedder; `eval/run.js` runs the corpora and gates against `golden.json`. Reporting metrics (`recall_at_k`, `duplicate_rate`, `extraction_precision`, `extraction_recall`, `mrr`, `staleness_rate`, `false_supersession`) live in a registry in `eval/metrics.js` and run via `eval/measure.js` — they are A/B numbers, not the golden gate. S1 scale (needle-in-haystack at 1k–100k) is `eval/substrate/scale.js`. See `eval/README.md`. |
| `docs/ROADMAP.md`, `docs/BACKLOG.md` | Phased plan and itemized work (`RM-00`…`RM-20`) with acceptance criteria. |
| `docs/BUGS.md` | Known defects (fixed and open) with a watch list. `BUG-001`/`BUG-002`/`BUG-006` are referenced throughout the code. |
| `docs/proposed/` | RFC-style designs (`0001`–`0007`) with code and pseudocode. |
| `docs/COMPETITIVE-ANALYSIS.md` | Mem0 / Zep / Letta landscape and our gaps. |
| `README.md` | User-facing overview. `DEVELOPERS.md` | Condensed developer notes (this file is the fuller version). `CHANGELOG.md` | Keep-a-Changelog format. |

## Commands

```bash
npm test          # run the full test suite (node test.js) — fast, dependency-free
npm run mcp       # run the MCP server on stdio (node server.js)
npm run panel     # open the control panel locally (node panel.js)
npm run build     # build the single-file executable for this OS (node build-exe.js)
npm run seed      # regenerate demo-seed.jsonl (needs a live embedder)
npm run inspect   # Hebbian ledger telemetry
npm run dedup-existing            # RM-02.c backfill dry-run (mutates nothing)
npm run dedup-existing -- --apply # perform the plan as one durable rewrite
npm run migrate                   # RM-07 slice 2a: stream JSONL → sibling .db (opt-in)
npm run export                    # RM-07 slice 2b: sovereignty zip (Desktop; --name / --out)
node entry.js --export-jsonl      # raw memories.jsonl (scripting primitive)
npm run import -- <zip>           # RM-17 dry-run (writes nothing)
npm run import -- <zip> --apply   # restore into an empty store; --merge / --with-edges
npm run eval      # run the RM-00 eval harness (offline, deterministic; sqlite default)
npm run eval -- --accept        # lock the current scorecard in as golden.json (needs --store jsonl)
npm run eval -- --filter <id>   # run only cases whose id starts with <id>
npm run eval -- --store jsonl   # RM-07: JSONL path (still 27/31; --accept is jsonl-only)
npm run measure   # reporting metrics (recall@k, duplicate_rate, …); not the golden gate
```

`npm test`, `npm run eval`, and `npm run measure` are **offline and deterministic** — they
read `eval/embeddings.cache.json` and never touch the network. Refreshing the cache for a
new golden case: `EVAL_REFRESH=1 npm run eval -- --store jsonl`. For a measurement corpus (`duplicates`):
`EVAL_REFRESH=1 npm run measure`. Then commit the cache diff.

## How it works (data flow)

1. **Save**: `save_memory({ content })` → **RM-01.b Tier 0** (always on, no LLM): collapse
   whitespace, strip leading filler openers ("I think you should know that…", "just so
   you're aware", "FYI", stacked) and assistant-aimed imperative framing ("remember to
   remind me", "make sure you", "don't forget to", "be sure to"), then split on `; ` /
   ` and also ` only when both halves stand alone (over-split is worse than no-split —
   "…and also with honey" stays one fact). Clean facts pass through byte-identical.
   **Tier 1** (always on): refuse secret/PII shapes — API keys (OpenAI `sk-` /
   `sk-proj-`, Anthropic `sk-ant-`, Google `AIza…`, Stripe `sk_live_`/`rk_live_`,
   Groq `gsk_`, HuggingFace `hf_`, Slack `xox*`/`xapp-`), passwords/passphrases
   assigned with `:`/`=`, 13–16-digit cards, AWS `AKIA`/`ASIA`, PEM / OpenSSH
   private keys, GitHub `ghp_`/`github_pat_`, JWTs (`eyJ….….…`). Store nothing,
   return a clear refusal. Refusal, not redaction: a fact mixed with a secret
   is store-nothing. Match the token shape, not the English — digit traps
   (`4821`, `1500mg`) and prose ("the secret is browning the butter", "my
   password manager is Bitwarden") do not trip. Stripe publishable `pk_live_`
   is not a secret and is not refused. **Tier 2 (opt-in, off by default):**
   a single-pass ADD-only extraction call on the already-normalized, already-guarded
   text. Off by default is a deliberate identity choice: RM does the work; a weak local
   model can extract *worse* than Tier 0/1, so this is a conditional bonus the user has
   to turn on, never a silent default. A capable path is (1) the MCP client advertised
   `sampling` at initialize, or (2) the configured inference endpoint serves a
   non-embedding chat model (`GET /v1/models`). If neither, Tier 2 cannot run (honest
   capability limit). The panel surfaces the toggle when a capable model is detected
   ("a capable model is available — enable LLM extraction?"). Any failure, timeout,
   missing capability, or malformed output degrades silently to the Tier 0/1 facts — a
   save never fails or hangs because extraction did. PII refusal still runs FIRST: a
   secret is never sent to the LLM. Each resulting fact is its own record. Then: if a
   current memory is byte-identical, confirm it (`last_confirmed` + `access_count`)
   instead of appending. Otherwise embed the (extracted) text once (via an
   OpenAI-compatible `/v1/embeddings` endpoint, default LM Studio on `localhost:1234`,
   `text-embedding-nomic-embed-text-v1.5`, 768-dim) → cosine-banded dedup against
   already-stored vectors (RM-02.b): cosine ≥ `DEDUP_HI` (0.95) is a restatement (same
   confirm, no append); `DEDUP_LO..HI` (0.88–0.95) is a merge (keep the longer original
   text, union metadata, link the loser with `superseded_by` — never a hard delete). No
   vector (embedder down) → skip compare, append, don't crash. Thresholds are config
   (`RESONANCE_DEDUP_HI`/`LO` + live-config `dedup_hi`/`dedup_lo`), tuned on
   `eval/duplicates`. Then RM-03 cue-gated supersession, then append. A record that got
   a real vector also binds its top-K semantic neighbors (default K=5, cosine ≥ 0.25;
   `RESONANCE_SAVE_K` / `RESONANCE_SAVE_MIN_COS`) into the
   EdgeStore; Hebbian weight starts at 0. Recall does not read those edges yet.
   Stores written *before* 02.b still carry the extras: `--dedup-existing` (dry-run
   default; `--apply` to mutate) runs the same bands over the current store, file
   order, one durable rewrite. Not a fifth verb — a CLI maintenance path.
2. **Recall**: `recall_memory({ query })` → embed only the query → cosine-rank stored
   vectors → return the top-k, each prefixed with `[id N]`. Keyword-overlap fallback if the
   embedder is unreachable. With the field on, a `Related:` section is appended from the
   associative graph (additive; never reorders the primary result). `RESONANCE_WARM_RANK`
   (default off) is an exploratory combiner that may reorder primary (`additive` by
   default; `RESONANCE_WARM_RANK_SHAPE` selects rrf / ranknorm / l1 / multiplicative
   for Lane B research — see `combiner-research.md`); it is not the default and is
   not the Phase 2.2 promotion.
3. **Edit/Delete**: `edit_memory` replaces text + re-embeds; `delete_memory` is a *soft*
   delete (`deleted: true`), compacted at next startup via `vacuum()`.

### Storage

- **SQLite default (RM-07 slices 4–5): one `.db` file.** Memories, access
  counts, and learned associations live in `<stem>.db`. `config.json` stays a
  sidecar (prefs ≠ memory). JsonlStore (the pin / fail-open path) still uses
  two regenerable sidecars beside the JSONL (deleting them loses learned
  associations / access counts, never a memory):
  - `<store>.edges.json` — unified edge table (`edges.js` EdgeStore) for
    JsonlStore. Hebbian weights are the source of truth; semantic scores are a
    derived cache, filled at save-time for top-K neighbors (default K=5, min cosine 0.25).
    Discovery bonus uses `effectiveHebbian` (wall-clock half-life, computed on
    read, not stored). A reinforcing mutation materializes that computed weight,
    then applies α (Phase 0.3). Processed MCP request ids live in the same
    persist (`processed_ids`, LRU 256) so a retry cannot double-apply. On
    SQLite the id claim and the weight UPDATE COMMIT together (slice 5
    atomicity fix). Soft prune (Phase 0.4 / I8) marks `pruned_at` on an
    explicit `pruneSweep()` (MCP startup or on demand) only when the edge is
    both unreinforced and below semantic 0.25; the record is kept until an
    explicit `vacuum()`. A `save`/`edit` touching an endpoint revives in place.
    Recall still rebuilds semantic kNN in `field.js` (minSim 0.70) and does not
    read the cached semantic signal yet. A leftover `<store>.assoc.json` from
    an older build is **legacy / read-only-for-migration**: on first load, if
    `.edges.json` is missing, those weights are copied in one-way and the old
    file is left untouched so a downgraded exe still reads its own stale sidecar.
    First-open of a SqliteStore with a leftover `.edges.json` and an empty
    edges table ingests it (count-verify, sidecar → `.bak`, fail-open if
    missing).
  - `<store>.access.json` — access counts (`AccessLog` in `record.js`), kept out of the
    JSONL store so a recall never rewrites the JSONL file (see `BUG-002`). Lives only
    next to a JsonlStore. SqliteStore keeps `access_count` / `last_access` **in the
    row** and never constructs `AccessLog` (BUG-007); a leftover `.access.json` next
    to a `.db` is ignored.
- **Default backend is SQLite (RM-07 slice 4).** `openStore()` walks the
  configured `MEMORY_FILE_PATH` (still a `*.jsonl` path) with no explicit
  override:
  1. `RESONANCE_STORE=jsonl` (or live-config `store: "jsonl"`) → JsonlStore.
     The pin stays. `RESONANCE_STORE=sqlite` forces sqlite.
  2. `<stem>.db` exists and opens → SqliteStore. A leftover `<stem>.jsonl`
     (2a crash-between-step-7-and-8) is renamed to `.bak` now (finish step 8).
     Never dual-read.
  3. No `.db`, but `<stem>.jsonl` exists → **auto-migrate** via the 2a 10-step
     protocol (call `migrateJsonlToSqlite`, do not reimplement it), then open
     the `.db`. **Fail-open:** if migration throws before the atomic rename,
     keep the JSONL live, drop the temp, open JsonlStore. A failed auto-migrate
     must never block the user from their memories. Retry next open.
  4. Neither exists (new user) → fresh SqliteStore (`.db`).
  An empty `.db` beside a still-live JSONL is the slice-1 footgun, not live
  truth — drop the empty artifact and auto-migrate. WAL + `synchronous=FULL`;
  embeddings as Float32 BLOBs; in-process cache; opaque `id` preserved.
  RM-00: `node eval/run.js` (sqlite default) and `--store jsonl` both 27/31.
  **Downgrade honesty:** after a store is `.db`, an old exe opening the `.bak`
  sees a stale store. Recovery is `--export-jsonl` *before* downgrade, or keep
  the new exe. The `.bak` is not a two-way door. No "switch back to JSONL and
  dual-write" env.
- **JSONL→SQLite migrator (RM-07 slice 2a).** Same 10-step protocol the
  slice-4 auto-migrate calls. Opt-in CLI still exists: `node entry.js --migrate`
  / `npm run migrate`. Streams the JSONL line-at-a-time (never `readFileSync` —
  that is the S1 834 MB wall) into `<store>.db.migrating`, count-verifies, WAL
  checkpoints, atomically renames to `.db`, **then** renames the JSONL off
  `MEMORY_FILE_PATH` to `.jsonl.bak` (and the AccessLog sidecar to `.bak`).
  Ids, `created`, and `superseded_by` are preserved; access counts fold into
  the row **once** (BUG-007). Failure before the `.db` rename leaves the JSONL
  live; no resume-from-partial. The `.bak` is a *recovery snapshot*, not the
  sovereignty export (that's slice 2b `--export` / `--export-jsonl`). Do not
  dual-write JSONL after migration. Do not delete the `.bak`.
- **Sovereignty export (RM-07 slice 2b).** Opt-in CLI: `node entry.js --export`
  / `npm run export`. Writes a ZIP64 `.zip` (default dest **Desktop**, name
  `resonance-memories-<local-date>`, never-overwrite `Name (2).zip`) containing
  `memories.jsonl` (machine interchange, embeddings as JSON arrays — a competitor
  reads this without our exe), `memories/YYYY/MM/DD/<id>-<slug>.json` (human,
  no vectors), `catalog.txt`, `edges.json` (Hebbian from the table when sqlite,
  else the sidecar; `processed_ids` omitted),
  `manifest.json` (`layout: "memories/YYYY/MM/DD"`), and `README.txt`.
  `--export-jsonl` is the raw scripting primitive the zip wraps. READ-ONLY
  (never mutates the store). Whole store including deleted + superseded. We do
  **not** sanitize the export. Extract to a short path (Windows MAX_PATH).
  **Panel button (slice 2c):** "Export my memories" on the control panel,
  confirm modal (count, dest path, read-only, filename-preview note), POST
  `/api/export` writes the zip via this engine (server-writes-to-disk, not a
  browser download), toast + copy-path + Windows `explorer /select`. Pauses
  the panel heartbeat watchdog for the duration and yields the event loop
  (`setImmediate` every N records) so a 30–60s zip cannot `process.exit(0)`
  a truncated tmp. Empty store still exports (README + empty jsonl). User
  store only — never `demo-seed.jsonl`. **Not a fifth MCP verb.**
- **Sovereignty import (RM-17).** Opt-in CLI: `node entry.js --import <zip-or-jsonl>`
  / `npm run import`. Dry-run default (like `--dedup-existing`); `--apply`
  writes. Restore into an empty dest; `--merge` to add to a store that already
  has memories (same-id same-text skip, same-id different-text remap, dest
  kept). Direct store write — **not** `save()` — so ids, embeddings, and
  history survive and no embedder is required. Streaming (never `readFileSync`
  the jsonl). `--with-edges` restores Hebbian from a zip whose
  `manifest.format` is `resonance-memory-export`; a raw `.edges.json` is
  refused; dest-already-has-edges needs `--replace-edges`. That is the
  `0009` planted-sidecar refusal. Panel button shells the same engine
  (confirm modal, `--with-edges` checkbox default-off, heartbeat pause).
  **Not a fifth MCP verb.**
- Live runtime state (the field toggle, the extract toggle, plus `dedup_hi` /
  `dedup_lo`, and `store`) lives in `resonance-memory.config.json` **beside the data file**, so
  the panel toggle and the server read the same file — the field and extraction
  turn on/off with no client restart. A backend change needs a process restart.

### Environment variables

`MEMORY_FILE_PATH`, `RESONANCE_MEMORY_CONFIG`, `EMBED_ENDPOINT`, `EMBED_MODEL`,
`RESONANCE_MEMORY_FIELD` (default field state), `RESONANCE_FIELD_MUTUAL`,
`RESONANCE_FIELD_KSEARCH`, `RESONANCE_FIELD_MINSIM` (Related: kNN floor, default 0.70), `RESONANCE_CONSTRAINT_GATE`, `RESONANCE_DEDUP_HI`,
`RESONANCE_DEDUP_LO` (RM-02.b cosine bands; defaults 0.95 / 0.88, live-config
`dedup_hi` / `dedup_lo` win), `RESONANCE_EXTRACT_LLM` (Tier 2 default when no
config file; live-config `extract_llm` wins; **off**), `RESONANCE_EXTRACT_MODEL`
(preferred chat id), `RESONANCE_EXTRACT_TIMEOUT_MS` (interactive bound, default
8000), `RESONANCE_STORE` (`sqlite` default / `jsonl` pin; live-config `store` wins;
SqliteStore needs Node ≥22.5 for `node:sqlite`), `RESONANCE_WARM_FIELD` (Phase 1
activation compute, default **on**; `0`/`false`/`no` opt-out — does not rank),
`RESONANCE_WARM_RANK` (exploratory: put spread-activation into primary rank as
`cosine + 0.3·bonus`; default **off**; not the Phase 2.2 promotion),
`RESONANCE_WARM_RANK_WEIGHT` (combiner weight, default 0.3, same cap as Related:
maxBonus), `RESONANCE_WARM_RANK_SHAPE` (`additive` default / `rrf` / `ranknorm` /
`l1` / `multiplicative`; only consulted when rank is on; Lane B research, see
`combiner-research.md`), `RESONANCE_WARM_RANK_RRF_K` (RRF k, default 60),
`RESONANCE_WARM_TRACE` (stderr `[warm-trace]` JSON, default off),
`RESONANCE_SAVE_K` / `RESONANCE_SAVE_MIN_COS` (save-time bind; defaults 5 / 0.25;
live-config `save_k` / `save_min_cos`; eval pins the constants),
`RESONANCE_WARM_RECALL_BIND` (ephemeral seed-kNN unioned into spread at recall;
default **off**; does not persist). The embedder is **not bundled**
— we depend on the `/v1/embeddings` *interface*, not a specific model, so any
compatible embedding model can be swapped in.

## Design invariants — DO NOT VIOLATE

These are ratified in `INVARIANTS.md` in the `resonance-memory-stack` repo. The
load-bearing ones, enforced here:

1. **Four verbs, nothing more** in the public tool surface. The interface may get simpler,
   never more cognitively demanding. The model never sees embeddings, importance,
   timestamps, or any storage internal — only the four verbs and an opaque `id`.
2. **Ranking = cosine only.** `importance` / `access_count` govern *retention*, never
   *retrieval order*. This is measured, not stylistic: adding a durability weight to cosine
   inverts rankings. (`proposed/0003` proposes amending this for hybrid retrieval — it ships
   flag-off and is promoted only on a measured A/B win. Never flip a ranking default without
   that measurement.)
3. **The Hebbian/associative layer is discovery, not ordering.** Co-activation expands the
   candidate set (the `Related:` block); it never reorders the primary cosine result.
   Primary results are byte-identical whether the field is on or off. The field is *additive*
   and is wrapped in a `try/catch` that must never let it break recall.
4. **Embed once at save; the server owns all metadata; the model assigns none of it.** A
   `Store` abstraction sits behind the verbs (`store.js`) so the backend can be swapped
   without changing the MCP API.
5. **Durable writes; no *unbounded* write on a read path (I5).** Writes are atomic and
   durable. A read path must not perform an unbounded / full-corpus rewrite. Retention
   metadata (`access_count` / `last_access`) MAY be updated on recall if that update is
   bounded, atomic, and cannot truncate the store. **JSONL:** `writeFileDurable()`
   (temp → fsync → atomic rename) for mutations; AccessLog sidecar for recall (never
   rewrite the JSONL to bump a counter — `BUG-001` / `BUG-002`). **SQLite:** WAL +
   `synchronous=FULL`; recall is one `BEGIN`/`UPDATE`/`COMMIT` of the ~5 returned ids.
   `SqliteStore` never constructs `AccessLog` (BUG-007). Never use `fs.writeFileSync` to
   replace the JSONL store.

## Conventions

- **Record schema is defined once, in `record.js` `normalize()`.** Every field is
  backfilled on read, so this doubles as the migration path — an old record simply gains new
  fields on first load. There is no separate migration step; add new fields with a sensible
  default in `normalize()`.
- **Comments carry the *why*, densely.** The existing files explain measured findings, the
  bug that motivated a choice, and the invariant a line protects — match that density. Many
  constants (gates, thresholds) cite the experiment that set them; don't change a tuned
  constant without the corresponding measurement.
- **Server assigns metadata from text, never the model** — e.g. constraint typing
  (`detectConstraint`) and supersession are lexical heuristics computed server-side, per the
  small-model-safety invariant. A false-positive constraint only *widens* retrieval (cheap);
  it never deletes.
- **AGPL-3.0 per-file header** tops every source file; the build collapses them to a single
  notice in the bundle. Keep the header on new source files.
- **Repo hygiene:** LF line endings (`.gitattributes`), except `.bat` (CRLF) and
  `.command`/`.sh` (LF). User state (`*.jsonl` except `demo-seed.jsonl`, sidecars, `config.json`,
  `embedded-assets.js`, `build/`, `dist/`, the exe) is gitignored. The `eval/corpora/*.jsonl`
  fixtures and `demo-seed.jsonl` are the tracked exceptions.

## Before you push

- **Run `npm test`.** It's dependency-free and takes under a second. Run `npm run eval` too
  if you touched the recall path, the field, or the ledger — `golden.json` is the regression
  gate. CI also runs both on every PR and every push to `main`
  (`.github/workflows/ci.yml`, checks UI `CI / gate`).
- **A behaviour change isn't done until the docs describing that behaviour change with it.**
  Six claims in `docs/` went stale in a single session this way (`BUG-006`). Grep for what
  you changed, and never assert how the system behaves without re-opening the file that
  decides it (`memory-core.js`, `record.js`, `store.js`).
- **Keep `memory-core.js` the single implementation.** If you change the recall/save path,
  change it there — do not fork a copy into `eval/pipeline.js` or `server.js`. The RM-00
  golden is the proof the two callers never diverge.
- Bump the version in `package.json` (the sole source of the version string) when releasing,
  and record it in `CHANGELOG.md`.

## Git workflow

- Do not push directly to `main`. Develop on a feature branch, commit with clear messages,
  and open a PR only when explicitly asked.
- Do not create a pull request unless the user explicitly requests one.

---

## Related

[[ARCHITECTURE]] · [[ROADMAP]] · [[BACKLOG]] · [[BUGS]] · [[DEVELOPERS]] · [[CONTRIBUTING]] · [[proposed/README]]
