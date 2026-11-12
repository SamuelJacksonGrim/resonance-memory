# Resonance Memory — architecture

The current runtime map and invariant definitions for this repository. Item acceptance belongs
to [BACKLOG](BACKLOG.md), route/status to [ROADMAP](ROADMAP.md), measurements to
[eval](../eval/README.md) and [research](research/), usage to [guides](guides/).

## 1. Runtime overview

Resonance Memory has two local memory representations. They share a product and distribution,
but neither is a mirror of the other.

| Representation | Durable state | Retrieval / writers | Boundary |
|---|---|---|---|
| **MCP store** | Memory records and learned edges in SQLite by default, with a supported JSONL adapter | `memory-core.js` implements the four verbs; import restores directly through the Store seam | The model calls `save_memory`, `recall_memory`, `edit_memory`, `delete_memory` with text/query/id. The substrate owns metadata and scoring. |
| **Memory folder** | Markdown files, an index, subject drawers and faded history | Folder recall scripts search the files; the model edits them under the installed filing rules; installer/cabinet scripts perform explicit setup/filing operations | Folder recall previews point to files. Its recall index is a derived cache, not the durable memory or a copy of the MCP database. |

```text
AI client -- MCP stdio --> server --> memory-core --> SQLite / JSONL + edges
                                      ^                   ^
                                      |                   |
                               cached eval          export / import

Claude Code -- plugin / installed hooks --> folder recall --> markdown folder
                                              ^                   ^
                                              |           model file edits / cabinet
                                              |
local app --> auto-recall proxy --> store recall + optional folder preview --> model server

panel --> client connection / installed-home management / memory-system setup
      --> store graph + export/import
```

The **panel** exposes setup and store operations in the browser. `install.js` connects MCP
clients; `install-home.js` places/updates the executable. The **memory-system installer** lays
down folder rules/templates and hooks without overwriting existing memories. The **Claude Code
plugin** packages the folder system and hooks for the project's memory folder or an explicit
pinned folder; its recall modules are checked copies of the originals. The **proxy** performs
per-message store recall and optional folder preview before forwarding to the model server.
It uses existing interfaces and adds no MCP verb.

**Store export/import** is a lossless transport for MCP records and optionally learned edges;
it does not serialize the separate markdown memory folder. Back up that folder as files.
The executable embeds the folder setup assets/scripts and cabinet package as well as the
MCP runtime; the plugin is a separate installation path.

The model does not assign substrate metadata or need embeddings/scores as tool arguments.
Historical store recall can display a supersession date. The four-verb MCP contract applies
to the store interface; CLI modes, filesystem edits, hooks and panel routes are distinct surfaces.

**Time is a function, not a process** in the substrate: no autonomous dream or decay daemon.
Operations observe time, compute temporal effects and persist mutations. Panel lifecycle
heartbeats and event-triggered folder index rebuilds are operational processes, not autonomous
memory consolidation. RM-10's proposed panel-idle trigger remains an unresolved design decision;
it is not a running consolidation mechanism.

Usage belongs to the [memory-system](guides/MEMORY-SYSTEM.md), [cabinet](guides/CABINET.md),
[auto-recall](guides/AUTO-RECALL.md) and [plugin](../plugin/README.md) guides. This document owns
the runtime boundaries and current mechanisms.

---

## 2. Design invariants (the shape is load-bearing)

The I1–I9 scheme, including I2b, is authoritative here. These definitions and their backing
code govern current work in this repository. The companion `resonance-memory-stack` carries
the earlier cross-repo plan for history. The implementation exception and the scope of
default versus experimental behavior are stated below.

**Held** = enforced by shipping code today. **Target** = a property a named phase must
establish; stated now, with its phase, precisely because an invariant claimed more strongly
than the code supports is worse than none — it stops anyone from looking.

| | Invariant | Status | Backed by |
|---|---|---|---|
| **I1** | **Four verbs, nothing more.** The public tool surface is fixed; new capability lands in the substrate, never a fifth tool. If a feature seems to need one, the design is wrong. | ✅ held | `server.js` tool schemas |
| **I2** | **No *unmeasured* signal touches rank.** Ranking is cosine today; a second arm may enter *only* on a measured A/B win, flag-off until then. `importance`/`access_count` govern *retention*, never *retrieval order* — measured: a durability weight on cosine inverts rankings. | ✅ held (amended) | `memory-core.js` recall; `proposed/0003` |
| **I2b** | **Access-frequency signals are telemetry only.** `access_count`/`last_access`/read frequency may be logged and charted; they may **not** feed rank, decay, reinforcement, or pruning. | ✅ held | `record.js` `AccessLog` (JSONL); `store-sqlite.js` in-table columns; `BUG-002` |
| **I3** | **The associative layer fails open.** The entire field/ledger path is wrapped in a `try/catch` that must never break recall; losing it degrades to plain cosine. | ✅ held | `memory-core.js` field block |
| **I4** | **Embed once at save; the server owns all metadata; the model assigns none of it.** A `Store` seam sits behind the verbs so the backend swaps without touching the MCP API. | ✅ held¹ | `memory-core.js` `save`; `store.js` |
| **I5** | **Durable writes; no *unbounded* write on a read path.** Writes are atomic and durable. A read path must not perform an unbounded / full-corpus rewrite (the BUG-001/002 class). Retention metadata (`access_count` / `last_access`) MAY be updated on recall if that update is bounded, atomic, and cannot truncate the store. **JSONL:** AccessLog sidecar (recall writes the sidecar, never the JSONL file); store mutations go through `writeFileDurable()`. **SQLite:** WAL + `synchronous=FULL`; recall is one `BEGIN`/`UPDATE`/`COMMIT` of the ~5 returned ids. | ✅ held¹ | `record.js` `AccessLog`; `store-sqlite.js` `applyRecall`; `BUG-001`/`BUG-002` |
| **I6** | **Reading does not drive the decay clock.** Co-recall *reinforcement* is retained (it is the differentiator); edge **decay** is lazy wall-clock, computed at access via `effectiveHebbian`, never stored, never ticked by recall count. A reinforcing mutation **materializes** that computed weight before applying α (Phase 0.3), so reinforcement cannot bypass decay. | ✅ held (Phase 0.2; materialize 0.3) | `edges.js` `effectiveHebbian` / `_bump`; `memory-core.js` recall (no `tick()`) |
| **I7** | **Activation never persists.** Spreading activation (Phase 1) is seeded per query, attenuated per hop, bounded, and never written to the edge store. | ✅ held (Phase 1) | `warm.js`; `memory-core.js` recall hook (no `save()`); `test.js` JSONL + SQLite schema scans |
| **I8** | **No silent removal.** *Record* deletes are soft (`deleted`, compacted at `vacuum()`) and supersession keeps a non-overlapping validity chain. *Edge* pruning is the same pattern: `pruneSweep()` marks `pruned_at` (record kept; `incident()` skips it); `EdgeStore.vacuum()` is the explicit hard drop. Never on `recall`/`save`. Reactivation is in-place on save/edit/reinforce of an endpoint, never a fifth tool. | ✅ held (records + edges, Phase 0.4) | `store.js` `vacuum`; `edges.js` `pruneSweep` / `vacuum`; `phases/phase-0` |
| **I9** | **Discovery nominates; it does not appoint.** The field/ledger *expand* the candidate set (the `Related:` block); they never reorder the primary cosine result. Primary results are **byte-identical** field on or off. | ✅ held | `memory-core.js` recall |

