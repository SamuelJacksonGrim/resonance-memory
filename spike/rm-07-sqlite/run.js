#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See <https://www.gnu.org/licenses/>.
 */
/*
 * SPIKE runner for RM-07. Not product. Does not touch memory-core.js,
 * store.js, or the golden path. Run:
 *
 *   node spike/rm-07-sqlite/run.js
 *   node spike/rm-07-sqlite/run.js --skip-sea --n 10000,50000
 *
 * Writes results.json + results.md next to this file.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execSync, spawnSync } = require("child_process");
const {
  SpikeSqliteStore, cosine, cosinePacked, topKFromScores,
  embeddingToBlob, blobToF32, exportJsonlDurable, importJsonl, DIM,
} = require("./proto-store.js");
const { generateScaleCorpus, DEFAULT_SEED } = require("../../eval/substrate/generate.js");
const { createMemory } = require("../../eval/pipeline.js");
const { normalize } = require("../../record.js");

const HERE = __dirname;
const VENDOR = path.join(HERE, "vendor");
const TMP = path.join(HERE, "tmp");
const CACHE_DIR = path.join(__dirname, "..", "..", "eval", "substrate", ".cache");
const INDEX_PATH = path.join(CACHE_DIR, "index.json");
const VEC_PATH = path.join(CACHE_DIR, "vectors.f32");
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-nomic-embed-text-v1.5";
const VEC_URL = "https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/sqlite-vec-0.1.9-loadable-windows-x86_64.tar.gz";

const results = {
  generated: new Date().toISOString(),
  host: {
    node: process.version,
    sqlite: process.versions.sqlite,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().map((c) => c.model)[0],
    totalmem_gb: +(os.totalmem() / 1073741824).toFixed(1),
  },
  sea: {},
  node_sqlite: {},
  sqlite_vec: {},
  vector_correctness: {},
  sovereignty: {},
  fts5: {},
  scale: [],
  findings: [],
};

function log(s) { process.stdout.write(s + "\n"); }
function hrMs(t0) { return Number(process.hrtime.bigint() - t0) / 1e6; }
function fmt(ms) { return (Math.round(ms * 10) / 10).toFixed(1); }
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function hash16(t) {
  return crypto.createHash("sha256").update(String(t)).digest("hex").slice(0, 16);
}

function rmDb(file) {
  for (const extra of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(file + extra); } catch { /* */ }
  }
}

function parseNs(argv) {
  const flag = argv.find((a) => a.startsWith("--n"));
  if (!flag) return [10000, 50000, 100000];
  const raw = flag.includes("=") ? flag.split("=")[1] : argv[argv.indexOf(flag) + 1];
  return String(raw || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
}

function trialsFor(n) {
  if (n <= 1000) return 40;
  if (n <= 10000) return 20;
  if (n <= 50000) return 12;
  return 8;
}

// ---- 1. SEA / Node version story -----------------------------------------

function inspectSeaStory() {
  log("\n== 1. SEA Node version vs node:sqlite ==");
  const buildExe = fs.readFileSync(path.join(__dirname, "..", "..", "build-exe.js"), "utf8");
  const copiesExec = buildExe.includes("fs.copyFileSync(process.execPath, outExe)");
  const esbuildTarget = (buildExe.match(/--target=(node\d+)/) || [])[1] || "unknown";
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
  const engines = (pkg.engines && pkg.engines.node) || "unspecified";
  const sqliteMod = (() => {
    try { require("node:sqlite"); return true; } catch { return false; }
  })();
  const story = {
    build_copies_process_execPath: copiesExec,
    esbuild_js_target: esbuildTarget,
    package_engines: engines,
    this_process: process.version,
    this_sqlite: process.versions.sqlite || null,
    node_sqlite_requireable: sqliteMod,
    node_sqlite_needs: ">=22.5.0 (module); loadExtension() since v22.13 / v23.5",
    experimental: "Stability 1.1 Active development; flagless since v23.4 / v22.13",
  };
  results.sea.story = story;
  log("  SEA copies process.execPath: " + copiesExec);
  log("  esbuild JS target: " + esbuildTarget + " (syntax only; runtime is the copied node)");
  log("  package.json engines: " + engines);
  log("  this process: " + process.version + " sqlite=" + process.versions.sqlite);
  log("  node:sqlite requireable: " + sqliteMod);
  if (copiesExec) {
    results.findings.push(
      "SEA runtime === the Node used to build. This box is " + process.version +
      " (sqlite " + process.versions.sqlite + "), which is ≥22.5, so a SEA built HERE " +
      "embeds node:sqlite. A SEA built with Node 18/20 would NOT. engines is still \">=18\" " +
      "and esbuild --target=node20 — both would need a bump before shipping SqliteStore."
    );
  }
}

// ---- 2. node:sqlite CRUD -------------------------------------------------

function proveNodeSqlite() {
  log("\n== 2. node:sqlite CRUD ==");
  const db = new (require("node:sqlite").DatabaseSync)(":memory:");
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL);");
  const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
  ins.run("hello");
  ins.run("world");
  const rows = db.prepare("SELECT id, v FROM t ORDER BY id").all();
  const compile = db.prepare("PRAGMA compile_options").all().map((r) => r.compile_option || r.Compile_option || Object.values(r)[0]);
  const fts5 = compile.some((c) => /FTS5/i.test(String(c)));
  const json1 = compile.some((c) => /JSON/i.test(String(c)));
  const omitLoad = compile.some((c) => /OMIT_LOAD_EXTENSION/i.test(String(c)));
  results.node_sqlite = {
    ok: rows.length === 2 && rows[0].v === "hello",
    rows,
    compile_options_sample: compile.slice(0, 20),
    fts5, json1, omit_load_extension: omitLoad,
    methods: Object.getOwnPropertyNames(Object.getPrototypeOf(db)).sort(),
  };
  results.fts5 = { available: fts5 };
  log("  insert+query: " + JSON.stringify(rows));
  log("  FTS5: " + fts5 + "  JSON1: " + json1 + "  OMIT_LOAD_EXTENSION: " + omitLoad);
  db.close();
  if (!results.node_sqlite.ok) throw new Error("node:sqlite CRUD failed");
  log("  OK");
}

