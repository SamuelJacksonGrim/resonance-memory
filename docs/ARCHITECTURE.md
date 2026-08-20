# Resonance Memory — architecture

*The map of the system: what each part is, how they fit, and which invariants the shape
protects. Companion documents: [`ROADMAP.md`](ROADMAP.md) (where it's going),
[`BACKLOG.md`](BACKLOG.md) (itemized work), [`COMPETITIVE-ANALYSIS.md`](COMPETITIVE-ANALYSIS.md)
(why), [`proposed/`](proposed/) (designs with pseudocode), and the root
[`CLAUDE.md`](../CLAUDE.md) (the working brief for AI assistants). Everything here is drawn
from the code as it stands at `v0.2.0`.*

---

## 1. What this is, in one paragraph

Resonance Memory is a persistent memory for local LLMs, shipped as a **single self-contained
executable** (~89 MB, no Node install required on the user's machine). It speaks the Model
Context Protocol (MCP) over stdio and exposes exactly **four verbs** — `save_memory`,
`recall_memory`, `edit_memory`, `delete_memory` — and nothing else. All the sophistication
(embeddings, cosine ranking, a temporal supersession model, a kNN associative graph, a
Hebbian co-activation ledger) lives in the *substrate*, behind those four verbs. The model
never sees an embedding, a timestamp, or a score — only the verbs and an opaque `id`. Nothing
leaves the machine: there is no cloud, no account, no API key. Storage is a flat JSONL file
in the user's home directory.

The one design principle everything else serves: **a small model cannot misuse it.** The
interface may get *simpler*, never more cognitively demanding.

---

## 2. Design invariants (the shape is load-bearing)

These are enforced by the code, not just aspirational. They are the reason the modules are
split the way they are. The canonical list lives in `INVARIANTS.md` in the companion
`resonance-memory-stack` repo; the load-bearing ones here:

1. **Four verbs, nothing more.** The public tool surface is fixed. New capability lands in the
   substrate, never as a fifth tool. If a feature seems to need one, the design is wrong.
2. **Ranking is cosine only.** `importance` / `access_count` govern *retention*, never
   *retrieval order*. This is measured: adding a durability weight to cosine inverts rankings.
   (`proposed/0003` proposes a flag-gated hybrid arm, promoted only on a measured A/B win.)
3. **The associative layer is discovery, not ordering.** Co-activation and the kNN graph
   *expand* the candidate set (the `Related:` block); they never reorder the primary cosine
   result. Primary results are **byte-identical** whether the field is on or off, and the whole
   field path is wrapped in a `try/catch` that must never break recall.
4. **Embed once at save; the server owns all metadata; the model assigns none of it.** A
   `Store` abstraction sits behind the verbs so the backend can be swapped without touching
   the MCP API.
5. **All store writes go through `writeFileDurable()` (temp → fsync → atomic rename), and
   nothing on a read path writes to the store.** Both were violated once — `BUG-001` (a
   non-atomic write that could truncate the entire memory) and `BUG-002` (recall rewriting the
   store to bump a counter). See [`BUGS.md`](BUGS.md).

Two supporting rules follow from #4: the server assigns metadata *from text* (constraint
typing, supersession cues are lexical heuristics computed server-side), and there is one
implementation of the four verbs (`memory-core.js`) shared by both callers, so the MCP server
and the eval harness can never drift.

---

## 3. The three run modes

The shipped binary is one file that dispatches on `process.argv[2]` (`entry.js`):

| Invocation | Mode | Entry | What it is |
|---|---|---|---|
| `memory --mcp` | **MCP server** | `server.js` | The JSON-RPC 2.0 stdio loop an AI client talks to. The product's core. |
| `memory` (double-click) | **Control panel** | `panel.js` | A local `127.0.0.1:9090` web UI: field toggle, Connect/Disconnect, the 3D association graph, one-click embedder setup. |
| `memory --install` / `--uninstall` | **Installer** | `install.js` | Wires the exe into LM Studio / Claude Desktop MCP config (or removes it). |

All three share the same substrate modules, so a memory saved through the MCP server is the
same record the panel renders and the installer's target reads.

```
                         entry.js  (argv dispatch)
              ┌───────────────┼────────────────────┐
          --mcp            (default)            --install/--uninstall
              │                │                        │
          server.js        panel.js                install.js
              │                │
              └──────┬─────────┘
                     ▼
              memory-core.js   ← the four verbs, ONE implementation
                     │
        ┌────────────┼───────────────┐
        ▼            ▼                ▼
     store.js     field.js        ledger.js
        │            │                │
        └──────► record.js ◄──────────┘   (schema + durable writes + access sidecar)
```

---

## 4. Module map

### Core runtime (the source of truth)

| File | Role | Depends on |
|---|---|---|
| `entry.js` | Mode dispatch on `argv`. | server / panel / install |
| `server.js` | MCP server. Declares the four tool schemas + descriptions, wires the *environment* (network embedder, live field toggle, lazy ledger) into the shared core, runs the stdio JSON-RPC loop, vacuums soft-deletes at startup. Reads the version from `package.json` so `serverInfo` can't drift. | `memory-core`, `store`, `ledger`, `package.json` |
| `memory-core.js` | **The four cognitive verbs, as one implementation.** `createCore({ store, embed, fieldEnabled, getLedger })` → `{ save, recall, edit, remove }`. Everything environment-specific is *injected*. This is the code both `server.js` and `eval/pipeline.js` run — the RM-00 golden is the proof they never diverge. | `field`, `record` |
| `record.js` | The shared record schema (`normalize()`), durable atomic writes (`writeFileDurable()`), the access sidecar (`AccessLog`), and the lexical heuristics (constraint typing, historical-query detection, supersession cues). Owned here so server and panel agree on a record byte-for-byte. | stdlib only |
| `store.js` | `JsonlStore` — the flat-JSONL backend behind the Store seam. Constructible and testable without the stdio loop; a SQLite backend can replace it with the same method surface. | `record` |
| `field.js` | Associative layer (Phase 2a): a kNN semantic graph over stored vectors, neighborhood expansion, and constraint rescue. No new embedding calls, no LLM extraction. | stdlib only |
| `ledger.js` | Hebbian sidecar (Phase 2b): learned co-activation weights, a bounded `maxBonus·tanh(w)` bonus, provenance-discounted reinforcement, decay + prune. | `record` |
| `panel.js` | The `127.0.0.1` control panel (largest file): field toggle, Connect/Disconnect, the 3D association-graph view, demo graph, heartbeat auto-shutdown. | `install`, `field`, `engine`, `ledger`, `record`, `embedded-assets` |
| `install.js` | Detect + wire into LM Studio / Claude Desktop MCP config. Preserves other configured servers, leaves a `.bak`. | stdlib only |
| `engine.js` | One-click embedder setup for the panel: drives LM Studio's bundled `lms` CLI to start the server, download the Nomic embedder, load it, and verify the endpoint answers. Pure convenience — the MCP server never needs it. | stdlib + `fetch` |
| `inspect_sidecar.js` | Dependency-free telemetry for the Hebbian ledger. | stdlib |

### Build & assets

| File | Role |
|---|---|
| `build-exe.js` | The build pipeline (§9). |
| `build-demo-seed.js` | Regenerates `demo-seed.jsonl` via a live embedder. |
| `demo-seed.jsonl` | The synthetic first-launch showcase (a fictional game dev's notes). **Tracked**; 100% synthetic. |
| `system-prompt.md` | Optional copy-in system prompt for weaker models. Baked into the exe. |
| `sea-config.json` | Node SEA config (points at `build/bundle.js`). |
| `embedded-assets.js` | **Generated every build (gitignored).** Bakes the seed + system prompt in as strings. Never edited, never committed. |
| `uninstall.bat` | Windows uninstaller (disconnects, points to the data file, never deletes memories). |

### Tests, eval & docs

| Path | Role |
|---|---|
| `test.js` | The dependency-free unit/regression suite (`npm test`). **57 tests, <1s.** |
| `eval/` | **RM-00**, the evaluation harness (§8). `eval/pipeline.js` wires `memory-core.js` to a cached embedder; `eval/run.js` runs the corpora and gates against `golden.json`. |
| `docs/` | `ARCHITECTURE.md` (this file), `HANDOFF.md`, `ROADMAP.md`, `BACKLOG.md`, `BUGS.md`, `COMPETITIVE-ANALYSIS.md`, `proposed/` RFCs. |

---

## 5. The four verbs (data flow)

All four live in `memory-core.js`. `server.js` maps the MCP tool names onto them; the model's
argument is always the smallest possible thing (`content`, `query`, or `id`).

### `save_memory({ content })`

1. **Exact restatement guard.** If a current memory has byte-identical `text`, bump its
   `last_confirmed` and confirm — don't store a second copy. (Near-duplicate/cosine-banded
   dedup is `RM-02`, still open; this is only the free, unambiguous case.)
2. **Embed once.** POST `content` to the OpenAI-compatible `/v1/embeddings` endpoint (LM Studio
   default, `text-embedding-nomic-embed-text-v1.5`, 768-dim). If the embedder is down, the
   record is stored **without** a vector and backfilled on a later recall — a save never fails
   because the embedder is unreachable.
3. **Normalize** into a record (`record.js` `normalize()` — the one schema definition).
4. **Supersession check (RM-03 v1).** `detectSupersession()` fires only when the new text
   carries an explicit correction cue ("actually", "now", "no longer", "moved"…) *and* it is
   the argmax-similar current memory above a floor. On a hit, the old row is retired
   (`valid_to`, `superseded_by`) and the new one appended, as one logical change — history is
   kept, never deleted. The cue is the precision gate; cosine only picks *which* memory the cue
   targets. Worst case: it retires nothing.
5. **Append** the record to the JSONL store.

### `recall_memory({ query })`

1. **Temporal scoping.** `isHistoricalQuery()` decides the candidate set: current facts
   (`store.current()`) by default; the full active history (`store.active()`) only when the
   query explicitly asks about the past ("used to", "before"). Superseded facts surface only
   then, and are labelled "no longer current".
2. **Embed the query** (plus any vectorless legacy rows, folded into the same call). Cosine-rank
   all candidates. Return the top-k (default 5), each prefixed `[id N]`. If the embedder is
   unreachable, degrade to a crude keyword-overlap score rather than erroring.
3. **Record the recall.** `store.applyRecall()` bumps access counts *in the sidecar* and
   backfills any freshly-computed vectors. In steady state a recall performs **zero** writes to
   the memory store (the `BUG-002` fix).
4. **Associative field (if enabled).** Additive only: build the kNN edge set, expand a
   `neighborhood()` one hop from the returned seeds, and run `reachableConstraints()` to rescue
   apex rules (a "diabetic" memory reachable through a "lemon bars" bridge) that sit far down
   cosine. Merge into a `Related:` block, reinforce the Hebbian ledger provenance-discounted,
   tick decay. The entire block is inside a `try/catch` — it can never break the primary result.

### `edit_memory({ id, content })`

Replace `text`, re-embed, refresh `modified` + `last_confirmed` (an edit is a correction in
place; the fact is current again as of now). One durable rewrite.

### `delete_memory({ id })`

**Soft** delete (`deleted: true`). The row survives until the next startup `vacuum()` compacts
it out. Embeddings are kept until then.

---

## 6. Storage and the sidecars

Everything lives beside `MEMORY_FILE_PATH` (default `~/.lmstudio/resonance-memory.jsonl`):

```
resonance-memory.jsonl              the store — one JSON record per line
resonance-memory.jsonl.access.json  access-count sidecar   (AccessLog, record.js)
resonance-memory.jsonl.assoc.json   Hebbian edge weights   (Ledger, ledger.js)
resonance-memory.config.json        live runtime state (the field toggle)
```

Two properties make this safe and swappable:

- **Atomic durability.** Every store rewrite goes through `writeFileDurable()`: write a temp
  file in the *same directory*, `fsync`, then `rename` (atomic on POSIX and Windows). A reader
  sees the whole old file or the whole new one — never a half-written one. Plain
  `fs.writeFileSync` on the live file is forbidden (`BUG-001`).
- **Read paths never write the store.** Access counts and Hebbian weights are *sidecars*, not
  columns. They are retention/learning signals that never touch ranking, so losing their tail
  to a crash costs nothing — while rewriting the whole store on a read risked everything
  (`BUG-002`). Deleting a sidecar loses learned associations or access counts, never a memory;
  both regenerate.

The **config file** is deliberately beside the *data*, not the exe, so the panel toggle and
the MCP server read the same file — the field turns on/off with no client restart. `server.js`
reads `fieldEnabled()` per recall for exactly this reason.

### The Store seam

`JsonlStore` (`store.js`) is the only thing that touches the file. Its method surface —
`all` / `active` / `current` / `get` / `add` / `update` / `updateMany` / `applyRecall` /
`vacuum` / `hasDeleted` / `nextId` — is what `memory-core.js` depends on. A SQLite-backed store
(`sqlite-vec` for vectors, FTS5 for the hybrid keyword arm; `node:sqlite` confirmed available)
can replace it with the same surface, leaving the four verbs untouched. That is `RM-07`; the
*data-loss* half is already done, the *performance* half (`all()` parses the whole file per
call; mutations rewrite it) is the open scaling limit.

---

## 7. The associative substrate — where we're different

This is the differentiator no competitor has. It is two layers, both strictly additive.

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
  pool via a genuinely query-relevant bridge is rescued into `Related:`, even though the model
  never sees it directly. Restricted to *typed constraints* so the wider radius can't re-drag
  ordinary hubs back in — TBR (tangent bleed) is protected by construction, not by luck.

### `ledger.js` — the dynamic Hebbian layer (Phase 2b)

"Fire together, wire together." A sidecar of learned memory↔memory weights, kept entirely
separate from the vector store. Safety properties baked in:

- **Canonical undirected edge key** (ids sorted) so `a:b` and `b:a` are one edge.
- **Bounded bonus** via `maxBonus·tanh(w)` — frequency can lift a weak edge over the `minSim`
  gate but can never swamp the semantic floor.
- **Provenance-discounted reinforcement** — primary↔primary at full `alpha`, primary↔neighborhood
  discounted, neighborhood↔neighborhood zero. The graph learns from the user's queries, not from
  its own guesses. This provenance instinct is what `RM-16` generalizes to the whole write path.
- **Decay + prune** every N recalls, so unused associations fade.

Neither layer ever reorders the primary cosine result — invariant #3.

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

A superseded memory is **never deleted**: `valid_to` is set to the successor's `valid_from`,
producing a non-overlapping validity chain you can walk backwards. `store.current()` excludes
superseded rows (what recall answers from); `store.active()` keeps them (history). This is the
single most-copyable good idea in the market, and — as the code proves — it needs no graph
database.

---

## 9. The evaluation harness (RM-00) — the measurement system

`eval/` is not a test folder; it is the instrument the whole roadmap depends on. Its reason to
exist: extraction, dedup, and conflict handling are all features that can make the system
*worse*, and without a regression gate you cannot tell. It is **offline and deterministic** —
it reads `eval/embeddings.cache.json` and never touches the network or an API key.

- `eval/pipeline.js` wires the *same* `memory-core.js` the server runs to a cached embedder, so
  the golden is a regression guard on the server itself, not on a copy.
- `eval/run.js` runs the fixture corpora (`basic`, `contradictions`, `constraints`,
  `adversarial`, `field-noise`, `field-stress`) with the field **off and on**, reports the
  **ROC** (did the apex constraint surface?) and **TBR** (did forbidden junk bleed in?) split,
  and gates against `golden.json`. `--filter <id>` runs a subset; `--accept` locks the current
  scorecard as the new golden.
- Current scorecard: **27/31 checks**, field lifts 3 cases fail→pass and the golden gate holds.

`npm test` (57 tests) covers the substrate directly; `npm run eval` covers recall behavior.
Both run in well under a minute. The acceptance test for the harness itself: a deliberately
broken change (e.g. rank by recency) is caught by the gate.

---

## 10. The build pipeline

`build-exe.js` produces the single shippable file:

```
[0] embed runtime assets  → generate embedded-assets.js (demo seed + system prompt as strings)
[1] esbuild               → bundle entry.js + all requires into one file, strip per-file
                            AGPL headers, prepend a single collapsed notice
[2] Node SEA blob         → --experimental-sea-config sea-config.json
[3] copy the node runtime → resonance-memory.exe (Windows) / memory (mac/linux)
[4] postject inject       → embed the SEA blob into the copied runtime
    (Windows) flip PE subsystem console(3) → GUI(2) so double-click opens no console window;
    MCP mode is unaffected (LM Studio pipes stdin/stdout)
[5] stage dist/           → the shippable bundle
```

Zero runtime dependencies is load-bearing: it keeps the exe small, the build simple, and the
test suite instant. Build-time tools (`esbuild`, `postject`) are invoked via `npx --yes`, never
installed into `package.json`. SEA is per-platform — the macOS binary must be built on a Mac.

---

## 11. Configuration surface

All environment variables, read at startup:

| Variable | Default | Effect |
|---|---|---|
| `MEMORY_FILE_PATH` | `~/.lmstudio/resonance-memory.jsonl` | the store (sidecars derive from it) |
| `RESONANCE_MEMORY_CONFIG` | beside the store | live field-toggle config file |
| `EMBED_ENDPOINT` | `http://localhost:1234/v1/embeddings` | OpenAI-compatible embeddings endpoint |
| `EMBED_MODEL` | `text-embedding-nomic-embed-text-v1.5` | embedding model name |
| `RESONANCE_MEMORY_FIELD` | off | default field state when no config file exists |
| `RESONANCE_FIELD_MUTUAL` | on | reciprocal-kNN topology (`0` → directional) |
| `RESONANCE_FIELD_KSEARCH` | 15 | internal search radius for constraint rescue |
| `RESONANCE_CONSTRAINT_GATE` | 0.45 | min cosine for a constraint↔seed bridge |
| `RESONANCE_MEMORY_PANEL_PORT` | 9090 | control-panel port (127.0.0.1 only) |

The embedder is **not bundled** — we depend on the `/v1/embeddings` *interface*, not a specific
model, so any compatible embedding model can be swapped in.

The panel's HTTP surface (`127.0.0.1` only): `GET /`, `GET /api/state`, `GET /api/graph`,
`GET /api/clients`, `GET /api/engine`, `GET /api/system-prompt`, `POST /api/toggle`,
`POST /api/connect|disconnect`, `POST /api/engine/setup`, `POST /api/ping` (heartbeat). This is
not yet a documented stable API (`RM-12`), and has no CSRF/`Origin` check today (watch-item
`W-02`) — worth settling before it becomes a public surface.

---

## 12. Extension seams (where new work plugs in)

The architecture is built to absorb the roadmap without touching the MCP API or forking the
recall path:

- **New store backend** → implement the `JsonlStore` method surface (`RM-07`, SQLite).
- **Write-path cleanup** (extraction, dedup) → in `save()` inside `memory-core.js`, before the
  store append (`RM-01`, `RM-02`). A save must never fail because a cleanup tier did.
- **Hybrid retrieval** → a second ranking arm fused with RRF, behind a flag, promoted only on a
  measured A/B win, with `DEVELOPERS.md` amended in the same PR (`RM-05` — this is the one seam
  that touches the cosine-only invariant, and the process guards it).
- **Scoping / multi-agent** → new record fields resolved from client identity, never from a
  model argument (`RM-06`).
- **Idle consolidation** → a background pass on panel idle, strictly off the recall hot path
  (`RM-10`).

The single rule across all of them: capability goes in the substrate, the four verbs stay
fixed, and no unmeasured signal touches ranking.

---

## 13. Where to read next

- Building or verifying on a real machine → [`HANDOFF.md`](HANDOFF.md).
- What's done, in progress, and open → [`BACKLOG.md`](BACKLOG.md) (`RM-00`…`RM-20`).
- Known defects and the watch list → [`BUGS.md`](BUGS.md).
- Why the roadmap is ordered the way it is → [`COMPETITIVE-ANALYSIS.md`](COMPETITIVE-ANALYSIS.md).
- Deep designs with pseudocode → [`proposed/`](proposed/).
</content>
</invoke>