¹ **I4/I5 each carry one self-extinguishing legacy/outage exception:** recall embeds all
vectorless records in its eligible candidate set, not just the returned ids. `memory-core.js`
passes that fresh-vector map to `applyRecall()`: SQLite updates those rows in a transaction;
JsonlStore performs a full durable rewrite when backfill has work. There is no fixed row-count
bound on this exception. It self-extinguishes after successful backfill; ordinary steady-state
recall has only bounded retention writes. This is the named implementation exception;
backfill itself is not bounded by the return count.

**I6, precisely** (the one label that could mislead an implementer): `recall` still calls
`reinforceRecall` (co-recall is the differentiator) but **no longer** calls `tick()`. Decay
is `effectiveHebbian(edge, now)`: `w · 2^(−Δt/H)` from `now − hebbian.last_updated`, computed
on read, not written. A store recalled N times under a frozen clock shows zero learned-edge
decay. Co-recall still reinforces. On a reinforcing **mutation**, Phase 0.3
materializes `w_eff` onto `hebbian.weight` and *then* applies α, stamping `last_updated = now`,
so a long-idle edge cannot be bumped from its ghost (undecayed) stored value. Half-lives
(parameters, seconds): constraint ~30d, fact ~7d, working ~1h. Design and edge
state-transition table: [`phases/phase-0`](phases/phase-0-edge-substrate.md).

**On I2 vs I2b — two different strengths of "no."** History, included in 0.2.0 (2026-09-10):
I2's earlier wording was *"ranking = cosine only,"*
justified by a real measurement: adding a **durability** weight (`importance`/`access_count`) to
cosine inverted rankings. That finding is sound but narrower than the phrasing it produced —
`access_count` is a *retention* signal wearing a relevance costume (popular ≠ apt). It does not
follow that *all* fusion is harmful; Hebbian weight and activation are relevance-adjacent in a way
durability is not. So the durable form is **"no *unmeasured* signal touches rank"** (I2): rank
changes are permitted, unmeasured ones are not, and Phase 2's promotion gate is the experiment.
**I2b is stricter** because its family was already measured *and failed* — overturning it needs a
positive result strong enough to reverse a prior negative, not merely the absence of evidence
against it. The trap ("memories accessed often should rank a little higher…") arrives wearing a
different variable name each time, which is why `last_access` is named in the record as telemetry
rather than left to judgement.

**Two supporting rules follow from I4:** the server assigns metadata *from text* (constraint
typing, supersession cues are lexical heuristics computed server-side), and there is one
implementation of the four verbs (`memory-core.js`) shared by both callers, so the MCP server
and the eval harness can never drift.

---

## 3. The run modes

`entry.js` dispatches on the first CLI argument. CLI flags and hooks do not enlarge the
four-tool MCP interface. The panel and CLI call the same setup/export/import engines.

| Invocation | Implementation | State/interface |
|---|---|---|
| `memory --mcp` | `server.js` → `memory-core.js` | MCP stdio, store verbs |
| `memory` | `panel.js` | Loopback browser panel |
| `memory --install` / `--uninstall` | `install.js` | MCP client configuration |
| `memory --install-app` / `--uninstall-app` | `install-home.js` | Installed executable, shortcut and connection paths; source runs do not install |
| `memory --dedup-existing` | `dedup-existing.js` → core planner | Store backfill, dry-run default |
| `memory --migrate` / `--migrate-sqlite` | `migrate-sqlite.js` | Explicit JSONL→SQLite conversion; ordinary `openStore()` also auto-migrates on first open |
| `memory --export` / `--export-jsonl` | `export-memory.js` | Read-only MCP-store export |
| `memory --import` | `import-memory.js` | Direct store restore, dry-run default |
| `memory --install-memory-system` | `hooks/memory-system/install-memory.js` | Folder/template/hooks setup, dry-run default |
| `memory --recall` | `hooks/memory-system/recall.js` | Folder query/rebuild/history/plan |
| `memory --recall-hook` | `hooks/memory-system/recall-hook.js` | Per-message folder preview |
| `memory --rebuild-on-write` | `hooks/memory-system/rebuild-on-write.js` | Event-triggered, detached index rebuild |
| `memory --proxy` | `proxy.js` | Local-model per-message recall proxy |

The Claude Code plugin enters through `plugin/hooks/` and `plugin/scripts/`, rather than
through the standalone executable's mode dispatch. [Plugin setup](../plugin/README.md) owns
the installation and options; [auto-recall](guides/AUTO-RECALL.md) owns client/proxy setup.

---

## 4. Module map

### Core runtime (the source of truth)