// ---- 3. sqlite-vec loadable extension ------------------------------------

async function downloadSqliteVec() {
  fs.mkdirSync(VENDOR, { recursive: true });
  const existing = findVecDll();
  if (existing) return existing;
  log("  downloading " + VEC_URL);
  const tarPath = path.join(VENDOR, "sqlite-vec-windows.tar.gz");
  const res = await fetch(VEC_URL, { redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("download HTTP " + res.status);
  fs.writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
  execSync("tar -xf \"" + tarPath + "\"", { cwd: VENDOR, stdio: "inherit" });
  return findVecDll();
}

function findVecDll() {
  function walk(dir, depth) {
    if (depth < 0 || !fs.existsSync(dir)) return null;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        const hit = walk(p, depth - 1);
        if (hit) return hit;
      } else if (/^vec0.*\.(dll|so|dylib)$/i.test(name) || /^sqlite-vec.*\.(dll|so|dylib)$/i.test(name)) {
        return p;
      }
    }
    return null;
  }
  return walk(VENDOR, 3);
}

function tryLoadVec(dllPath) {
  const { DatabaseSync } = require("node:sqlite");
  const attempts = [];
  const entryPoints = [undefined, "sqlite3_vec_init", "sqlite3_vec0_init"];
  for (const entry of entryPoints) {
    let db;
    try {
      db = new DatabaseSync(":memory:", { allowExtension: true });
      if (typeof db.enableLoadExtension === "function") db.enableLoadExtension(true);
      if (entry) db.loadExtension(dllPath, entry);
      else db.loadExtension(dllPath);
      const ver = db.prepare("SELECT vec_version() AS v").get();
      attempts.push({ entry: entry || "(derived)", ok: true, version: ver && ver.v });
      db.close();
      return { ok: true, version: ver && ver.v, entry: entry || "(derived)", attempts };
    } catch (e) {
      attempts.push({ entry: entry || "(derived)", ok: false, error: String(e && e.message || e) });
      try { if (db) db.close(); } catch { /* */ }
    }
  }
  // Also prove the allowExtension gate.
  let gate;
  try {
    const db2 = new DatabaseSync(":memory:");
    try {
      db2.enableLoadExtension(true);
      gate = "enableLoadExtension succeeded WITHOUT allowExtension (unexpected)";
    } catch (e) {
      gate = "enableLoadExtension without allowExtension threw: " + String(e.message || e);
    }
    try { db2.close(); } catch { /* */ }
  } catch (e) {
    gate = "DatabaseSync() threw: " + String(e.message || e);
  }
  return { ok: false, attempts, gate };
}

