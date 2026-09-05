# Changelog

All notable changes to Resonance Memory are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to follow
[Semantic Versioning](https://semver.org/). The public tool surface — the four verbs
`save_memory` / `recall_memory` / `edit_memory` / `delete_memory` — is intended to stay
stable; sophistication grows in the substrate, not in the API.

## [Unreleased]

### Added
- **RM-07 slice 2b — sovereignty export.** `--export` writes a ZIP64 zip
  (default dest Desktop, `--name` / `--out`, never-overwrite `Name (2).zip`)
  containing `memories.jsonl` (machine interchange, embeddings as JSON arrays —
  a competitor reads this without our exe), `memories/YYYY/MM/DD/<id>-<slug>.json`
  (human, no vectors), `catalog.txt`, `edges.json` (Hebbian; `processed_ids`
  omitted), `manifest.json` (`layout: "memories/YYYY/MM/DD"`), and `README.txt`.
  `--export-jsonl` stays as the raw scripting primitive. Zero-dep writer
  (`zip.js`: `createDeflateRaw` + `zlib.crc32` + stream to `.zip.tmp` + rename;
  ZIP64 extra + EOCD + locator on every archive). READ-ONLY; not a fifth MCP
  verb. We do not sanitize the export. 50k/768-d proof: **34.3 s**, 387 MB zip,
  50k/50k lossless, Windows `ZipFile.OpenRead` 50,005 entries; synthetic ZIP64
  **70,000** entries. Panel button is slice 2c.
- **RM-07 slice 3 — RM-00 golden on SqliteStore.** `eval/run.js --store sqlite`
  (also `RESONANCE_STORE=sqlite`; `--store` wins) runs the same corpora through
  `SqliteStore` behind the Store seam — same `memory-core.js`, no forked recall
  path. Offline + deterministic (vectors from `eval/embeddings.cache.json`).
  The sqlite gate is two-sided parity against `golden.json`; `--accept` is
  jsonl-only. **27/31 identical case-for-case, no flips.** Cache embeddings
  are already exact f32, so Float32 BLOB packing is lossless on this embedder;
  no cosine-tolerance was added. JSONL stays default (switch is slice 4, after
  2b export).
- **RM-07 slice 2a — streaming JSONL→SQLite migrator.** Opt-in CLI
  (`node entry.js --migrate` / `npm run migrate`). 10-step protocol: stream
  line-at-a-time into `.db.migrating` (never `readFileSync` — that is the S1
  834 MB wall), preserve ids, fold AccessLog once at ingest (BUG-007),
  count-verify, WAL checkpoint, atomic rename to `.db`, **then** JSONL →
  `.jsonl.bak`. The `.bak` is a recovery snapshot, not the sovereignty export
  (that's slice 2b). Failure before the `.db` rename leaves the JSONL live;
  kill-9 is a test. Not auto-run on server startup. 50k/768-d proof:
  **lossless in 2.5 s** against a 785 MB JSONL that `readFileSync` cannot
  load. JSONL stays the default backend; golden unmoved.
- **RM-07 slice 1 — `SqliteStore` drop-in.** Selectable backend (`RESONANCE_STORE=sqlite`
  / live-config `store`); JSONL stays default. `node:sqlite` `DatabaseSync`, WAL +
  `synchronous=FULL`, embeddings as Float32 BLOBs, in-process cache, JS cosine (no
  sqlite-vec). Opaque ids preserved; `created` is a real column; access counts live
  in the row (`SqliteStore` never constructs `AccessLog`). Conformance suite proves
  JsonlStore ≡ SqliteStore on save/recall/edit/delete/vacuum. Product S1: **loads
  50k and 100k** (JSONL cannot); field-off recall p95 **49.6 ms @50k, 96.4 ms @100k**.
  Export, default switch, edges-in-db, `searchDense` are later slices.

### Changed
- **I5 restated** to match ARCHITECTURE/ROADMAP: durable writes; no *unbounded* /
  full-corpus rewrite on a read path. Bounded atomic retention UPDATE of the
  returned ids is permitted (JSONL = AccessLog sidecar; SQLite = in-table
  `UPDATE`). CLAUDE.md / AGENTS.md brought in line.
- **`package.json` `engines`** `>=18` → `>=22.5` (`node:sqlite` floor). esbuild
  `--target` follows (`node22`).

Beta-readiness pass:

### Changed
- **Relicensed GPL-3.0 → AGPL-3.0.** Closes the SaaS / network-use loophole in plain GPL: a
  hosted or networked derivative must now also release its source. `LICENSE`, `package.json`
  (`AGPL-3.0-or-later`), and every per-file source header updated. This is the
  "revisit only if hosted resale looms" trigger the backlog pre-registered, now pulled.

### Added
- **RM-01.c Tier 2 opt-in LLM extraction.** Off by default (RM does the work; a
  weak local model can extract worse than Tier 0/1). Capability-detect: MCP
  sampling **or** a non-embedding chat model at the configured endpoint. Visible
  panel toggle, surfaced when a capable model is detected. One ADD-only call on
  the already-guarded text; any failure/timeout/garbage degrades silently to
  Tier 0/1 — a save never fails or hangs because extraction did. PII is refused
  before any LLM call. `eval/corpora/messy-hard.jsonl` is the stick (`eval/messy`
  is already maxed by 01.b). Live A/B (`openai/gpt-oss-20b`, temperature 0) in
  [`eval/RESULTS.md`](eval/RESULTS.md). Golden unmoved (Tier 2 is off on that
  path). RM-01 is done.
- **RM-01.b write-side extraction (Tier 0 + Tier 1, no LLM).** Always-on at
  `save()`: collapse whitespace, strip leading filler openers and assistant-aimed
  imperatives (full phrases, not 0001's short `^(i think )`), split on `; ` /
  ` and also ` only when both halves stand alone, refuse secret/PII shapes
  (store nothing — refusal, not redaction). Clean facts pass through
  byte-identical. `extraction_recall` added to the reporting registry (anti-cheat
  for vacuous precision). **A/B vs the 01.a bar:** `extraction_precision`
  0.2609 → **1.0000**, `extraction_recall` **1.0000**, `recall@5` held at
  **1.0000**, `pii_refusal_rate` 0 → **1.0000**. Golden unmoved. See
  [`eval/RESULTS.md`](eval/RESULTS.md) RM-01.b.
- **RM-01.a measurement seed (write-side extraction).** `extraction_precision`
  in the reporting-metric registry plus `eval/corpora/messy.jsonl` (filler
  openers, assistant-aimed imperatives, multi-fact splits, PII/secret
  refusals, clean controls). Distinct from the golden gate —
  `node eval/run.js` is unchanged ("No regressions vs golden"); `save()` /
  `memory-core.js` untouched. Pre-extraction baseline and the pre-declared
  RM-01.b bar (`extraction_precision ≥ 0.9` with Tier 2 off, recall@5 not
  lowered, write-latency p95 unchanged when Tier 2 off) live in
  [`eval/RESULTS.md`](eval/RESULTS.md).
- **RM-02.c `--dedup-existing` backfill.** Offline pass for stores written
  before 02.b. Dry-run is the default (`node entry.js --dedup-existing` /
  `npm run dedup-existing`); `--apply` performs it as one durable rewrite.
  Same `detectNearDuplicate` / `pickMergeSurvivor` / `mergeBandPatches` as
  `save()` — file-order, each record vs earlier survivors — so the offline
  pass and the write path cannot disagree. Restatement losers already on
  disk are superseded, not deleted (I8); vectorless rows are skipped if
  the embedder is down. Second `--apply` is a no-op. Measured on a pre-02.b
  `eval/duplicates` fixture: `duplicate_rate` 0.3182 → **0.0000**, `recall@5`
  held at **1.0000**. Golden unmoved. RM-02 is done. See
  [`eval/RESULTS.md`](eval/RESULTS.md).
- **RM-02.b cosine-banded dedup/merge at save.** First measured A/B in the
  project. After embed, `save()` compares the new vector to already-stored
  ones: cosine ≥ `DEDUP_HI` (0.95) is a restatement (bump `last_confirmed` +
  `access_count`, don't append — generalizes today's byte-identical confirm);
  band `DEDUP_LO..HI` (0.88–0.95) is a merge (keep the longer original text,
  union metadata, link the loser with `superseded_by` via `supersedePatches`;
  never a blend, never a hard delete). Below LO: append as before. No vector
  → append, don't crash. Thresholds are config (`RESONANCE_DEDUP_HI`/`LO` +
  live-config `dedup_hi`/`dedup_lo`), tuned on `eval/duplicates` (tea 0.9522
  is the tightest HI; controls ≤ ~0.69). **A/B vs the pre-declared bar:**
  `duplicate_rate` 0.3182 → **0.0000** (100% drop, bar was ≤ 0.1591) AND
  `recall@5` held at **1.0000** (controls not over-merged). Golden unmoved
  ("No regressions vs golden."). See [`eval/RESULTS.md`](eval/RESULTS.md).
- **RM-02.a measurement seed (write-path gap).** A reporting-metric registry in
  `eval/metrics.js` (`recall_at_k`, `duplicate_rate`) plus `eval/measure.js` and
  `eval/corpora/duplicates.jsonl`. Distinct from the golden contains/excludes
  gate — `node eval/run.js` is unchanged ("No regressions vs golden"); these
  numbers are the A/B 02.b compares against. Pre-dedup baseline:
  `duplicate_rate` 0.3182 (7/22 extras; the shipping exact-restatement path
  catches 1 byte-identical pair and zero paraphrases), `recall@5` 1.0000
  (17/17). Pre-declared RM-02 pass bar (before 02.b runs): dup-rate ≥50% down
  (→ ≤ 0.1591) AND recall@5 not lower. Product behaviour untouched.
- **Phase 0.6 threat-model sketch (design only).** On-paper analysis of the
  unified edge substrate: what can mint an edge, raise Hebbian weight, make a
  memory a constraint-rescue bridge, or survive indefinitely. The load-bearing
  property: semantic is a recomputable cache (version comparison against
  `embedding_version`); a poisoned reinforcement is a durable *false memory*
  nothing else encodes. Answers that change when learned weight enters rank
  are carried into `RM-16` as requirements of the Phase 2.2 promotion gate.
  `RM-16` is not implemented here. No code, no behaviour change; both gates
  reconfirmed green. See
  [`docs/proposed/0009-edge-threat-model.md`](docs/proposed/0009-edge-threat-model.md).
  **Phase 0 exit is met** (golden green + reliable; I6 held; I8 held for
  edges; migration lossless + one-way; signals stay separate).
- **Phase 0.5 test contract.** `test.js` is now the Phase 0 contract: every
  edge state-transition row (state change AND the `Writes?` column), every
  pre-declared failure signature, and interrupted/failed persistence atomic
  recovery. Section headers keyed to sub-phase / invariant. No behaviour
  change; golden unmoved. See
  [`docs/phases/phase-0-edge-substrate.md`](docs/phases/phase-0-edge-substrate.md).
- **Soft pruning + server-side reactivation (Phase 0.4 / I8).** An explicit
  `pruneSweep()` (MCP startup or on demand — never `recall`/`save`) marks an
  edge `pruned_at` only when it is **both** unreinforced (`effectiveHebbian <
  1e-6`) **and** semantically weak (`semantic.value < SEMANTIC_PRUNE_GATE`
  0.25, the save-time bind floor). An idle but semantically-strong edge stays
  so constraint-rescue cannot regress (RESULTS field experiment #2). The
  record is kept; `incident()` skips it. Hard drop is `EdgeStore.vacuum()`,
  also explicit. Reactivation is a consequence of `save`/`edit`/`reinforce`
  touching an endpoint: in-place, `created_at` preserved, Hebbian weight
  carried (not snapped to full), bounded `prune_count` history. No fifth
  tool. Golden did not move (eval never calls the sweep). See
  [`docs/phases/phase-0-edge-substrate.md`](docs/phases/phase-0-edge-substrate.md).
- **Materialize-on-mutation + MCP request-ID idempotency (Phase 0.3).** A reinforcing
  write first stores `effectiveHebbian(edge, now)` as `hebbian.weight`, then applies α,
  then stamps `hebbian.last_updated` — reinforcement cannot bypass accumulated decay
  (the "ghost weight" of adding α to an undecayed stored value after a long idle).
  Provenance is preserved. One MCP JSON-RPC request id = one mutation transaction:
  `server.js` extracts `req.id` and threads it into the four verbs; EdgeStore keeps a
  256-entry LRU of processed ids **inside** the sidecar (`processed_ids`) so one
  `writeFileDurable` commits the dedup record and the weight change together. No id
  (eval, tests, panel) applies normally. Golden did not move (Δt≈0 materialize is a
  no-op; eval carries no request ids). See
  [`docs/phases/phase-0-edge-substrate.md`](docs/phases/phase-0-edge-substrate.md).
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
