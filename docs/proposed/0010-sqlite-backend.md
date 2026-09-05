# 0010 — SQLite backend behind the Store seam (RM-07)

**Status:** proposed (spike measured) · **Backlog:** `RM-07` · **Depends on:** `RM-00`, [`0005`](0005-store-abstraction.md)
**Spike:** [`spike/rm-07-sqlite/`](../../spike/rm-07-sqlite/) — not product; `memory-core.js` / `store.js` untouched.

This RFC extends 0005. 0005 named the seam and guessed `node:sqlite` + `sqlite-vec`. This
document is the **measured** architecture for the backend, after a de-risking spike that
actually opened a db, loaded a vector extension, and re-ran S1 at 50k/100k — the sizes
JSONL cannot load.

---

## Why now (S1 made this a measured GO)

S1 (`eval/substrate/scale.js`, 2026-09-05) tripped RM-07's own bars:

| signal | bar | JSONL | verdict |
|---|---|---|---|
| field-off p95 at 10k | ≤ 100 ms | **488.7 ms** | GO |
| field-off p95 at 50k | ≤ 250 ms | **cannot load** (834 MB > Node ~512 MB string) | GO, harder |
| cosine-only at 50k / 100k | — | ~52 ms / ~113 ms (RamStore) | parse, not cosine |

The bottleneck was `JsonlStore.all()` → `readFileSync` + JSON.parse of embeddings-as-text.
A 50k store with 768-d vectors in JSONL is 834 MB of decimal floats. Cosine itself was
never the thing that forced SQLite.

---

## Constraints (the walls)

1. **Self-contained / portable-on-install.** One per-platform SEA exe. Zero runtime npm
   deps. The engine *and* whatever does vector search ship *inside* the exe — not a
   plugin the user installs.
2. **Data sovereignty.** The user owns the memory and can move it: copy between devices,
   or export and hand it to a competitor. SQLite is a speed/scale engine, not a trap.
3. **Invariants + golden.** Same Store method surface as `JsonlStore` so `memory-core.js`
   stays the single implementation. I5 durable writes. I9 field-off primary byte-identical.
   Four verbs. JSONL↔SQLite migration lossless and reversible.

---

## Spike findings (ran, not reasoned)

Host: Node **v24.18.0**, bundled SQLite **3.53.1**, Windows x64, 128 GB, Ultra 9 285K.
Full tables in [`spike/rm-07-sqlite/results.md`](../../spike/rm-07-sqlite/results.md).

### 1. `node:sqlite` works, including inside a SEA

- CRUD (create / insert / query) on `:memory:` — ok.
- FTS5 is compiled in. `OMIT_LOAD_EXTENSION` is **not** set. `loadExtension` exists.
- Stability 1.1 (active development), flagless since v22.13 / v23.4.
- **SEA:** `build-exe.js` copies `process.execPath`. A mini-SEA of a 20-line
  `require("node:sqlite")` script printed
  `SEA node:sqlite OK node=v24.18.0 sqlite=3.53.1`. The shipped runtime *is* the
  Node used to build. Built here → sqlite is in the exe. Built with Node 18/20 → it
  is not. `package.json` `engines` is still `>=18`; esbuild `--target=node20` is
  syntax only.

### 2. sqlite-vec loads, is correct, and is the wrong default

- `node:sqlite` `DatabaseSync(path, { allowExtension: true })` + `loadExtension(vec0.dll)`
  loaded **sqlite-vec v0.1.9**. Derived entry point worked; no npm package.
- 400 × 768-d random unit vectors: sqlite-vec top-10 **id-identical** to brute-force
  cosine, max `|Δscore|` = **6.5e-8**.
- Quirk: vec0 `rowid` binds must be **BigInt**. A JS `Number` throws
  `Only integers are allowed for primary key values on vec_items`.
- kNN latency vs cached JS cosine (field-off `recall()` through `memory-core`):

  | N | sqlite-vec MATCH | cached JS cosine | packed Float32 scan |
  |---|---|---|---|
  | 10k | 16.4 ms | **10.4 ms** | 6.1 ms |
  | 50k | 79.3 ms | **57.9 ms** | 23.4 ms |
  | 100k | **159.5 ms** | **107.6 ms** | **48.0 ms** |

  sqlite-vec is *slower* than a RAM Float32Array scan at every S1 size. It only
  beats the *uncached* "SELECT blob every query" path. Bundling it costs a
  per-platform `.dll` extracted from the SEA (stock Node cannot statically link
  it) for a path that loses on the number that matters.

### 3. SQLite loads 50k / 100k. JSONL cannot.

Uncached `SpikeSqliteStore` (re-hydrate `current()` every `recall()`, JsonlStore
surface, `memory-core` unchanged):