async function proveSqliteVec() {
  log("\n== 3. sqlite-vec loadExtension ==");
  let dll;
  try {
    dll = await downloadSqliteVec();
  } catch (e) {
    results.sqlite_vec = { ok: false, error: "download failed: " + String(e && e.message || e) };
    log("  download FAILED: " + results.sqlite_vec.error);
    results.findings.push("Could not obtain sqlite-vec loadable extension: " + results.sqlite_vec.error);
    return;
  }
  if (!dll) {
    results.sqlite_vec = { ok: false, error: "tarball extracted but no vec0.dll found", vendor: fs.readdirSync(VENDOR) };
    log("  no vec0.dll in vendor/. listing: " + results.sqlite_vec.vendor.join(", "));
    return;
  }
  log("  extension path: " + dll);
  const loaded = tryLoadVec(dll);
  results.sqlite_vec = Object.assign({ dll }, loaded);
  if (loaded.ok) {
    log("  LOADED vec_version=" + loaded.version + " entry=" + loaded.entry);
  } else {
    log("  LOAD FAILED");
    for (const a of loaded.attempts) log("    entry " + a.entry + ": " + (a.ok ? "ok" : a.error));
    if (loaded.gate) log("    gate: " + loaded.gate);
  }
}

// ---- 4. vector correctness (few hundred 768-d) ---------------------------