| File | Role | Depends on |
|---|---|---|
| `entry.js` | Mode dispatch; see §3 for all executable entry points. | MCP / panel / installation / maintenance / folder hooks / proxy |
| `server.js` | MCP server. Declares the four tool schemas + descriptions, wires the *environment* (network embedder, live field toggle, live extract toggle, lazy EdgeStore) into the shared core, runs the stdio JSON-RPC loop, vacuums soft-deletes and `pruneSweep`s faded+weak edges at startup. Reads the version from `package.json` so `serverInfo` can't drift. Outbound `sampling/createMessage` is the Tier 2 path when the client advertised sampling. Per-embedder input formatting via `embed-invoke.js`. | `memory-core`, `store`, `edges`, `extract`, `embed-invoke`, `package.json` |
| `memory-core.js` | **The four cognitive verbs, as one implementation.** `createCore({ store, embed, fieldEnabled, getEdgeStore, dedupThresholds, fieldMinSim, extractEnabled, extract })` → `{ save, recall, edit, remove }`. Also `dedupExisting` / `planDedupExisting` (RM-02.c) so `--dedup-existing` cannot fork the 02.b bands. Everything environment-specific is *injected*. This is the code both `server.js` and `eval/pipeline.js` run — the RM-00 golden is the proof they never diverge. Phase 1 seeds/spreads `WarmField` on recall (default on) and does not consult `out`. | `field`, `record`, `extract`, `entity`, `warm`, `edges` |
| `extract.js` | RM-01.c Tier 2: opt-in LLM extraction (prompt, parser, sanity gate, `/v1/chat/completions`, MCP sampling, capability detect). Off by default. `save()` is the only caller. | stdlib + `fetch` |
| `dedup-existing.js` | RM-02.c CLI. Dry-run default; `--apply` is one durable rewrite. Thin wrapper over `dedupExisting()` — no second decision. | `memory-core`, `store` |
| `record.js` | The shared record schema (`normalize()`), durable atomic writes (`writeFileDurable()`), the access sidecar (`AccessLog`), and the lexical heuristics (constraint typing, historical-query detection, supersession cues, cosine-banded `detectNearDuplicate`). Owned here so server and panel agree on a record byte-for-byte. | stdlib only |
| `store.js` | Store seam. `openStore()` default-switch (slice 4): SQLite default; JSONL auto-migrates on first open; fail-open to JSONL. `RESONANCE_STORE=jsonl` pins JSONL. Same method surface; `memory-core.js` does not change. | `record`, `store-sqlite` |
| `store-sqlite.js` | RM-07 `SqliteStore`. `node:sqlite` `DatabaseSync`, WAL + `synchronous=FULL`, BLOB embeddings, in-process cache, in-table access counts. Never constructs `AccessLog`. | `record`, `node:sqlite` |
| `migrate-sqlite.js` | RM-07 slice 2a streaming JSONL→SQLite migrator (10-step protocol). Opt-in `--migrate`; `openStore()` calls the same function on first open (slice 4). `.bak` is a recovery snapshot, not the sovereignty export. | `store`, `store-sqlite`, `record` |
| `zip.js` | Zero-dep ZIP64 writer (slice 2b). `createDeflateRaw` + `zlib.crc32` + `.zip.tmp` rename. ZIP64 on every archive. | stdlib (`zlib`) |
| `export-memory.js` | RM-07 slice 2b sovereignty export. `--export` zip bundle; `--export-jsonl` raw primitive. Read-only. The 2c panel button shells `runExport()` / `previewExport()`. Not an MCP tool. | `zip`, `store`, `record`, `edges` |
| `import-memory.js` | RM-17 sovereignty import. `--import` dry-run default; `--apply` restores (or `--merge`s). Direct store write, not `save()`. `--with-edges` opt-in for Hebbian (`0009` planted-sidecar refusal). The panel button shells `runImport()`. Not an MCP tool. | `zip`, `store`, `record`, `edges` |
| `entity.js` | Server-assigned person-entity ids + polarity (I4). Closed-class relation × relation-anchored names; store-wide resolve. Feeds Related: `conflict` and Hebbian `pairScale` only — never primary cosine (I2/I3). | stdlib only |
| `embed-invoke.js` | Per-embedder input formatting. Nomic raw; Qwen Instruct-query; jina `Query:`/`Document:`. Keyed off panel `config.embedder` then `EMBED_MODEL`. | stdlib only |
| `field.js` | Associative layer (Phase 2a): a kNN semantic graph over stored vectors, neighborhood expansion, and constraint rescue. No new embedding calls, no LLM extraction. Related: minSim default 0.70; `conflict` callback drops entity/polarity mismatches. `warmRelatedCandidates` is H4 leftover expansion (flag-off default). | stdlib only |
| `ledger.js` | Retired Hebbian sidecar (Phase 2b). Off the live path as of Slice C; kept so tests can compare EdgeStore bonuses against the shipped epoch-decay math. | `record` |
| `edges.js` | Unified persistent edge store (Phase 0 / `RM-21`): one undirected record, two independent signals (`semantic` derived cache validated by version comparison, `hebbian` source of truth), typed provenance, one-way `.assoc.json` → `.edges.json` migration (`kind: "resonance-edges"`). **On the live recall path** — Hebbian bonus (via `effectiveHebbian`)/reinforce/save. Decay is lazy wall-clock (I6); `tick()` is retired. A reinforcing mutation materializes `effectiveHebbian` before applying α (0.3). MCP request-ID idempotency: a 256-entry LRU of processed JSON-RPC ids. **RM-07 slice 5:** persistence adapter — SqliteStore shares the `.db` (`processed_ids` + weight UPDATE are one txn); JsonlStore keeps the sidecar. `effectiveHebbian` is never stored. Soft prune (0.4 / I8): `pruneSweep()` marks `pruned_at` only when *both* unreinforced and semantically weak (`SEMANTIC_PRUNE_GATE` 0.25); hard drop is `vacuum()`, explicit. Reactivation is in-place on save/edit/reinforce of an endpoint. `field.js` still builds the semantic kNN at recall. Phase 1 spreads activation over this table (`incident()` / `activationEdgesFromStore`); pruned edges do not participate. | `record` |
| `warm.js` | Ephemeral spreading activation (Phase 1 / I7). In-process `Map` `id → { value, similarity, timestamp }`; never written to the store. Seeded from retrieval cosine (`clamp(sim, 0, 1)`), spread over Phase 0 edges with per-hop attenuation 0.5 and depth 2, lazy wall-clock half-life 300 s computed on access. Conductance is noisy-OR (`s + h − s·h`). Max-not-sum, cache cap 256. Does not touch rank unless `RESONANCE_WARM_RANK` is on (exploratory, default off, default shape additive; `final_score` stays `"semantic"` when off). Does not touch `Related:` unless `RESONANCE_WARM_RELATED` is on (H4, default off, measured no). Trace shape is the Phase 2.2 candidate record. Opt out: `RESONANCE_WARM_FIELD=0`. Combiner-shape research: `docs/research/lanes/lane-b-combiner-research.md`. | `edges` |
| `panel.js` | Loopback setup/store UI: connection and installed-home management, folder-system setup, live store graph, field/extraction settings, export/import confirmation and heartbeat lifecycle. Routes/protection: §11; store transport: §6. | installation modules, store/field/edges, export/import, memory-system installer |
| `install.js` | Detect + wire into LM Studio / Claude Desktop MCP config. Preserves other configured servers, leaves a `.bak`. `mcpSnippet()` is the copy-paste launch for every other MCP client. | stdlib only |
| `engine.js` | One-click embedder setup for the panel: drives LM Studio's bundled `lms` CLI to start the server, download the Nomic embedder, load it, and verify the endpoint answers. Pure convenience — the MCP server never needs it. | stdlib + `fetch` |
| `inspect_sidecar.js` | Legacy/JSONL telemetry: reads JSON edge or association sidecars and joins ids to JSONL. Does not inspect SQLite tables. | stdlib, store-path resolver |

### Folder memory and product integration

| Path | Role | Durable/derived boundary |
|---|---|---|
| `hooks/memory-system/sources.js` | Select live files, drawers and explicit history sources. | Reads markdown; excludes non-memory/generated material. |
| `hooks/memory-system/recall.js`, `lexical.js` | Incremental semantic index and query. Body chunks score files by their best chunk; BM25 falls back when the embedder does not answer. Milestones rank with other files. | Markdown is durable; vector and lexical indexes are derived caches. |
| `recall-hook.js`, `rebuild-on-write.js` in that directory | User-message preview and event-triggered detached rebuild. Background-task notices do not trigger recall. | Hooks do not become extra MCP tools or autonomous consolidation. |
| `hooks/memory-system/install-memory.js`, `memory-system/` | Additive template/rule/hook setup and shipped assets. | Existing memory files are not overwritten. |
| `hooks/cabinet/` | Python standard-library filing, index, relink and check commands. | Filing mutations require explicit apply; history and live files remain files. |
| `plugin/` | Claude Code session setup, prompt/write hooks and packaged recall modules. | Uses project/pinned markdown folder; copy drift is tested. |
| `proxy.js` | Per-message store recall through a long-lived MCP child plus optional folder preview; forward unchanged when recall fails or is empty. | Recall injection is transient; upstream remains the model server. |
| `install-home.js` | Executable installation, update-in-place, shortcuts and config repointing. | Source runs do not install; uninstall preserves memories. |