| N | load | db size | uncached recall p95 | current() hydrate | packed cosine |
|---|---|---|---|---|---|
| 10k | yes | 39.3 MB | 100.1 ms | 81.6 ms | 6.1 ms |
| 50k | **yes** | 196.3 MB | 614.6 ms | 470.5 ms | 23.4 ms |
| 100k | **yes** | 392.7 MB | 1638.8 ms | 1130.7 ms | 48.0 ms |

JSONL: 167 MB / 834 MB (cannot load) / 1.67 GB (cannot load). Binary blobs are
~4× smaller than JSON number arrays, which is why 50k fits.

Uncached p95 is hydrate-bound, not cosine-bound. **A Store-side vector cache**
(hydrate once, then RAM — still the JsonlStore surface; `memory-core` still
calls `current()`) is the number a product Store would ship:

| N | cached-recall p95 | vs JSONL | vs 100 ms bar |
|---|---|---|---|
| 10k | **10.4 ms** | 489 ms | under, ~47× |
| 50k | **57.9 ms** | cannot load | under |
| 100k | **107.6 ms** | cannot load | 7.6 ms over |

S1's hypothesis holds: **SQLite + BLOB + JS cosine, with an in-process cache,
is enough.** Cosine was never the bottleneck. The 100k bar is a hair over
because `memory-core` still maps 100k objects and sorts; packed cosine itself
is 48 ms. Clearing that last 8 ms is `searchDense` (0005), a later slice.

### 4. JSONL export/import is lossless

25 records including 768-d vectors, constraint flag, access_count, a superseded
row: export → stream-import → field-equal, embeddings within 1e-5. The reverse
of migration exists. Streaming import is mandatory — `readFileSync` of the JSONL
we are migrating *is* the S1 wall.

---

## Recommended architecture

### Driver: `node:sqlite` (`DatabaseSync`)

No npm dep, no native build, already in the SEA if we build with Node ≥22.5.
FTS5 comes free for RM-05. WAL + `synchronous=FULL` is the I5 analogue of
`writeFileDurable()`: a committed transaction is atomic and durable. Kill-9
mid-transaction leaves the previous commit; never a truncated store.

**Not** `better-sqlite3` (native dep, SEA fight, last resort, unused). **Not**
`sql.js` (whole DB in memory — half the reason we are here).

Bump `engines` to `>=22.5` (or `>=22.13` if we ever `loadExtension`) and build
the SEA with that Node. esbuild `--target` should follow (syntax). This is an
open decision only in the "which exact floor" sense — 18/20 cannot ship this
backend.

### Vectors: BLOB + in-process Float32Array cache + JS cosine

```sql
CREATE TABLE memories (
  id                INTEGER PRIMARY KEY,
  created           TEXT NOT NULL,
  modified          TEXT NOT NULL,
  text              TEXT NOT NULL,
  embedding         BLOB,                 -- Float32 × 768, 3072 bytes
  importance        REAL DEFAULT 0,
  access_count      INTEGER DEFAULT 0,
  last_access       TEXT,
  valid_from        TEXT NOT NULL,
  valid_to          TEXT,                 -- NULL = current
  last_confirmed    TEXT,
  superseded_by     INTEGER,
  supersedes        INTEGER,
  revision          INTEGER DEFAULT 1,
  needs_review      INTEGER DEFAULT 0,
  embedding_version INTEGER DEFAULT 1,
  source            TEXT DEFAULT 'user_stated',
  is_constraint     INTEGER DEFAULT 0,
  deleted           INTEGER DEFAULT 0
);
CREATE INDEX idx_current ON memories(deleted, valid_to);
```

On open (or first `current()`): load `id, embedding` into a packed
`Float32Array` of N×768 plus an id index. Mutations invalidate the cache.
`current()` returns records with `embedding` attached as `Float32Array`
(*after* `normalize()` — see trap below). Ranking stays cosine in
`memory-core` (I2). No unmeasured signal.

Do **not** ship sqlite-vec in the first implementation slice. Keep the door
open: `searchDense` can swap in a vec0 MATCH later if N>>100k or an ANN is
measured in. That is a packaging decision we do not have to make to clear
the load wall.

### Store method surface — JsonlStore first, 0005 extras later

First landing implements **exactly** `JsonlStore`'s methods so `memory-core.js`
is unchanged:

`all` / `current` / `active` / `get` / `add` / `update` / `updateMany` /
`applyRecall` / `vacuum` / `hasDeleted` / `nextId`