function randomUnit(dim, rng) {
  const v = new Float32Array(dim);
  let n = 0;
  for (let i = 0; i < dim; i++) {
    // Box-Muller-ish via two uniforms; fine for a unit-vector set.
    const u = rng() * 2 - 1;
    v[i] = u;
    n += u * u;
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function bruteTopK(vectors, query, k) {
  const scored = vectors.map((v, i) => ({ id: i + 1, score: cosine(query, v) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function proveVectorCorrectness() {
  log("\n== 4. vector correctness (400 × 768-d) ==");
  const N = 400, K = 10, dim = DIM;
  const rng = mulberry32(0x524d3037);
  const vectors = [];
  for (let i = 0; i < N; i++) vectors.push(randomUnit(dim, rng));
  const query = vectors[0]; // nearest-to-self should be id 1 with score ~1

  const file = path.join(TMP, "vec-correct.db");
  rmDb(file);
  const store = new SpikeSqliteStore(file);
  // Do not pre-normalize: record.normalize() drops Float32Array embeddings
  // (only Array.isArray survives). _bind blobs the typed array itself.
  const recs = vectors.map((v, i) => ({
    id: i + 1, text: "vec-" + (i + 1), embedding: v, created: "2026-01-01T00:00:00.000Z",
  }));
  store.addMany(recs);
  const stored = store.db.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS with_vec FROM memories"
  ).get();
  log("  stored rows=" + stored.n + " with_vec=" + stored.with_vec);

  const brute = bruteTopK(vectors, query, K);
  const blob = store.searchDense(query, { limit: K });
  const packed = store.loadPacked();
  const packedScores = cosinePacked(query, packed.packed, packed.n, packed.dim);
  const packedTop = topKFromScores(packed.ids, packedScores, K);

  function idsOf(rows) { return rows.map((r) => String(r.id)).join(","); }
  const blobMatch = idsOf(blob) === idsOf(brute);
  const packedMatch = idsOf(packedTop) === idsOf(brute);
  const selfScore = brute[0].score;

  let vecMatch = null;
  if (results.sqlite_vec && results.sqlite_vec.ok) {
    try { vecMatch = runSqliteVecKnn(vectors, query, K, brute); }
    catch (e) { vecMatch = { ok: false, error: String(e && e.message || e) }; }
  }

  results.vector_correctness = {
    n: N, dim, k: K,
    brute_top_ids: brute.map((r) => r.id),
    blob_js_top_ids: blob.map((r) => r.id),
    packed_top_ids: packedTop.map((r) => r.id),
    blob_js_matches_brute: blobMatch,
    packed_matches_brute: packedMatch,
    self_cosine: selfScore,
    sqlite_vec: vecMatch,
  };
  log("  brute top-10 ids: " + idsOf(brute));
  log("  blob+JS  match brute: " + blobMatch);
  log("  packed   match brute: " + packedMatch);
  log("  self cosine (expect ~1): " + selfScore.toFixed(6));
  if (vecMatch) {
    log("  sqlite-vec match brute ids: " + vecMatch.ids_match + "  max |Δscore|=" + vecMatch.max_abs_delta);
  } else {
    log("  sqlite-vec: skipped (extension not loaded)");
  }
  store.close();
}

function runSqliteVecKnn(vectors, query, k, brute) {
  const { DatabaseSync } = require("node:sqlite");
  const dll = results.sqlite_vec.dll;
  const entry = results.sqlite_vec.entry === "(derived)" ? undefined : results.sqlite_vec.entry;
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  if (typeof db.enableLoadExtension === "function") db.enableLoadExtension(true);
  if (entry) db.loadExtension(dll, entry);
  else db.loadExtension(dll);

  const tries = [];
  // sqlite-vec's vec0 PK is rowid. A declared `id INTEGER PRIMARY KEY`
  // column is a metadata column, not the rowid, and rejects non-int binds
  // in some builds — use rowid-only.
  const ddls = [
    "CREATE VIRTUAL TABLE vec_items USING vec0(embedding FLOAT[" + DIM + "] distance_metric=cosine)",
    "CREATE VIRTUAL TABLE vec_items USING vec0(embedding FLOAT[" + DIM + "])",
  ];
  let mode = null;
  for (const ddl of ddls) {
    try {
      db.exec("DROP TABLE IF EXISTS vec_items");
      db.exec(ddl);
      mode = ddl;
      break;
    } catch (e) {
      tries.push({ ddl, error: String(e.message || e) });
    }
  }
  if (!mode) {
    db.close();
    return { ok: false, error: "could not CREATE VIRTUAL TABLE vec0", tries };
  }

  const ins = db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < vectors.length; i++) {
    // node:sqlite + vec0: Number rowid is rejected ("Only integers are
    // allowed for primary key values"). BigInt binds as INTEGER.
    ins.run(BigInt(i + 1), embeddingToBlob(vectors[i]));
  }
  db.exec("COMMIT");

  const qblob = embeddingToBlob(query);
  const sqls = [
    "SELECT id, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT " + k,
    "SELECT rowid AS id, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT " + k,
  ];
  let rows = null, sqlUsed = null, sqlErr = [];
  for (const sql of sqls) {
    try {
      rows = db.prepare(sql).all(qblob);
      sqlUsed = sql;
      break;
    } catch (e) {
      sqlErr.push({ sql, error: String(e.message || e) });
    }
  }
  db.close();
  if (!rows) return { ok: false, error: "MATCH query failed", sqlErr, ddl: mode };

  // cosine distance in sqlite-vec is 1 - cosine_similarity (typically).
  const converted = rows.map((r) => ({
    id: r.id, distance: r.distance, score: 1 - r.distance,
  }));
  const bruteIds = brute.map((r) => String(r.id)).join(",");
  const vecIds = converted.map((r) => String(r.id)).join(",");
  let maxDelta = 0;
  for (let i = 0; i < Math.min(converted.length, brute.length); i++) {
    const d = Math.abs(converted[i].score - brute[i].score);
    if (d > maxDelta) maxDelta = d;
  }
  return {
    ok: true,
    ddl: mode,
    sql: sqlUsed,
    ids_match: vecIds === bruteIds,
    vec_ids: converted.map((r) => r.id),
    brute_ids: brute.map((r) => r.id),
    max_abs_delta: maxDelta,
    sample: converted.slice(0, 5),
  };
}

// ---- 5. JSONL sovereignty round-trip -------------------------------------

async function proveSovereignty() {
  log("\n== 5. lossless JSONL export/import ==");
  const a = path.join(TMP, "sov-a.db");
  const b = path.join(TMP, "sov-b.db");
  const jsonl = path.join(TMP, "sov.jsonl");
  rmDb(a); rmDb(b);
  try { fs.unlinkSync(jsonl); } catch { /* */ }

  const storeA = new SpikeSqliteStore(a);
  const recs = [];
  for (let i = 1; i <= 25; i++) {
    const emb = new Float32Array(DIM);
    emb[i % DIM] = 1;
    recs.push({
      id: i,
      text: "fact " + i + " — Samuel prefers tea",
      embedding: emb,
      created: "2026-01-01T00:00:00.000Z",
      is_constraint: i === 3,
      source: "user_stated",
      access_count: i,
      superseded_by: i === 5 ? 6 : null,
      valid_to: i === 5 ? "2026-02-01T00:00:00.000Z" : null,
    });
  }
  storeA.addMany(recs);
  const recsNorm = recs.map((r) => {
    const n = normalize(Object.assign({}, r, { embedding: Array.from(r.embedding) }));
    n.embedding = r.embedding;
    return n;
  });
  const nOut = exportJsonlDurable(storeA, jsonl);
  const exported = fs.readFileSync(jsonl, "utf8").trim().split("\n");
  storeA.close();

  const storeB = new SpikeSqliteStore(b);
  const nIn = await importJsonl(storeB, jsonl);
  const back = storeB.all();
  storeB.close();

  // Compare field-by-field, embeddings within 1e-6.
  let mismatches = [];
  if (nOut !== nIn) mismatches.push("count " + nOut + " vs " + nIn);
  for (let i = 0; i < recsNorm.length; i++) {
    const x = recsNorm[i], y = back.find((r) => String(r.id) === String(x.id));
    if (!y) { mismatches.push("missing id " + x.id); continue; }
    for (const k of Object.keys(x)) {
      if (k === "embedding") {
        const ea = x.embedding, eb = y.embedding;
        if (!ea && !eb) continue;
        if (!ea || !eb || ea.length !== eb.length) { mismatches.push("emb len id " + x.id); continue; }
        for (let j = 0; j < ea.length; j++) {
          if (Math.abs(ea[j] - eb[j]) > 1e-5) { mismatches.push("emb id " + x.id + " dim " + j); break; }
        }
      } else if (String(x[k]) !== String(y[k])) {
        mismatches.push("field " + k + " id " + x.id + ": " + x[k] + " vs " + y[k]);
      }
    }
  }
  results.sovereignty = {
    exported_lines: exported.length,
    imported: nIn,
    lossless: mismatches.length === 0,
    mismatches: mismatches.slice(0, 12),
    jsonl_bytes: fs.statSync(jsonl).size,
  };
  log("  export " + nOut + " → import " + nIn + " lossless=" + results.sovereignty.lossless);
  if (mismatches.length) log("  mismatches: " + mismatches.slice(0, 5).join(" | "));
}

// ---- 6. S1 scale vs prototype SQLite -------------------------------------

function loadIndex() {
  const idx = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  if (idx.model !== EMBED_MODEL) throw new Error("cache model " + idx.model + " != " + EMBED_MODEL);
  return idx;
}
function readVecFromBuf(buf, slot, dim) {
  const start = slot * dim * 4;
  const copy = Buffer.allocUnsafe(dim * 4);
  buf.copy(copy, 0, start, start + dim * 4);
  return new Float32Array(copy.buffer, copy.byteOffset, dim);
}
function vecFor(idx, dim, text, buf) {
  const slot = idx.entries[hash16(text)];
  if (slot == null) throw new Error("uncached text: " + text.slice(0, 80));
  return readVecFromBuf(buf, slot, dim);
}
function makeEmbedder(idx, dim, buf) {
  const memo = new Map();
  return async function embed(texts) {
    return texts.map((t) => {
      let v = memo.get(t);
      if (!v) { v = vecFor(idx, dim, t, buf); memo.set(t, v); }
      return v;
    });
  };
}

async function runScale(ns) {
  log("\n== 6. S1 scale vs SpikeSqliteStore ==");
  if (!fs.existsSync(VEC_PATH) || !fs.existsSync(INDEX_PATH)) {
    throw new Error("S1 vector cache missing at " + CACHE_DIR + " — run node eval/substrate/scale.js --embed-only first");
  }
  const idx = loadIndex();
  const dim = idx.dim || DIM;
  const vecBuf = fs.readFileSync(VEC_PATH);
  log("  cache entries=" + Object.keys(idx.entries).length + " dim=" + dim +
    " vec.f32=" + (vecBuf.length / 1048576).toFixed(1) + " MB");
  const embed = makeEmbedder(idx, dim, vecBuf);
  const created = "2026-01-01T00:00:00.000Z";
  const queries = [
    "where do I live",
    "what am I allergic to",
    "how tall should I make the bookshelf",
    "where do I work",
    "what medication do I take",
    "when is standup",
    "what's my dog's name",
    "how do I take my coffee",
  ];

  for (const n of ns) {
    log("\n  --- N=" + n + " ---");
    const corpus = generateScaleCorpus({ n, seed: DEFAULT_SEED });
    const recs = corpus.records.map((r) => ({
      id: r.id, text: r.text, embedding: vecFor(idx, dim, r.text, vecBuf),
      created, embedding_version: 1,
    }));

    const dbFile = path.join(TMP, "scale-" + n + ".db");
    rmDb(dbFile);

    const tIns0 = process.hrtime.bigint();
    const store = new SpikeSqliteStore(dbFile);
    store.addMany(recs);
    const insertMs = hrMs(tIns0);
    const st = store.stats();
    log("    insert " + recs.length + " in " + fmt(insertMs) + " ms, db=" +
      (st.bytes / 1048576).toFixed(1) + " MB");

    // current() hydration cost (the JsonlStore.all() analogue)
    const tCur0 = process.hrtime.bigint();
    const cur = store.current();
    const currentMs = hrMs(tCur0);
    log("    current() hydrate " + cur.length + " in " + fmt(currentMs) + " ms");

    // Packed cosine isolated (S1's ~52 ms @ 50k / ~113 ms @ 100k analogue)
    const tPack0 = process.hrtime.bigint();
    const packed = store.loadPacked();
    const packLoadMs = hrMs(tPack0);
    const qv = await embed([queries[0]]);
    const tCos0 = process.hrtime.bigint();
    const scores = cosinePacked(qv[0], packed.packed, packed.n, packed.dim);
    const cosMs = hrMs(tCos0);
    log("    packed load " + fmt(packLoadMs) + " ms; cosine scan " + fmt(cosMs) + " ms");

    // searchDense (blob rows, no text)
    const tSd0 = process.hrtime.bigint();
    const dense = store.searchDense(qv[0], { limit: 5 });
    const denseMs = hrMs(tSd0);
    log("    searchDense blob+JS " + fmt(denseMs) + " ms top=" + dense.map((d) => d.id).join(","));

    // Real recall() through unchanged memory-core (JsonlStore surface)
    const mem = createMemory({ store, embed, fieldEnabled: false });
    const tWarm0 = process.hrtime.bigint();
    let warmOk = true, warmErr = null, warmMs = 0;
    try {
      await mem.recall(queries[0], 5);
      warmMs = hrMs(tWarm0);
    } catch (e) {
      warmOk = false;
      warmErr = String(e && e.message || e);
      warmMs = hrMs(tWarm0);
    }
    log("    recall() warm " + (warmOk ? fmt(warmMs) + " ms" : "FAILED " + warmErr));

    const samples = [];
    if (warmOk) {
      const trials = trialsFor(n);
      for (let t = 0; t < trials; t++) {
        const q = queries[t % queries.length];
        const t0 = process.hrtime.bigint();
        await mem.recall(q, 5);
        samples.push(hrMs(t0));
      }
      samples.sort((a, b) => a - b);
      log("    recall() field-off n=" + n + " trials=" + trials +
        " p50=" + fmt(percentile(samples, 50)) +
        " p95=" + fmt(percentile(samples, 95)) +
        " p99=" + fmt(percentile(samples, 99)));
    }

    // sqlite-vec at this N if loaded (separate table, same vectors)
    let vecMs = null, vecErr = null;
    if (results.sqlite_vec && results.sqlite_vec.ok && n <= 50000) {
      try {
        vecMs = timeSqliteVecAtN(recs, qv[0]);
        log("    sqlite-vec kNN " + fmt(vecMs) + " ms");
      } catch (e) {
        vecErr = String(e && e.message || e);
        log("    sqlite-vec kNN FAILED: " + vecErr);
      }
    }

    store.close();
    const row = {
      n,
      insert_ms: insertMs,
      db_bytes: st.bytes,
      current_hydrate_ms: currentMs,
      packed_load_ms: packLoadMs,
      packed_cosine_ms: cosMs,
      search_dense_ms: denseMs,
      recall_warm_ms: warmMs,
      recall_ok: warmOk,
      recall_error: warmErr,
      trials: samples.length,
      p50: samples.length ? percentile(samples, 50) : null,
      p95: samples.length ? percentile(samples, 95) : null,
      p99: samples.length ? percentile(samples, 99) : null,
      min: samples.length ? samples[0] : null,
      max: samples.length ? samples[samples.length - 1] : null,
      sqlite_vec_knn_ms: vecMs,
      sqlite_vec_error: vecErr,
      vs_jsonl: n >= 50000
        ? "JSONL CANNOT LOAD (S1: 834 MB > 512 MB string). SQLite loaded."
        : (n === 10000 ? "JSONL S1 field-off p95 was 488.7 ms (parse-bound)" : null),
    };
    results.scale.push(row);
  }
}

function timeSqliteVecAtN(recs, query) {
  const { DatabaseSync } = require("node:sqlite");
  const dll = results.sqlite_vec.dll;
  const entry = results.sqlite_vec.entry === "(derived)" ? undefined : results.sqlite_vec.entry;
  const dbFile = path.join(TMP, "vec-" + recs.length + ".db");
  try { fs.unlinkSync(dbFile); } catch { /* */ }
  const db = new DatabaseSync(dbFile, { allowExtension: true });
  if (typeof db.enableLoadExtension === "function") db.enableLoadExtension(true);
  if (entry) db.loadExtension(dll, entry);
  else db.loadExtension(dll);
  db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding FLOAT[" + DIM + "] distance_metric=cosine)");
  const ins = db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)");
  db.exec("BEGIN");
  for (const r of recs) ins.run(BigInt(r.id), embeddingToBlob(r.embedding));
  db.exec("COMMIT");
  const qblob = embeddingToBlob(query);
  const stmt = db.prepare("SELECT rowid AS id, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT 5");
  stmt.all(qblob); // warm
  const t0 = process.hrtime.bigint();
  stmt.all(qblob);
  const ms = hrMs(t0);
  db.close();
  return ms;
}

// ---- 7. mini-SEA smoke ---------------------------------------------------

function proveSeaSmoke() {
  log("\n== 7. mini-SEA smoke (node:sqlite inside a copied runtime) ==");
  const buildDir = path.join(TMP, "sea");
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, "bundle.js");
  const blob = path.join(buildDir, "sea-prep.blob");
  const cfg = path.join(buildDir, "sea-config.json");
  const exe = path.join(buildDir, process.platform === "win32" ? "sea-smoke.exe" : "sea-smoke");
  const entry = path.join(HERE, "sea-smoke-entry.js");
  try {
    log("  esbuild...");
    execSync("npx --yes esbuild \"" + entry + "\" --bundle --platform=node --target=node20 --outfile=\"" + bundle + "\"", {
      cwd: path.join(__dirname, "..", ".."), stdio: "inherit",
    });
    fs.writeFileSync(cfg, JSON.stringify({
      main: bundle.replace(/\\/g, "/"),
      output: blob.replace(/\\/g, "/"),
      disableExperimentalSEAWarning: true,
    }));
    log("  sea-config...");
    execSync("\"" + process.execPath + "\" --experimental-sea-config \"" + cfg + "\"", {
      cwd: path.join(__dirname, "..", ".."), stdio: "inherit",
    });
    fs.copyFileSync(process.execPath, exe);
    const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
    log("  postject...");
    execSync("npx --yes postject \"" + exe + "\" NODE_SEA_BLOB \"" + blob + "\" --sentinel-fuse " + fuse, {
      cwd: path.join(__dirname, "..", ".."), stdio: "inherit",
    });
    log("  run smoke exe...");
    const ran = spawnSync(exe, [], { encoding: "utf8", timeout: 15000 });
    const out = String(ran.stdout || "") + String(ran.stderr || "");
    results.sea.smoke = {
      ok: ran.status === 0 && /SEA node:sqlite OK/.test(out),
      status: ran.status,
      stdout: String(ran.stdout || "").trim(),
      stderr: String(ran.stderr || "").trim().slice(0, 500),
    };
    log("  status=" + ran.status + " out=" + String(ran.stdout || "").trim());
    if (!results.sea.smoke.ok) {
      log("  SEA smoke did not print OK (Windows GUI subsystem of a copied node is console, so stdout should work)");
    }
  } catch (e) {
    results.sea.smoke = { ok: false, error: String(e && e.message || e) };
    log("  SEA smoke FAILED: " + results.sea.smoke.error);
  }
}

function tryLoadExtensionInCopiedNode() {
  // If sqlite-vec loaded in this process, note that a SEA would still need
  // the .dll on disk next to the exe (or extracted from the blob). We cannot
  // statically link sqlite-vec into stock Node.
  results.sea.extension_story = {
    node_sqlite_in_sea: "yes, if the build Node is ≥22.5 (copied execPath contains the module)",
    sqlite_vec_in_sea: results.sqlite_vec && results.sqlite_vec.ok
      ? "loadExtension works in this Node; SEA would need the .dll extracted beside the exe or to a temp path. Stock Node cannot statically link sqlite-vec. allowExtension:true is required at DatabaseSync construction."
      : "extension did not load in this Node — SEA cannot do better than the host runtime.",
  };
}

// ---- write results -------------------------------------------------------

function writeResults() {
  const jsonPath = path.join(HERE, "results.json");
  const mdPath = path.join(HERE, "results.md");
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const scaleRows = results.scale.map((r) =>
    "| " + r.n +
    " | " + (r.recall_ok ? "YES" : "NO") +
    " | " + (r.p50 == null ? "—" : fmt(r.p50)) +
    " | " + (r.p95 == null ? "—" : fmt(r.p95)) +
    " | " + (r.p99 == null ? "—" : fmt(r.p99)) +
    " | " + fmt(r.current_hydrate_ms) +
    " | " + fmt(r.packed_cosine_ms) +
    " | " + fmt(r.search_dense_ms) +
    " | " + (r.db_bytes / 1048576).toFixed(1) + " MB" +
    " | " + (r.sqlite_vec_knn_ms == null ? (r.sqlite_vec_error || "n/a") : fmt(r.sqlite_vec_knn_ms)) +
    " |"
  ).join("\n");

  const md = [
    "# RM-07 spike results",
    "",
    "Generated " + results.generated + " on " + results.host.platform + "/" + results.host.arch +
    ", Node " + results.host.node + ", bundled SQLite " + results.host.sqlite + ".",
    "",
    "**This is a spike, not the product.** `memory-core.js` / `store.js` were not modified.",
    "",
    "## Host",
    "",
    "- Node: `" + results.host.node + "` at `" + results.host.execPath + "`",
    "- `process.versions.sqlite`: `" + results.host.sqlite + "`",
    "- CPU: " + results.host.cpus,
    "- RAM: " + results.host.totalmem_gb + " GB",
    "",
    "## SEA vs `node:sqlite`",
    "",
    "```json",
    JSON.stringify(results.sea, null, 2),
    "```",
    "",
    "## `node:sqlite` CRUD",
    "",
    "- ok: **" + !!(results.node_sqlite && results.node_sqlite.ok) + "**",
    "- FTS5 compiled in: **" + !!(results.fts5 && results.fts5.available) + "**",
    "- `OMIT_LOAD_EXTENSION`: " + String(results.node_sqlite && results.node_sqlite.omit_load_extension),
    "",
    "## sqlite-vec `loadExtension()`",
    "",
    "```json",
    JSON.stringify(results.sqlite_vec, null, 2),
    "```",
    "",
    "## Vector correctness (400 × 768-d vs brute-force cosine)",
    "",
    "```json",
    JSON.stringify(results.vector_correctness, null, 2),
    "```",
    "",
    "## JSONL export/import (data sovereignty)",
    "",
    "```json",
    JSON.stringify(results.sovereignty, null, 2),
    "```",
    "",
    "## S1 scale — SpikeSqliteStore, field-off `recall()` through unchanged `memory-core.js`",
    "",
    "JSONL baseline (S1, 2026-09-05): field-off p95 **488.7 ms at 10k**; **cannot load 50k** (834 MB > ~512 MB string).",
    "In-memory cosine only (S1 RamStore): ~52 ms at 50k, ~113 ms at 100k.",
    "",
    "| N | load ok | recall p50 | recall p95 | recall p99 | current() hydrate | packed cosine | searchDense | db size | sqlite-vec kNN |",
    "|---|---------|------------|------------|------------|-------------------|---------------|-------------|---------|----------------|",
    scaleRows || "| *(no scale rows)* |",
    "",
    "## Findings (machine-collected)",
    "",
    ...(results.findings.length ? results.findings.map((f) => "- " + f) : ["- (none beyond the tables)"]),
    "",
    "Reproduce: `node spike/rm-07-sqlite/run.js` (needs the S1 cache at `eval/substrate/.cache/`).",
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md);
  log("\nwrote " + jsonPath);
  log("wrote " + mdPath);
}

async function main(argv) {
  argv = argv || process.argv.slice(2);
  fs.mkdirSync(TMP, { recursive: true });
  const ns = parseNs(argv);
  const skipSea = argv.includes("--skip-sea");
  const skipScale = argv.includes("--skip-scale");
  const skipVec = argv.includes("--skip-vec");

  inspectSeaStory();
  proveNodeSqlite();
  if (!skipVec) await proveSqliteVec();
  else log("\n== 3. sqlite-vec SKIPPED --skip-vec ==");
  proveVectorCorrectness();
  await proveSovereignty();
  if (!skipScale) await runScale(ns);
  else log("\n== 6. scale SKIPPED --skip-scale ==");
  if (!skipSea) proveSeaSmoke();
  else log("\n== 7. SEA smoke SKIPPED --skip-sea ==");
  tryLoadExtensionInCopiedNode();
  writeResults();
  log("\nDONE");
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write("SPIKE FAILED: " + (e && e.stack || e) + "\n");
  try { writeResults(); } catch { /* */ }
  process.exit(1);
});
