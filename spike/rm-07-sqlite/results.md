# RM-07 spike results

Generated 2026-09-05T14:00:24.112Z on win32/x64, Node v24.18.0, bundled SQLite 3.53.1.

**This is a spike, not the product.** `memory-core.js` / `store.js` were not modified.

## Host

- Node: `v24.18.0` at `C:\Program Files\nodejs\node.exe`
- `process.versions.sqlite`: `3.53.1`
- CPU: Intel(R) Core(TM) Ultra 9 285K
- RAM: 127.3 GB

## SEA vs `node:sqlite`

```json
{
  "story": {
    "build_copies_process_execPath": true,
    "esbuild_js_target": "node20",
    "package_engines": ">=18",
    "this_process": "v24.18.0",
    "this_sqlite": "3.53.1",
    "node_sqlite_requireable": true,
    "node_sqlite_needs": ">=22.5.0 (module); loadExtension() since v22.13 / v23.5",
    "experimental": "Stability 1.1 Active development; flagless since v23.4 / v22.13"
  },
  "smoke": {
    "ok": true,
    "status": 0,
    "stdout": "SEA node:sqlite OK node=v24.18.0 sqlite=3.53.1 exec=C:\\Users\\spamw\\Desktop\\resonance-memory-workshop\\spike\\rm-07-sqlite\\tmp\\sea\\sea-smoke.exe",
    "stderr": ""
  },
  "extension_story": {
    "node_sqlite_in_sea": "yes, if the build Node is ≥22.5 (copied execPath contains the module)",
    "sqlite_vec_in_sea": "loadExtension works in this Node; SEA would need the .dll extracted beside the exe or to a temp path. Stock Node cannot statically link sqlite-vec. allowExtension:true is required at DatabaseSync construction."
  }
}
```

## `node:sqlite` CRUD

- ok: **true**
- FTS5 compiled in: **true**
- `OMIT_LOAD_EXTENSION`: false

## sqlite-vec `loadExtension()`

```json
{
  "dll": "C:\\Users\\spamw\\Desktop\\resonance-memory-workshop\\spike\\rm-07-sqlite\\vendor\\vec0.dll",
  "ok": true,
  "version": "v0.1.9",
  "entry": "(derived)",
  "attempts": [
    {
      "entry": "(derived)",
      "ok": true,
      "version": "v0.1.9"
    }
  ]
}
```

## Vector correctness (400 × 768-d vs brute-force cosine)

```json
{
  "n": 400,
  "dim": 768,
  "k": 10,
  "brute_top_ids": [
    1,
    331,
    293,
    193,
    111,
    14,
    332,
    94,
    189,
    357
  ],
  "blob_js_top_ids": [
    1,
    331,
    293,
    193,
    111,
    14,
    332,
    94,
    189,
    357
  ],
  "packed_top_ids": [
    1,
    331,
    293,
    193,
    111,
    14,
    332,
    94,
    189,
    357
  ],
  "blob_js_matches_brute": true,
  "packed_matches_brute": true,
  "self_cosine": 1,
  "sqlite_vec": {
    "ok": true,
    "ddl": "CREATE VIRTUAL TABLE vec_items USING vec0(embedding FLOAT[768] distance_metric=cosine)",
    "sql": "SELECT rowid AS id, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT 10",
    "ids_match": true,
    "vec_ids": [
      1,
      331,
      293,
      193,
      111,
      14,
      332,
      94,
      189,
      357
    ],
    "brute_ids": [
      1,
      331,
      293,
      193,
      111,
      14,
      332,
      94,
      189,
      357
    ],
    "max_abs_delta": 6.512323796892261e-8,
    "sample": [
      {
        "id": 1,
        "distance": 0,
        "score": 1
      },
      {
        "id": 331,
        "distance": 0.8864397406578064,
        "score": 0.1135602593421936
      },
      {
        "id": 293,
        "distance": 0.891514241695404,
        "score": 0.10848575830459595
      },
      {
        "id": 193,
        "distance": 0.8999980092048645,
        "score": 0.1000019907951355
      },
      {
        "id": 111,
        "distance": 0.9042498469352722,
        "score": 0.09575015306472778
      }
    ]
  }
}
```