0005's `touch` / `searchDense` / `searchSparse` / `stats` are additive. They
are how we shave 107.6 → <100 ms at 100k (`searchDense` scans the packed
buffer, hydrates only top-k) and how RM-05 gets FTS5. They require a small
`memory-core` change (recall calls `searchDense` when present, else today's
`current()` + cosine). **Not this slice's product code; next slice after
sign-off can land the JsonlStore-surface Store without them.**

### Data sovereignty — lossless JSONL export/import

SQLite is the working copy. JSONL is the interchange format RM already uses.

| Direction | How | Guarantee |
|---|---|---|
| JSONL → SQLite | stream line-at-a-time (`readline` + batched INSERT in one transaction). `.bak` of the JSONL first. Count-verify. | The 834 MB file that cannot `readFileSync` still migrates. |
| SQLite → JSONL | `SELECT *`, reconstruct `normalize()`-shape records, `writeFileDurable`. Embeddings as JSON arrays (the format a competitor's importer can read without RM). | Every column round-trips (spike: 25/25 lossless). |
| RM → RM, same/other device | copy the `.db` **after** `PRAGMA wal_checkpoint(TRUNCATE)` so `-wal`/`-shm` do not have to travel. SQLite files are cross-platform. | Convenience, not the sovereignty path. |

Export is a **maintenance CLI** (like `--dedup-existing`), not a fifth MCP verb.
The four-verb surface does not grow. Panel can later grow a "Export JSONL…"
button that shells the same function.

A user leaving RM hands a `.jsonl` to Mem0/Zep/a script. That is the
anti-hoarding claim; see [`COMPETITIVE-ANALYSIS`](../COMPETITIVE-ANALYSIS.md).

### How the invariants hold

| Invariant | Holds because |
|---|---|
| I2 ranking = cosine only | Cache is a faster load of the same vectors. No durability/recency weight. |
| I3 field fails open | Unchanged: field still `try/catch` around `field.js`. Backend is below that. |
| I5 durable writes; nothing on a read path rewrites the store | WAL transactions for mutations. Recall does not rewrite the db file. `applyRecall` access bumps: see open decision (sidecar vs 5-row UPDATE). Vector backfill on recall stays the legacy-row exception it is today. |
| I6 reading never drives decay | Unchanged (edges sidecar, not the memory store). |
| I9 field on/off primary byte-identical | Ranking still cosine over the same vectors. Backend cannot reorder. |
| Four verbs | No new tool. Export/migrate are CLI. |
| Zero runtime deps | `node:sqlite` is the runtime. No `package.json` `dependencies`. |

### Trap: `normalize()` drops `Float32Array`

`record.normalize()` keeps `embedding` only if `Array.isArray`. A typed array
is a view, not an Array — it becomes `null`. The spike stored NULLs for a
whole run before catching this. Product `SqliteStore` must either:

- attach `embedding` *after* `normalize()`, or
- teach `normalize()` to accept ArrayLike (a behaviour change in `record.js`,
  needs a test that fails without the fix).

Silent vector loss if forgotten. Encode as a test.

### Per-platform packaging

```
build-exe.js copies process.execPath
        ↓
SEA is Node 22.5+/24 with node:sqlite compiled in
        ↓
esbuild leaves `require("node:sqlite")` external (node builtin)
        ↓
no .dll, no .node, no extract-on-first-run
```

If a later slice bundles sqlite-vec: embed `vec0.{dll,so,dylib}` per platform
in the SEA blob, extract to `os.tmpdir()` (or beside the exe) on first open,
`loadExtension` with `allowExtension: true`. Not recommended now.

---

## What we are *not* doing in the implementation slice (until sign-off)

- Ripping out `JsonlStore`. JSONL stays default until SqliteStore passes
  conformance **and** RM-00 golden parity (0005 step 4).
- Changing `memory-core.js` to `searchDense`. First landing is a drop-in
  Store. `searchDense` is the 100k-bar shave, gated separately.
- Adding npm dependencies.
- Auto-migrating user stores on upgrade. Migration is explicit (CLI / first-run
  prompt), reversible, `.bak` always.

---

## Open decisions (Samuel)

These are product calls. The spike is evidence, not a substitute.

1. **Vector path.** Recommend **BLOB + JS cosine + in-process cache, no
   sqlite-vec in v1.** sqlite-vec works and matches brute force, but it is
   slower at 10k–100k than RAM cosine and costs a per-platform `.dll` in the
   SEA. Bundle it later only if N>>100k is measured and RAM cache is the
   problem (307 MB of float32 at 100k; 3 GB at 1M).
2. **SEA Node floor.** Recommend **build and `engines` ≥22.5** (24.x is what
   this box ships). Node 18/20 SEAs cannot include `node:sqlite`. This is a
   user-visible "minimum Node to *build*" change; end users still get an exe.
3. **100k <100 ms bar.** Cached JsonlStore-surface recall is **107.6 ms** at
   100k — 7.6 ms over 0005's acceptance. Options: (a) accept 108 ms for the
   first landing (50k is 58 ms; the load wall is gone); (b) land `searchDense`
   in the same implementation slice (packed 48 ms + hydrate k rows) — a
   `memory-core` change. Recommend **(a) then (b)** so the drop-in Store is
   reviewable without a recall-path diff.
4. **Default backend.** JSONL until golden parity, then SQLite-default with
   JSONL as the export format? Or SQLite-default as soon as conformance is
   green, because JSONL cannot load 50k? Recommend **SQLite default for new
   stores; existing JSONL migrates on first open with `.bak`**, once parity
   is proven. A 50k JSONL user is already stuck.
5. **Move-between-devices story.** `.db` copy (after checkpoint) for RM↔RM;
   JSONL export for leaving RM / handing to a competitor. Recommend **both**,
   with JSONL as the documented sovereignty path (embeddings as JSON, no RM
   needed to read them).
6. **Access counts on recall.** Sidecar (`AccessLog`, letter of I5) vs
   5-row `UPDATE` in SQLite (spirit of I5 / 0005 `touch()`). Recommend
   **in-table UPDATE** — BUG-002 was "rewrite the whole JSONL"; a 5-row
   UPDATE is not that class. Keep the sidecar only if you want byte-identical
   I5 across backends.
7. **`normalize()` ArrayLike embeddings.** Teach `normalize()` to keep
   typed arrays, or always attach after? Recommend **attach after** in
   SqliteStore and add a test; don't change the JSONL migration-on-read
   path unless we have a reason.

---

## Implementation slice (after sign-off) — suggested order

1. `SqliteStore` in `store.js` (or `store-sqlite.js`) with the JsonlStore
   surface, WAL, BLOB embeddings, in-process cache. Flag / env to select
   backend. `memory-core.js` unchanged.
2. Streaming migrator JSONL→SQLite + export SQLite→JSONL. CLI
   `--export-jsonl` / `--migrate-sqlite`. `.bak` + count check.
3. Conformance suite both backends (0005 step 4). Encode BUG-001/002.
4. `normalize()` typed-array trap test.
5. RM-00 golden on SqliteStore — must match JSONL scorecard.
6. Re-run S1 against the product Store at 50k/100k; expect cached-recall
   numbers, not the uncached hydrate curve.
7. Docs (`CLAUDE.md` storage section, BACKLOG tick, COMPETITIVE-ANALYSIS
   already updated here). Default-backend switch is decision 4.

`searchDense` + FTS5 (`searchSparse`) are a *following* slice. They are how
RM-05 gets cheap and how 100k drops under 100 ms.

---

## Risks

| Risk | Mitigation |
|---|---|
| `node:sqlite` still Stability 1.1 | Pin the SEA Node version we tested (24.18.0 / sqlite 3.53.1). Conformance suite. Node 22.5+ has had the API for a year; 1.1 is "may still move", not "broken". |
| SEA built with Node <22.5 | `engines` bump + CI/build Node pin. Mini-SEA smoke in the spike is the regression test to keep. |
| Cache staleness | Invalidate on `add`/`update`/`updateMany`/`vacuum`. Single-threaded MCP process: no reader/writer race. |
| Migration of an 834 MB JSONL | Stream. Never `readFileSync` the whole file. `.bak` + count. |
| Two backends drift | Conformance + golden. Same `memory-core`. |
| RAM at 100k (cache ~300 MB of float32) | Fine on any machine that was trying to hold an 834 MB JSONL string. At 1M, revisit sqlite-vec / mmap. |
| `normalize()` silent vector drop | Test. Attach after. |

---

## Acceptance (for the implementation slice, not this RFC)

Carried from 0005, updated with measured numbers:

- 50k memories: load succeeds; field-off recall p95 <100 ms with the cache
  (spike: 57.9 ms).
- 100k memories: load succeeds; p95 is <110 ms on the JsonlStore surface
  (spike: 107.6 ms) and <100 ms once `searchDense` lands (packed cosine 48 ms).
- No full-file rewrite on any read path.
- Both backends pass conformance; RM-00 golden is identical.
- JSONL↔SQLite round-trip lossless (count + field equality, embeddings
  within 1e-5).
- Kill-9 mid-write leaves a readable store (WAL).
- **No change to the four MCP verbs.**
- `package.json` still has no `dependencies` block.

---

## Related

[[0005]] · [[BACKLOG]] · [[COMPETITIVE-ANALYSIS]] · [[ARCHITECTURE]] · [[spike/rm-07-sqlite]]