### Build & assets

| File | Role |
|---|---|
| `build-exe.js` | The build pipeline (§10). `--target win\|linux\|macos`; refuses to cross-compile. |
| `ci/smoke-exe.js` | RM-11 CI smoke of a SEA binary (`--mcp` initialize + `tools/list`). |
| `ci/release-meta.js` | RM-11 CI tag/checksums/notes helpers. |
| `.github/workflows/ci.yml` | PR/main gate: main tests, SQLite golden and plugin tests on `ubuntu-latest`; see DEVELOPERS for contributor checks. Does not build binaries. |
| `.github/workflows/release.yml` | RM-11 release matrix: gate + native SEA on windows/ubuntu/macos-latest + GitHub Release. The macOS binary is made here. |
| `build-demo-seed.js` | Regenerates `demo-seed.jsonl` via a live embedder. |
| `demo-seed.jsonl` | The synthetic first-launch showcase (a fictional game dev's notes: semantic recall, a superseded correction, a silent associative bridge). **Tracked**; 100% synthetic. |
| `system-prompt.md` | Optional copy-in system prompt for weaker models. Baked into the exe. |
| `sea-config.json` | Node SEA config (points at `build/bundle.js`). |
| `embedded-assets.js` | **Generated every build (gitignored).** Bakes the seed, system prompt, memory template, CLAUDE memory block, recall/install scripts and cabinet package into the executable. Never hand-edited or committed. |
| `uninstall.bat` | Windows uninstaller (disconnects, points to the data file, never deletes memories). |

### Tests, eval & docs

| Path | Role |
|---|---|
| `test.js` | The dependency-free main unit/regression suite. Run `npm test` for current results. |
| `eval/` | **RM-00**, the evaluation harness (§9). `eval/pipeline.js` wires `memory-core.js` to a cached embedder; `eval/run.js` runs the corpora and gates against `golden.json`. Reporting metrics (`eval/measure.js`) are a separate A/B path. |
| `docs/` | `ARCHITECTURE.md` (this file), `ROADMAP.md`, `phases/` (buildable phase specs), `BACKLOG.md`, `BUGS.md`, `COMPETITIVE-ANALYSIS.md`, `proposed/` RFCs. |

---

## 5. The four verbs (data flow)

All four live in `memory-core.js`. `server.js` maps the MCP tool names onto them; the model's
argument is always the smallest possible thing (`content`, `query`, or `id`).

<a id="store-save"></a>

### `save_memory({ content })`

1. **Tier 0 extraction (RM-01.b, always on, no LLM).** Collapse whitespace; strip leading
   filler openers and assistant-aimed imperative framing (longest-first, stacked);
   split on `; ` / ` and also ` only when every half is a standalone proposition.
   Clean facts are byte-identical. Implemented in `record.js` (`normalizeText` /
   `splitFacts` / `prepareWrite`) — not `normalize()`, which is the record schema.
   Extra embeds from a legitimate split are in-scope; the rest is string ops.
2. **Tier 1 secret/PII guard (RM-01.b, always on; prefixes widened for 2026
   issued shapes).** Refuse known credential *shapes*: API-key prefixes
   (`sk-`/`sk-proj-`/`sk-ant-`, `AIza…`, `sk_live_`/`rk_live_`, `gsk_`, `hf_`,
   Slack `xox*`/`xapp-`), `password:`/`passphrase:`/`api_key=` assignments,
   13–16 digit cards, AWS `AKIA`/`ASIA`, PEM / OpenSSH private keys, GitHub
   `ghp_`/`github_pat_` (underscore is what GitHub issues; the 01.b `ghp-`
   hyphen fake still refuses), JWTs (`eyJ….….…`). Store nothing; return
   `Not saved — that looks like … Secrets don't belong in memory.` Refusal, not
   redaction: a payload mixing a fact with a secret is store-nothing. Digit traps
   (`4821`, `1500mg`) do not match `\b[0-9]{13,16}\b`. Prose that *mentions*
   secrets ("the secret is browning the butter", "my password manager is
   Bitwarden") does not match — the guard keys off prefix+length+charset, not
   the English word. Stripe publishable `pk_live_` is client-side by design
   and is not refused.
3. **Tier 2 optional LLM extraction (RM-01.c, off by default).** One ADD-only
   call against the already-normalized, already-guarded text. Off by default is
   a deliberate identity choice: RM does the work; a weak local model can extract
   worse than Tier 0/1, so this is a conditional bonus, never a silent default.
   Capable path: MCP client `sampling`, or a non-embedding chat model at the
   configured endpoint (`GET /v1/models`). If neither, Tier 2 cannot run. The
   panel surfaces the toggle when a capable model is detected. Any failure /
   timeout / malformed output degrades silently to the Tier 0/1 facts — a save
   never fails or hangs because extraction did. PII still refused first: a
   secret is never sent to the LLM.
4. **Exact restatement guard.** If a current memory has byte-identical `text` (compared
   against the extracted fact), bump its `last_confirmed` + `access_count` and confirm —
   don't store a second copy. Free (no embed). A confirm also revives that id's pruned
   incident edges (Phase 0.4 — save touching an endpoint).
5. **Embed once per fact.** POST the extracted text to the OpenAI-compatible `/v1/embeddings`
   endpoint (LM Studio default, `text-embedding-nomic-embed-text-v1.5`, 768-dim). If the
   embedder is down, the record is stored **without** a vector and backfilled on a later
   recall — a save never fails because the embedder is unreachable.
6. **Normalize** into a record (`record.js` `normalize()` — the one schema definition).
7. **Cosine-banded dedup (RM-02.b).** Against already-stored vectors, argmax. Cosine ≥
   `DEDUP_HI` (0.95) is a restatement (same confirm path as step 4 — keep the original,
   don't append). Band `DEDUP_LO..HI` (0.88–0.95) is a candidate merge: keep the longer
   original text (never a blend — the `duplicate_rate` metric maps stored text back to
   its labeled group), union metadata, link the loser with `superseded_by` via
   `supersedePatches` (recoverable, never a hard delete). Below `DEDUP_LO`: fall through.
   No vector → skip, append, don't crash. Thresholds are config (`RESONANCE_DEDUP_HI` /
   `RESONANCE_DEDUP_LO` + live-config `dedup_hi` / `dedup_lo`), tuned on `eval/duplicates`
   (tea 0.9522 is the tightest HI; controls ≤ ~0.69). Scan is O(N) cosine, same cost
   class as the 0.1 save-time bind. Dedup runs *before* RM-03: a near-identical
   restatement is the same fact, not a correction. Stores written before this
   slice: `--dedup-existing` (dry-run default; `--apply` mutates) walks the
   current store in file order with the **same** decision (`planDedupExisting`
   in `memory-core.js`). One `updateMany` / `writeFileDurable`. Not a fifth verb.
8. **Supersession check (RM-03 v2).** `detectSupersession()` retires a current memory when
   (a) the new text fills the same closed-class exclusive slot with a different value
   (silent "I work at Globex" after "I work at Acme", polarity flip, numeric/date swap),
   or (b) it carries an explicit correction cue *and* is the argmax-similar current memory
   above the 0.535 floor (v1 paraphrase fallback). Hypothetical / additive language
   (`might`, `considering`, `too`) keeps both and sets `needs_review` — never a
   destructive guess. On a hit, the old row is retired (`valid_to`, `superseded_by`) and
   the new one appended; history is kept, never deleted. A same-slot value swap is not
   an RM-02 duplicate: `detectNearDuplicate` yields so merge cannot keep the longer
   stale text. Ranking is untouched. [RM-03 v2 results](../eval/RESULTS.md#rm-03-v2--silent-exclusive-slot-supersession)
   own the measured outcome and residual failures.
9. **Append** the record to the store (SqliteStore default; JsonlStore when pinned / fail-open).
10. **Save-time semantic bind (Phase 0.1).** If the record got a real vector, find its
   top-K neighbors among existing stored vectors above a min cosine and persist them on
   the EdgeStore: measured `semantic.value` + `src_versions` tagged to the canonical
   endpoints, `hebbian.weight = 0` (no seeded baseline), `provenance.origin =
   "save-time-neighbor"`. Defaults **K=5 / 0.25** (`SAVE_TIME_K` / `SAVE_TIME_MIN_COS`);
   env `RESONANCE_SAVE_K` / `RESONANCE_SAVE_MIN_COS` and live-config `save_k` /
   `save_min_cos` override (eval/tests pin the constants). Do not lower the floor
   below `SEMANTIC_PRUNE_GATE` (0.25) without also dropping the prune gate — those
   edges are born already dead. No vector (embedder down) → bind nothing, don't throw.
   A bind that finds an already-pruned pair revives it in place (0.4) rather than
   inserting a duplicate. Edge persistence uses the JSON sidecar for JsonlStore or the
   database adapter for SqliteStore. **Related: still comes from `field.js` at minSim 0.70.** The two
   thresholds are different jobs: 0.70 is a tight gate for what *surfaces*; 0.25 is a
   looser net for what's *worth persisting*. Do not unify them. Exploratory
   `RESONANCE_WARM_RECALL_BIND` (default off) unions an ephemeral seed-kNN into the
   Phase 1 spread walk without persisting (Lane C, `docs/research/lanes/lane-c-edge-density.md`).

### `recall_memory({ query })`

1. **Temporal scoping.** `isHistoricalQuery()` decides the candidate set: current facts
   (`store.current()`) by default; the full active history (`store.active()`) only when the
   query explicitly asks about the past ("used to", "before"). Superseded facts surface only
   then, and are labelled "no longer current".
2. **Embed the query** as a query-role call. Embed any vectorless eligible records in a
   separate document-role batch so per-embedder formatting stays correct. Cosine-rank
   all candidates. Return the top-k (default 5), each prefixed `[id N]`. If the embedder is
   unreachable, degrade to a crude keyword-overlap score rather than erroring.
3. **Record the recall.** `store.applyRecall()` bumps access counts. On **JSONL** that is
   the AccessLog sidecar (zero writes to the JSONL file in steady state). On **SQLite**
   that is a bounded `UPDATE` of the returned ids (I5: not a full-corpus rewrite).
   Freshly-computed vectors for vectorless rows are backfilled — the self-extinguishing
   I4/I5 exception.
4. **Associative field (if enabled).** Additive only: build the kNN edge set, expand a
   `neighborhood()` one hop from the returned seeds, and run `reachableConstraints()` to rescue
   apex rules (a "diabetic" memory reachable through a "lemon bars" bridge) that sit far down
   cosine. Merge into a `Related:` block, reinforce Hebbian weights on the EdgeStore
   provenance-discounted. The discovery bonus uses `effectiveHebbian` (wall-clock half-life,
   computed, not stored). `tick()` is not called (I6). A reinforce **materializes** the
   decayed weight, then applies α, and stamps `last_updated` (0.3). The JSON-RPC request
   id, when present, is the mutation's idempotency key — a retry applies once; no id
   (eval) applies every time. Writes go to the EdgeStore persist — `<store>.edges.json`
   on JsonlStore, the `edges` table in the `.db` on SqliteStore (never the JSONL
   memory file) — from `reinforceRecall` only. JsonlStore does that in one
   `writeFileDurable` that also records the request id; SqliteStore commits the
   id claim and the weight UPDATE in one txn (slice 5). The entire block is
   inside a `try/catch` — it can never break the primary result.

### `edit_memory({ id, content })`

Replace `text`, re-embed, refresh `modified` + `last_confirmed` (an edit is a correction in
place; the fact is current again as of now). A successful re-embed increments
`embedding_version` in lockstep with the new vector; a failed one omits both fields from
the patch so a good embedding cannot be clobbered (`BUG-008`). The store mutation is atomic:
SQLite updates the row; JSONL uses a durable rewrite. Incident pruned edges are revived in
place (Phase 0.4); no pruned rows means no edge-persistence write. No dedup-record stamp
(transition table).

### `delete_memory({ id })`

**Soft** delete (`deleted: true`). The row survives until the next startup `vacuum()` compacts
it out. Embeddings are kept until then.

---

## 6. Storage and the sidecars

The MCP store files live beside `MEMORY_FILE_PATH` (default `~/.resonance-memory/resonance-memory.jsonl`;
a leftover `~/.lmstudio/` store is copied here on first start — `BUG-004`):

```
resonance-memory.db                 SQLite default (slice 4+5): memories +
                                    access counts + edges in ONE file.
resonance-memory.jsonl              JsonlStore pin / fail-open / interchange
resonance-memory.jsonl.access.json  access-count sidecar   (AccessLog; JsonlStore only)
resonance-memory.jsonl.edges.json   unified edge table     (EdgeStore JSON adapter;
                                    JsonlStore. SqliteStore holds the same record
                                    in the `.db`. Leftover sidecar migrates on
                                    first-open → `.bak`.)
resonance-memory.jsonl.assoc.json   LEGACY Hebbian sidecar (Ledger, ledger.js).
                                    Read-only-for-migration: if `.edges.json` is
                                    missing, weights are copied in one-way and this
                                    file is left untouched (downgrade-safe).
resonance-memory.config.json        live runtime state (prefs ≠ memory; stays a sidecar)
```

Two properties make this safe and swappable:

- **Atomic durability.** JSONL/JSON sidecar rewrites go through `writeFileDurable()`: write a temp
  file in the *same directory*, `fsync`, then `rename` (atomic on POSIX and Windows). A reader
  sees the whole old file or the whole new one — never a half-written one. Plain
  `fs.writeFileSync` on the live file is forbidden (`BUG-001`).
- **No unbounded write on a read path (I5).** The forbidden thing is a full-corpus rewrite
  on recall (BUG-002: parse every row, bump ~5 counters, rewrite the file). Retention
  metadata may move on recall when the update is bounded, atomic, and cannot truncate the
  store. JSONL keeps counts in the AccessLog sidecar (zero JSONL writes in steady state).
  SQLite updates `access_count` / `last_access` in-table on the returned ids, one
  transaction, `synchronous=FULL`. Hebbian weights live in the same `.db` (slice 5
  adapter; JSON sidecar remains for JsonlStore). The live JSONL edge sidecar contains
  irreplaceable learned history; its access sidecar contains telemetry. After successful
  edge migration, SQLite owns the learned state. A leftover migration backup is not the live store.

The **config file** is deliberately beside the *data*, not the exe, so the panel toggle and
the MCP server read the same file — the field turns on/off with no client restart. `server.js`
reads `fieldEnabled()` per recall for exactly this reason.

### The Store seam

The Store method surface — `all` / `active` / `current` / `get` / `add` / `update` /
`updateMany` / `applyRecall` / `vacuum` / `hasDeleted` / `nextId` — is what
`memory-core.js` depends on. Two implementations:

- **`SqliteStore`** (default as of slice 4). `node:sqlite` `DatabaseSync`,
  WAL + `synchronous=FULL`, embeddings as Float32 BLOBs, in-process record cache
  hydrated once. Opaque `id` is preserved (never AUTOINCREMENT-renumbered). `created`
  is a real column. Access counts live *in the row*; this class never constructs
  `AccessLog` (BUG-007). No sqlite-vec — a RAM Float32 scan beat it at 10k–100k
  (see [`proposed/0010`](proposed/0010-sqlite-backend.md)). Product S1, field-off
  cached recall measurements are recorded with their 2026-09-05 conditions in
  [S1 results](../eval/RESULTS.md#s1--recall-accuracy--latency-at-scale-needle-in-haystack).
  `openStore()` auto-migrates an existing JSONL on first open via the 2a
  protocol (fail-open to JSONL if it throws before the atomic rename).
  `RESONANCE_STORE=jsonl` pins JSONL. `--migrate` is the same protocol as a CLI.
  The `.bak` is a recovery snapshot, not a two-way door (downgrade honesty:
  `--export-jsonl` before downgrade, or keep the new exe). `--export`
  (slice 2b) writes the ZIP64 zip bundle (Desktop, `--name` / `--out`);
  `--export-jsonl` is the raw primitive. The panel **Export my memories**
  button (slice 2c) shells the same engine (confirm modal, heartbeat pause).
  Slice 5 put EdgeStore in the same `.db` (one-file sovereignty). `searchDense`
  belongs to open RM-05 retrieval work.
- **`JsonlStore`** (pin / fail-open / export interchange). Flat JSONL; mutations
  go through `writeFileDurable()`. Access counts live in the AccessLog sidecar.
  `all()` re-parses the file per call. The dated S1 load limits belong to
  [eval results](../eval/RESULTS.md), not a backend-independent memory-count ceiling.

---

## 7. The associative substrate — where we're different

The default associative paths nominate discoveries without reordering primary cosine results.
External uniqueness claims belong to the dated [competitive analysis](COMPETITIVE-ANALYSIS.md).

### `field.js` — the static semantic floor (Phase 2a)

A per-node **k-nearest-neighbor** graph built from the vectors *already stored at save*. No
extra embedding calls, no LLM extraction. kNN is relative per node, so it dodges the absolute
similarity floor (~0.45) that made a global threshold connect everything. Three operations:

- `buildEdges()` — gated top-k neighbors per node. **Reciprocal (mutual) kNN is the default**
  (an RM-00 experiment): requiring the association to be mutual pruned a one-sided "hub" false
  positive (the noise-schedule 'Thursday' collision) with no regressions — a Pareto win.
- `neighborhood()` — one-hop expansion from the returned cosine seeds into the `Related:` block.
- `reachableConstraints()` — **constraint rescue.** Typed "apex rules" ("I'm diabetic", "afraid
  of heights") sit at the *bottom* of cosine for the queries they should gate, because a rule
  rarely restates its trigger. The recall path decouples the internal **search radius**
  (top-`K_SEARCH`=15) from the **return radius** (top-5): a constraint that ranks into the wider
  pool via a genuinely query-relevant bridge is rescued into `Related:`. Restricting the wider
  walk to *typed constraints* keeps it from reintroducing ordinary hubs, but does not eliminate
  lexical-polysemy false positives; the eval scorecard retains that boundary.

### `edges.js` — the unified edge table (Phase 0; was `ledger.js`)

"Fire together, wire together." One persistent edge table holding both
signals (`<store>.edges.json` on JsonlStore; the same record in the `.db` on
SqliteStore). Phase 0.1 persists save-time semantic neighbors here (default K=5, min cosine 0.25,
Hebbian weight 0); **recall still rebuilds semantic kNN in `field.js`** (minSim 0.70) and
does not use that persisted graph for kNN construction. WarmField does consume its cached
semantic signal during recall. The two cosine thresholds are deliberate
by role: ordinary Related uses 0.70, save-time bind uses 0.25, and constraint rescue
uses its independent 0.45 bridge gate. None is a primary-result score cutoff.
The learned Hebbian weight lives on the edge record and is the source of truth. The current
path retains the ledger's reference math where tested and adds the following live guards:

- **Canonical undirected edge key** (ids sorted) so `a:b` and `b:a` are one edge.
- **Bounded discovery bonus.** The live `nodeMaxBonus()` readout uses effective decayed
  weights normalized by the maximum incident endpoint weight: `maxBonus·tanh(w/nodeMax)`.
  It falls back to raw `maxBonus·tanh(w)` when no usable incident maximum exists. The
  EdgeStore reference `bonus()` still uses raw tanh for ledger parity; it is not the live
  normalized call site.
- **Provenance-discounted reinforcement** — primary↔primary at full `alpha`, primary↔neighborhood
  discounted, neighborhood↔neighborhood zero. Live `pairScale` additionally gates/scales by
  pair cosine and zeros entity/polarity mismatches. Constraint bridges use the independent
  constraint gate. These are retrieval-role/pair guards, not full source-trust validation.
  `RM-16` generalizes provenance to the whole write path and the writer of the learned signal
  (Phase 0.6 sketch:
  [`proposed/0009`](proposed/0009-edge-threat-model.md) — semantic recomputes, a poisoned
  reinforcement is a durable false memory; `RM-16` stays gated to Phase 2 / the 2.2 gate).
- **Decay** is lazy wall-clock via `effectiveHebbian` (`w · 2^(−Δt/H)` from
  `hebbian.last_updated`; H is a per-type half-life in seconds). Computed on read, not
  stored. Unused associations fade with elapsed time, not recall count (I6).
- **Materialize on mutation (Phase 0.3).** A reinforcing write first stores
  `effectiveHebbian(edge, now)` as `hebbian.weight`, then adds α, then stamps
  `hebbian.last_updated = now`. Provenance is preserved; a pruned edge is
  revived in place first (0.4). After the write, stored weight and effective weight coincide, so
  reinforcement can never bypass accumulated decay (the "ghost weight" of
  adding α to an undecayed stored value after a long idle). At Δt≈0 this is
  a no-op on the number — an instant eval does not move.
- **Request-ID idempotency (Phase 0.3).** One MCP JSON-RPC request id = one
  mutation transaction, applied to every edge-mutating op (`reinforceRecall`,
  save-time bind). The processed-id LRU (`DEDUP_LRU_SIZE = 256`) lives in the
  JSON sidecar as `processed_ids`, committed with the weight change by one durable write.
  SQLite commits the processed-id claim and weight update in one transaction in the same
  database. No id → apply, do not record (eval / non-JSON-RPC).
  This is **orthogonal to `W-04`**: it dedups same-process retries, it does
  not serialize concurrent panel + MCP writers.

Neither default discovery layer reorders the primary cosine result (I9). A corrupt sidecar
fails open to empty (bonus 0); recall still returns cosine (I3). The dated, scoped
[S2v2 result](research/s2v2/s2v2-result.md) owns behavioral evidence for this boundary;
it is not a universal guarantee about every driver or recall format.

- **Soft prune (Phase 0.4 / I8).** An explicit `pruneSweep()` (MCP startup or on
  demand — never `recall`/`save`) marks an edge `pruned_at` only when it is
  **both** unreinforced (`effectiveHebbian < 1e-6`) **and** semantically weak
  (`semantic.value < 0.25`, the save-time bind floor). An idle but
  semantically-strong edge stays, so constraint-rescue does not regress
  (RESULTS field experiment #2 — the two-signal rule). The record is kept;
  `incident()` skips it. `EdgeStore.vacuum()` is the hard drop, also
  explicit. Reactivation is a consequence of `save`/`edit`/`reinforce`
  touching an endpoint: `pruned_at → null`, `created_at` and the decayed
  Hebbian bytes preserved, `prune_count` / `first_pruned_at` /
  `last_reactivated_at` kept as O(1) history. No fifth tool (I1).

### `warm.js` — transient activation (Phase 1; I7 held)

An in-process `Map` of "what's warm right now." Seeded from the cosine hits of
the current recall (`activation = clamp(similarity, 0, 1)`; the two stay
separate fields), then spread over the Phase 0 edge table — **not** over
`field.buildEdges`. Conductance is noisy-OR
`s + tanh(heb) − s·tanh(heb)` (either channel carries; both corroborate;
APR claim 8). Pruned edges are silent. Per-hop attenuation 0.5, depth 2,
floor 0.05, cache cap 256, half-life 300 s (lazy wall-clock, computed on
access, same discipline as `effectiveHebbian`). Update is max, not sum.

The recall hook computes this by default and **does not consult `out`**
unless `RESONANCE_WARM_RANK` is on (rank) or `RESONANCE_WARM_RELATED` is
on (`Related:` only; H4, measured no — `docs/research/lanes/h4-related-discovery.md`).
Rank is cosine at the default; main tests and the golden runner check rank identity with
activation computed. The rank flag is exploratory
(`cosine + 0.3 · spread-activation` by default; `RESONANCE_WARM_RANK_SHAPE`
selects `rrf` / `ranknorm` / `l1` / `multiplicative` for Lane B research)
and is **not** the 2.2 promotion. Verdict in `docs/research/lanes/lane-b-combiner-research.md`: L1 is
the promising proto-2.4 readout, still flag-off.
Trace (`RESONANCE_WARM_TRACE`) emits the Phase 2.2 candidate shape
(`semantic` / `hebbian` / `recency` / `activation` / `final_score`).
Flag-off `final_score` stays `"semantic"`; flag-on tags `"hybrid"`.

APR metric + knobs: [`phases/phase-1`](phases/phase-1-transient-activation.md),
`eval/substrate/activation-measure.js`.

---

## 8. The temporal model (bi-temporal, after Graphiti)

Defined once in `record.js`. Every field is backfilled by `normalize()` on read, so this
doubles as the migration path — an old record simply gains new fields on first load, with no
migration step.

| Field | Meaning |
|---|---|
| `valid_from` | when this became true in the world |
| `valid_to` | when it stopped being true; `null` = still true now |
| `last_confirmed` | last time we saw evidence it still holds |
| `superseded_by` / `supersedes` | forward/back pointers along the supersession chain |
| `revision` | position in the chain (1 = original) |
| `needs_review` | an ambiguous conflict both kept for a human to look at |
| `source` | provenance (`user_stated` default) — the `RM-16` groundwork |
| `is_constraint` | server-assigned constraint type (lexical, from text) |
| `embedding_version` | generation of the stored vector (Phase 0). Starts at `1`; increments only when `edit()` writes a real new vector. A failed embed omits it from the patch (`BUG-008` class). Cached semantic edges later compare this against `src_versions`. |

A superseded memory is **never deleted**: `valid_to` is set to the successor's `valid_from`,
producing a non-overlapping validity chain you can walk backwards. `store.current()` excludes
superseded rows (what recall answers from); `store.active()` keeps them (history). This
representation does not require a graph database.

---

## 9. Evaluation and verification

The [eval guide](../eval/README.md) owns instruments, corpora, reporting metrics and reproduction
commands. `eval/pipeline.js` wires the same `memory-core.js` used by the MCP server to cached
embeddings. The golden gate and reporting metrics have different roles; a reporting improvement
does not silently re-accept the golden. The RM-15 control soak is a separate instrument.

Run `npm test`, `node eval/run.js` and `node eval/run.js --store jsonl` for current substrate
coverage and scorecards. [DEVELOPERS checks](../DEVELOPERS.md#checks) lists folder, plugin and
cabinet verification and the actual CI/release coverage. Do not restate changing test counts
or golden scores here.

[Eval results](../eval/RESULTS.md), [soak baseline](../eval/soak/README.md) and
[research](research/) own dated measurements and scoped limitations. The field's legitimate
heights rescue and height-homonym false positive are separate cases; consult the scorecard
rather than treating one as evidence that the other is fixed.

---

## 10. Build and distribution boundary

`build-exe.js` embeds runtime assets, bundles `entry.js` with esbuild, creates the Node SEA
blob, injects it into the native runtime and performs the platform finish before staging
`dist/`. Assets include the demo seed, system prompt, memory template, CLAUDE memory block,
memory-system scripts and Python cabinet package. `embedded-assets.js` is generated.

There are no runtime npm dependencies; esbuild/postject are build-time tools. The standalone
executable carries Node; the plugin uses the host Node installation. Builds are native per
platform. [BUILDING](guides/BUILDING.md) owns the recipe, platform limits and OS warning path;
[DEVELOPERS](../DEVELOPERS.md#build-and-release) links the release workflow. Signing remains
RM-11, not a property of the macOS ad-hoc signature.

---

## 11. Configuration surface

MCP-store/panel environment surface. Startup selects endpoints/backend and experimental
flags; the documented live-config tunables are read during operations. Folder/plugin/proxy
configuration is indexed separately below.

| Variable | Default | Effect |
|---|---|---|
| `MEMORY_FILE_PATH` | `~/.resonance-memory/resonance-memory.jsonl` | the store (sidecars derive from it). Unset: auto-copy from the retired `~/.lmstudio/` default if the new location is empty (`BUG-004`). |
| `RESONANCE_MEMORY_CONFIG` | beside the store | live field / extract-toggle config file |
| `EMBED_ENDPOINT` | `http://localhost:1234/v1/embeddings` | OpenAI-compatible embeddings endpoint |
| `EMBED_MODEL` | `text-embedding-nomic-embed-text-v1.5` | embedding model name |
| `RESONANCE_MEMORY_FIELD` | off | default field state when no config file exists |
| `RESONANCE_FIELD_MUTUAL` | on | reciprocal-kNN topology (`0` → directional) |
| `RESONANCE_FIELD_KSEARCH` | 15 | internal search radius for constraint rescue |
| `RESONANCE_FIELD_MINSIM` | 0.70 | Related: kNN floor (live-config `field_minsim` wins) |
| `RESONANCE_CONSTRAINT_GATE` | 0.45 | min cosine for a constraint↔seed bridge (live-config `constraint_gate` wins) |
| `RESONANCE_MEMORY_PANEL_PORT` | 9090 | control-panel port (127.0.0.1 only) |
| `RESONANCE_EXTRACT_LLM` | off | default Tier 2 state when no config file exists |
| `RESONANCE_EXTRACT_MODEL` | auto (first non-embed) | preferred chat model id for Tier 2 |
| `RESONANCE_EXTRACT_TIMEOUT_MS` | 8000 | interactive extract bound; degrade to Tier 0/1 |
| `RESONANCE_STORE` | sqlite | `jsonl` pins JsonlStore; live-config `store` wins |
| `RESONANCE_DEDUP_HI` | 0.95 | cosine restatement band (live-config `dedup_hi` wins) |
| `RESONANCE_DEDUP_LO` | 0.88 | cosine merge band (live-config `dedup_lo` wins) |
| `RESONANCE_WARM_FIELD` | on | Phase 1 activation compute; `0`/`false`/`no` opt-out — does not rank |
| `RESONANCE_WARM_RANK` | off | exploratory: put spread-activation into primary rank (not the 2.2 promotion) |
| `RESONANCE_WARM_RANK_WEIGHT` | 0.3 | combiner weight when rank is on (same cap as Related: maxBonus) |
| `RESONANCE_WARM_RANK_SHAPE` | additive | `rrf` / `ranknorm` / `l1` / `multiplicative` (only when rank is on) |
| `RESONANCE_WARM_RANK_RRF_K` | 60 | RRF k when shape is rrf |
| `RESONANCE_SAVE_K` | 5 | save-time semantic bind K (live-config `save_k` wins) |
| `RESONANCE_SAVE_MIN_COS` | 0.25 | save-time bind floor (live-config `save_min_cos` wins) |
| `RESONANCE_WARM_RECALL_BIND` | off | ephemeral seed-kNN unioned into spread at recall; does not persist |
| `RESONANCE_WARM_TRACE` | off | stderr `[warm-trace]` JSON (Phase 2.2 candidate shape) |
| `RESONANCE_WARM_RELATED` | off | exploratory H4: leftover spread-activation expands `Related:` only. Measured no. |
| `RESONANCE_WARM_RELATED_FLOOR` | 0.05 | H4 candidacy floor (WarmField floor) |

The embedder is **not bundled** — we depend on the `/v1/embeddings` *interface*, not a specific
model, so any compatible embedding model can be swapped in.

The panel's HTTP surface (`127.0.0.1` only): `GET /`, `GET /api/state` (includes
`extract_llm` / `extract_capable` / `extract_model`), `GET`/`POST /api/embedder`,
`GET /api/graph`,
`GET /api/clients`, `GET /api/engine`, `GET /api/system-prompt`, `POST /api/toggle`
(`field` and/or `extract_llm`; extract-on is refused if no capable model),
`POST /api/connect|disconnect`, `POST /api/engine/setup`, `POST /api/ping` (heartbeat),
`GET`/`POST /api/export` (slice 2c), `GET`/`POST /api/import` (RM-17; POST
`apply:false` is the dry-run, `apply:true` writes; `withEdges` default-off),
`POST /api/import/pick`, `GET`/`POST /api/memory-system`, and `GET`/`POST /api/install-home`.
These are internal routes, not the stable RM-12 API.
**W-02 (shipped):** Host must be loopback; Origin, when present, must be this panel
(`http://127.0.0.1:<port>` / `localhost`); mutating POSTs require a per-process
`X-Resonance-Token` baked into the page. No CORS. Residual: a local process that
reads the page can steal the token.

---

### Other configuration surfaces

| Surface | Configuration owner |
|---|---|
| Folder recall, memory directory, index/cache and installed hooks | [Memory-system guide](guides/MEMORY-SYSTEM.md) and `hooks/memory-system/recall.js` |
| Project or pinned-folder plugin settings and endpoint detection | [Plugin guide](../plugin/README.md) |
| Proxy listener/upstream and optional folder/store recall | [Auto-recall guide](guides/AUTO-RECALL.md) and `proxy.js` |
| Executable home and shortcut | [README setup](../README.md), `install-home.js` |

## 12. Extension seams (where new work plugs in)

- Store backends implement the Store surface behind the verbs; RM-07 is complete.
- Write-path work stays in `memory-core.js`; folder recall remains a separate file-based path.
- RM-05 owns FTS5, dense/sparse retrieval methods and fusion. Default promotion uses the
  [Phase 2 gate](phases/phase-2-retrieval-dynamics.md#fusion-promotion), not the existence of an experimental flag.
- RM-06 resolves scope from trusted client/config identity rather than model arguments.
- RM-10 remains open: panel-idle and event-driven/lazy trigger proposals disagree.
  [BACKLOG](BACKLOG.md) owns the decision and [Phase 4](phases/phase-4-consolidation.md) the build contract.

The four verbs and invariant definitions stay fixed. Open scope/acceptance belongs to BACKLOG,
not a second future implementation plan here.

---

## 13. Where to read next

- Building, running, and verifying → [`../DEVELOPERS.md`](../DEVELOPERS.md).
- What's being built now, and in what order → [`ROADMAP.md`](ROADMAP.md) + [`phases/`](phases/).
- What's done, in progress, and open → [`BACKLOG.md`](BACKLOG.md) (`RM-00`…`RM-21`).
- Known defects and the watch list → [`BUGS.md`](BUGS.md).
- Why the roadmap is ordered the way it is → [`COMPETITIVE-ANALYSIS.md`](COMPETITIVE-ANALYSIS.md).
- Associative-layer research (activation in rank, H4, H6, S2v2) → [`research/`](research/) + [S2v2 result](research/s2v2/s2v2-result.md).
- Deep designs with pseudocode → [`proposed/`](proposed/).

---

## Related

[[ROADMAP]] · [[BACKLOG]] · [[BUGS]] · [[CLAUDE]] · [[DEVELOPERS]] · [[phase-0-edge-substrate]] · [[phase-2-retrieval-dynamics]] · [[phase-7-reconsolidation]] · [[0009-edge-threat-model]] · [[RESULTS]] · [[proposed/README]] · [[COMPETITIVE-ANALYSIS]]
