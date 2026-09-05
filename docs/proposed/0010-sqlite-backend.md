# 0010 — SQLite backend behind the Store seam (RM-07)

**Status:** slice 1 shipped (drop-in `SqliteStore`) · slice 2a shipped (streaming JSONL→SQLite migrator, opt-in CLI) · **slice 3 shipped** (RM-00 golden on SqliteStore = JSONL 27/31 case-for-case) · JSONL still default · **Backlog:** `RM-07` · **Depends on:** `RM-00`, [`0005`](0005-store-abstraction.md)
**Spike:** [`spike/rm-07-sqlite/`](../../spike/rm-07-sqlite/) — de-risked the driver and the vector path.
**Product:** `store-sqlite.js` `SqliteStore`, same JsonlStore method surface, `memory-core.js` verbs unchanged.

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
| JSONL → SQLite | Stream line-at-a-time (`readline` + batched INSERT in one transaction) into a temp `.db.migrating`. Count-verify. WAL checkpoint. Atomic rename to `.db`. **Then** rename JSONL → `.jsonl.bak`. See [the 10-step protocol](#the-10-step-commit-protocol). | The 834 MB file that cannot `readFileSync` still migrates. 50k/768-d proof: **lossless in 2.5 s**. |
| SQLite → JSONL | `SELECT *`, reconstruct `normalize()`-shape records, `writeFileDurable`. Embeddings as JSON arrays (the format a competitor's importer can read without RM). **Slice 2b** (`--export-jsonl` / zip bundle). | Every column round-trips (spike: 25/25 lossless). |
| RM → RM, same/other device | copy the `.db` **after** `PRAGMA wal_checkpoint(TRUNCATE)` so `-wal`/`-shm` do not have to travel. SQLite files are cross-platform. | Convenience, not the sovereignty path. |

**`.bak` is a recovery snapshot, not the sovereignty export.** The retained JSONL is a
*pre-migration* copy: it goes stale on the next save to the `.db`. A downgraded exe
must not serve it, which is why it is renamed *off* `MEMORY_FILE_PATH`. The live
sovereignty artifact is slice 2b's `--export-jsonl` / zip bundle of the `.db` as it
stands now. Two artifacts, two jobs. Do not `copyFile` to `.bak` *and* keep the
original — that is two full copies of an 834 MB file; one retained original (the
rename) is enough.

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
| I5 durable writes; no *unbounded* write on a read path | Restated (ARCHITECTURE / CLAUDE / AGENTS now agree): writes are atomic + durable; a read path must not perform an unbounded / full-corpus rewrite; retention metadata MAY be updated on recall if that update is bounded, atomic, and cannot truncate the store. **JSONL** = AccessLog sidecar (unchanged). **SQLite** = one `BEGIN`/`UPDATE`/`COMMIT` of the ~5 returned ids, `synchronous=FULL`. Vector backfill of vectorless rows stays the self-extinguishing I4/I5 exception. |
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

## Slice 1 (shipped) — drop-in `SqliteStore`

Landed. Selectable, not the default.

- Driver: `node:sqlite` `DatabaseSync`. No npm `dependencies`. WAL +
  `synchronous=FULL`. `engines` ≥22.5; esbuild `--target=node22`.
- Schema: `memories` table, `normalize()` fields as columns, opaque `id`
  preserved (never AUTOINCREMENT-renumbered), `created` a real TEXT column,
  embedding a Float32 BLOB. Access counts **in the row**. `SqliteStore`
  never constructs `AccessLog` (BUG-007).
- Vectors: BLOB + in-process record cache (hydrate once) + JS cosine in
  `memory-core`. No sqlite-vec.
- `normalize()` still drops `Float32Array`; the store attaches after.
  Encoded as a regression test.
- Selectability: `RESONANCE_STORE=sqlite` or live-config `store: "sqlite"`.
  Sibling path `*.jsonl` → `*.db`. Default remains JsonlStore.
- I5 operationalized per backend as above. BUG-002 SQLite test: after
  recall, only retention columns changed on the returned rows; row count
  unchanged.
- Conformance: same save/recall/edit/delete/all/vacuum/retention ops on
  both backends, identical observables.
- Product S1 (2026-09-05, this slice, `--store sqlite --n 50000,100000
  --no-field --latency-only --offline`): **loads** 50k (206 MB) and 100k
  (412 MB). Field-off cached recall p95 **49.6 ms @50k, 96.4 ms @100k**.
  JSONL cannot load either size. The 100k <100 ms bar is cleared on the
  JsonlStore surface without `searchDense`.

## What this slice is *not* (later slices)

- Ripping out `JsonlStore`. JSONL stays default until the slice-4 switch.
  Slice 3 (below) proved RM-00 golden parity; eval default is still JSONL.
- Changing `memory-core.js` to `searchDense`. First landing is a drop-in
  Store. `searchDense` is a later shave (packed cosine was 48 ms at 100k
  in the spike); the product cache already cleared 100 ms.
- Adding npm dependencies.
- Auto-migrating user stores on upgrade / first open. Slice 2a is the
  **opt-in CLI** (`--migrate`). The first-open hook is the default-switch
  slice 4 — do not wire it yet (keeps the RM-00 golden on JSONL).
- Export/zip/folder tree (slice 2b). The `.bak` from `--migrate` is a
  recovery snapshot, not that export.
- Edges-in-db. Named fast-follow; EdgeStore API stays, persistence adapter
  later.

## Slice 2a (shipped) — streaming JSONL→SQLite migrator

Landed. Opt-in CLI, not the default, not auto-run on server startup.

Product: `migrate-sqlite.js`, `node entry.js --migrate` / `npm run migrate`.
`memory-core.js` unchanged. JSONL stays the default backend so `node eval/run.js`
stays green trivially.

### The 10-step commit protocol

Settled across the design rounds. This is the data-safety spine — implement
exactly, do not "improve" the order:

1. If `<store>.db` exists and opens → it is live; a leftover `<store>.jsonl`
   is **IGNORED** (log it). Never dual-read.
2. If only `<store>.jsonl` exists → create `<store>.db.migrating` (temp).
   **STREAM** the JSONL line-at-a-time (`readline` over a read stream —
   **NEVER** `readFileSync`; that IS the S1 834 MB wall). Batched INSERT
   inside one transaction.
3. **Preserve ids** exactly — the opaque id, `superseded_by`, all provenance.
   NO AUTOINCREMENT renumber (edges + the ids the model already saw depend
   on it).
4. Fold the `<store>.access.json` (AccessLog) counts into the row columns
   **ONCE, at ingest** (BUG-007). `SqliteStore` never constructs AccessLog.
5. Count-verify: migrated row count === source line count (minus blanks);
   embeddings-present-iff-source-had-them (don't silently drop or invent
   vectors). A mismatch = abort, keep the JSONL, delete the temp.
6. WAL checkpoint (`wal_checkpoint(TRUNCATE)`) on the temp db so it's a
   clean single file at rest.
7. Atomic rename `<store>.db.migrating` → `<store>.db`.
8. **THEN** rename `<store>.jsonl` → `<store>.jsonl.bak` and
   `<store>.access.json` → `.bak`. Recovery snapshots — NOT the sovereignty
   export. Rename OFF `MEMORY_FILE_PATH` so a downgraded exe can't serve
   the stale JSONL.
9. Failure BEFORE step 7 → JSONL is still live at its path, delete the
   temp `.db`, retry next run. **NO resume-from-partial.**
10. Log: `migrated N memories; original kept at <path>.bak`.

Do **not**: `copyFile` to `.bak` AND rename to `.migrated` (two full copies
of an 834 MB file); dual-write JSONL after migration; add a "switch back
to JSONL" env (footgun). `JsonlStore` stays for tests / conformance / export.

An empty `.db` sitting beside a still-live JSONL is the `openStore()`-created
footgun, not a completed migrate (a completed migrate would have renamed
JSONL off the path). `--migrate` refuses that state rather than ignore the
JSONL. `openStore({backend: sqlite})` warns when a sibling JSONL exists and
the `.db` is missing — it still does not auto-migrate this slice.

Kill-9 before step 7: JSONL stays at its path, no half `.db` sits at
`MEMORY_FILE_PATH`, leftover `.db.migrating` is dropped on the next run
(no resume-from-partial), re-run completes.

### 50k lossless proof (2026-09-05)

S1 generator, 50k records, 768-d synthetic vectors, access sidecar fold,
a vectorless row, a 2019 `created`, a superseded pair, a deleted row.
`node eval/substrate/migrate-proof.js`.

| | |
|---|---|
| JSONL size | **785.3 MB** (823,425,829 bytes) |
| `readFileSync` | **FAILED** — `Cannot create a string longer than 0x1fffffe8 characters` (the S1 wall) |
| stream-migrate | **2.456 s** → 50,000 rows, 196.3 MB `.db` |
| lossless | **yes** — 50k/50k field-equal, embeddings within 1e-5, ids preserved, `created` preserved, access 2+3=5 (not doubled to 8), vectorless stayed vectorless |

The stream is the thing that beats the wall. Holding 50k parsed objects is
fine on this box; materializing the JSONL as one UTF-8 string is not.

---

## Slice 3 (shipped) — RM-00 golden on SqliteStore

Landed. The drop-in contract: same `memory-core.js`, different Store, **identical
scorecard**. This is the bar that unblocks the default switch (slice 4) — after
2b export/zip, so migration does not open a lock-in window.

Product: `eval/run.js --store sqlite` (also `RESONANCE_STORE=sqlite`; `--store`
wins). `eval/pipeline.js` is unchanged — the Store is injected; sqlite vs jsonl
is `openStore({ backend })` in the runner. Offline + deterministic: vectors
still come from `eval/embeddings.cache.json`; SqliteStore holds them as
Float32 BLOBs for the run. The sqlite gate is **two-sided parity** against
`golden.json` (fail→pass is as much a STOP as pass→fail). `--accept` is
jsonl-only so an f32 quirk cannot rewrite the lock.

### Scorecard (2026-09-05)

Both backends: **27/31**, same cases passing and failing. No flips.

| | jsonl (default) | sqlite (`--store sqlite`) |
|---|---|---|
| TOTAL | 27/31 | 27/31 |
| field lifted fail→pass | 3 | 3 |
| field BROKE | 1 (`adv-height-homonym`) | 1 (same) |
| ROC off / on | 1/4 / 4/4 | 1/4 / 4/4 |
| TBR off / on | 0/4 / 1/4 | 0/4 / 1/4 |
| gate | No regressions vs golden. | SqliteStore scorecard matches golden case-for-case. |

Reproduce: `node eval/run.js` and `node eval/run.js --store sqlite`. Side-by-side
in [`eval/RESULTS.md`](../../eval/RESULTS.md) "RM-07 slice 3".

### f32 vs f64 (the near-tie watch)

JsonlStore persists embeddings as JSON number arrays (IEEE-754 float64).
SqliteStore packs Float32 BLOBs. Cosine of a 768-d unit vector could in
principle differ in the ~7th decimal and swap a rank-5/6 near-tie, or
push a pair across `DEDUP_HI` 0.95. **On this corpus it did not, and
the reason is measured, not hoped:**

- Every component in `eval/embeddings.cache.json` (354 vectors, 271,872
  floats, `nomic-embed-text-v1.5`) is already an exact f32:
  `Math.fround(x) === x` for all of them. Packing is lossless. Pairwise
  `|cos(f64,f64) − cos(f64, f32)|` over the cache is **0**.
- Tightest HI pair (tea): cosine **0.952246** on both paths, **0.002246**
  above `DEDUP_HI` 0.95. That margin is three orders above f32 ulp; a
  band flip would need a bug, not rounding.
- Primary-hit **text** order was identical on all 31 golden checks
  (opaque ids differ because `nextId()` is `Date.now()` per save).

No tolerance was added to the parity gate. A silent epsilon would hide a
genuine inequivalence; this run did not need one. If a future embedder
emits values that are not f32-exact and a case actually flips, the honest
move is to name the case and decide then — not to pre-paper the gate.

This clears the default-switch *eval* gate. Slice 2b (export/zip/panel)
must still land first so a migrated user can leave.

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
   is proven. A 50k JSONL user is already stuck. **Parity is now proven
   (slice 3, 27/31 case-for-case).** Slice 2b export still gates the
   switch so migration is not a lock-in.
5. **Move-between-devices story.** `.db` copy (after checkpoint) for RM↔RM;
   JSONL export for leaving RM / handing to a competitor. Recommend **both**,
   with JSONL as the documented sovereignty path (embeddings as JSON, no RM
   needed to read them).
6. **Access counts on recall.** **Settled this slice.** I5 restated (no
   letter-vs-spirit exception): JSONL keeps the AccessLog sidecar for as
   long as it is a live write path; SQLite does a bounded in-table `UPDATE`
   of the returned ids. `SqliteStore` never constructs `AccessLog`.
7. **`normalize()` ArrayLike embeddings.** Teach `normalize()` to keep
   typed arrays, or always attach after? Recommend **attach after** in
   SqliteStore and add a test; don't change the JSONL migration-on-read
   path unless we have a reason.

---

## Implementation slice (after sign-off) — suggested order

1. `SqliteStore` in `store.js` (or `store-sqlite.js`) with the JsonlStore
   surface, WAL, BLOB embeddings, in-process cache. Flag / env to select
   backend. `memory-core.js` unchanged.
2. Streaming migrator JSONL→SQLite (**slice 2a, shipped** — `--migrate`) +
   export SQLite→JSONL (**slice 2b** — `--export-jsonl` / zip bundle). `.bak`
   is the recovery snapshot from 2a, not the export.
3. Conformance suite both backends (0005 step 4). Encode BUG-001/002.
4. `normalize()` typed-array trap test.
5. RM-00 golden on SqliteStore — must match JSONL scorecard. **Shipped (slice 3).**
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