## JSONL export/import (data sovereignty)

```json
{
  "exported_lines": 25,
  "imported": 25,
  "lossless": true,
  "mismatches": [],
  "jsonl_bytes": 49566
}
```

## S1 scale — SpikeSqliteStore, field-off `recall()` through unchanged `memory-core.js`

JSONL baseline (S1, 2026-09-05): field-off p95 **488.7 ms at 10k**; **cannot load 50k** (834 MB > ~512 MB string).
In-memory cosine only (S1 RamStore): ~52 ms at 50k, ~113 ms at 100k.

| N | load ok | recall p50 | recall p95 | recall p99 | current() hydrate | packed cosine | searchDense | db size | sqlite-vec kNN |
|---|---------|------------|------------|------------|-------------------|---------------|-------------|---------|----------------|
| 10000 | YES | 94.2 | 100.1 | 100.5 | 81.6 | 6.1 | 71.9 | 39.3 MB | 16.4 |
| 50000 | YES | 493.5 | 614.6 | 614.6 | 470.5 | 23.4 | 361.0 | 196.3 MB | 79.3 |
| 100000 | YES | 1507.7 | 1638.8 | 1638.8 | 1130.7 | 48.0 | 962.9 | 392.7 MB | n/a |

## Cached `current()` (the Store a product would actually ship)

Uncached numbers above re-hydrate every recall — honest for a naive Store, not
what we would ship. `measure-cached.js` hydrates once, then serves the same
records from RAM through unchanged `memory-core.recall` (JsonlStore surface).

| N | hydrate once | cached-recall p50 | cached-recall p95 | vs JSONL S1 | vs 100 ms bar |
|---|--------------|-------------------|-------------------|-------------|---------------|
| 10 000 | 103.9 ms | 9.5 ms | **10.4 ms** | JSONL p95 488.7 ms | under |
| 50 000 | 481.8 ms | 52.3 ms | **57.9 ms** | JSONL cannot load | under |
| 100 000 | 1091.1 ms | 105.6 ms | **107.6 ms** | JSONL cannot load | **7.6 ms over** |

Packed cosine alone (no object map): 6.1 / 23.4 / **48.0 ms** at 10k/50k/100k.

## sqlite-vec at 100k

`measure-vec-100k.js`: 100k × 768-d into `vec0`, `MATCH` k=5, 8 trials.
p50 **159.5 ms** (max 161.2 ms) — *slower* than cached JS cosine (107.6 ms)
and slower than packed cosine (48.0 ms). At 50k the same pattern: vec 79.3 ms
vs cached JS 57.9 ms. sqlite-vec wins only against the *uncached* blob scan.

`node:sqlite` + vec0 quirk: `rowid` binds must be **BigInt**. A JS `Number`
throws `Only integers are allowed for primary key values on vec_items`.

## Findings

- SEA runtime === the Node used to build. This box is v24.18.0 (sqlite 3.53.1),
  which is ≥22.5, so a SEA built HERE embeds `node:sqlite`. A SEA built with
  Node 18/20 would NOT. `engines` is still `>=18` and esbuild `--target=node20`
  — both would need a bump before shipping SqliteStore.
- Mini-SEA smoke **passed**: `SEA node:sqlite OK node=v24.18.0 sqlite=3.53.1`.
- `loadExtension(vec0.dll)` works in this Node (`allowExtension: true` at
  construction). A SEA would still need the `.dll` extracted to disk; stock
  Node cannot statically link sqlite-vec.
- FTS5 is compiled into Node's SQLite. RM-05's keyword arm is available
  without an extension.
- `record.normalize()` drops `Float32Array` embeddings (`Array.isArray` only).
  A SqliteStore that hydrates typed arrays must attach them *after* normalize,
  or teach `normalize()` to accept ArrayLike. Silent vector loss if you forget.
- JSONL→SQLite migration **must stream**. `readFileSync` of a 50k-with-vectors
  JSONL is the S1 wall; line-at-a-time import is the only migrator that works
  on the stores that forced this work.

Reproduce: `node spike/rm-07-sqlite/run.js` then
`node spike/rm-07-sqlite/measure-cached.js` (S1 cache at `eval/substrate/.cache/`).
