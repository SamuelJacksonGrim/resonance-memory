#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/*
 * SPIKE — not product. Prototype SqliteStore behind the JsonlStore method
 * surface (docs/proposed/0005 + store.js). memory-core.js is unchanged: it
 * still calls current()/add()/update()/applyRecall(). Do not require this
 * file from server.js, panel.js, or eval/pipeline.js.
 *
 * Why a prototype at all: S1 showed JsonlStore cannot even *load* 50k
 * memories-with-vectors (834 MB > Node's ~512 MB string cap). This file
 * exists so we can measure whether node:sqlite + BLOB vectors clears that
 * wall, before anyone rips out JSONL.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");
const { normalize, isCurrent, writeFileDurable } = require("../../record.js");

const DIM = 768;

const COLS = [
  "id", "created", "modified", "text", "embedding",
  "importance", "access_count", "last_access",
  "valid_from", "valid_to", "last_confirmed",
  "superseded_by", "supersedes", "revision", "needs_review",
  "embedding_version", "source", "is_constraint", "deleted",
];

function embeddingToBlob(emb) {
  if (!emb || !emb.length) return null;
  if (emb instanceof Float32Array) {
    return new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength);
  }
  const f = new Float32Array(emb.length);
  for (let i = 0; i < emb.length; i++) f[i] = emb[i];
  return new Uint8Array(f.buffer);
}

function blobToF32(blob) {
  if (blob == null) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const aligned = Buffer.allocUnsafe(buf.length);
  buf.copy(aligned);
  return new Float32Array(aligned.buffer, aligned.byteOffset, (aligned.length / 4) | 0);
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function rowToRecord(row, withEmbedding) {
  const emb = withEmbedding ? blobToF32(row.embedding) : null;
  // normalize() only preserves Array.isArray embeddings. Attach the
  // Float32Array AFTER so we keep typed-array RAM/scan, not 768 number[].
  const rec = normalize({
    id: row.id,
    created: row.created,
    modified: row.modified,
    text: row.text,
    embedding: null,
    importance: row.importance,
    access_count: row.access_count,
    last_access: row.last_access,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    last_confirmed: row.last_confirmed,
    superseded_by: row.superseded_by,
    supersedes: row.supersedes,
    revision: row.revision,
    needs_review: !!row.needs_review,
    embedding_version: row.embedding_version,
    source: row.source,
    is_constraint: !!row.is_constraint,
    deleted: !!row.deleted,
  });
  rec.embedding = emb;
  return rec;
}

class SpikeSqliteStore {
  constructor(file, opts) {
    this.file = file;
    this.hydrateEmbeddings = opts && opts.hydrateEmbeddings === false ? false : true;
    const dbOpts = {};
    if (opts && opts.allowExtension) dbOpts.allowExtension = true;
    this.db = new DatabaseSync(file, dbOpts);
    this.db.exec("PRAGMA journal_mode = WAL");
    // FULL is the I5 analogue: a committed transaction is on disk, not just
    // in the WAL page cache. Spike default; product can A/B NORMAL later.
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this._initSchema();
    this._insert = this.db.prepare(
      "INSERT INTO memories (" + COLS.join(",") + ") VALUES (" + COLS.map(() => "?").join(",") + ")"
    );
    this._get = this.db.prepare("SELECT * FROM memories WHERE id = ?");
    this._all = this.db.prepare("SELECT * FROM memories");
    this._current = this.db.prepare(
      "SELECT * FROM memories WHERE deleted = 0 AND valid_to IS NULL"
    );
    this._active = this.db.prepare("SELECT * FROM memories WHERE deleted = 0");
    this._vecCurrent = this.db.prepare(
      "SELECT id, embedding FROM memories WHERE deleted = 0 AND valid_to IS NULL AND embedding IS NOT NULL"
    );
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id                INTEGER PRIMARY KEY,
        created           TEXT NOT NULL,
        modified          TEXT NOT NULL,
        text              TEXT NOT NULL,
        embedding         BLOB,
        importance        REAL DEFAULT 0,
        access_count      INTEGER DEFAULT 0,
        last_access       TEXT,
        valid_from        TEXT NOT NULL,
        valid_to          TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_current
        ON memories(deleted, valid_to);
    `);
  }

  _bind(rec) {
    // normalize() only keeps embeddings that are Array.isArray — a
    // Float32Array is a view, not an Array, so it would be stored as
    // NULL (silent vector loss). Blob the original typed array.
    const rawEmb = rec && rec.embedding;
    const r = normalize(rec);
    return [
      r.id, r.created, r.modified, r.text, embeddingToBlob(rawEmb || r.embedding),
      r.importance, r.access_count, r.last_access,
      r.valid_from, r.valid_to, r.last_confirmed,
      r.superseded_by, r.supersedes, r.revision, r.needs_review ? 1 : 0,
      r.embedding_version, r.source, r.is_constraint ? 1 : 0, r.deleted ? 1 : 0,
    ];
  }

  all() {
    return this._all.all().map((row) => rowToRecord(row, this.hydrateEmbeddings));
  }
  current() {
    return this._current.all().map((row) => rowToRecord(row, this.hydrateEmbeddings));
  }
  active() {
    return this._active.all().map((row) => rowToRecord(row, this.hydrateEmbeddings));
  }
  get(id) {
    const row = this._get.get(Number(id) || id);
    return row ? rowToRecord(row, this.hydrateEmbeddings) : null;
  }

  add(rec) {
    this._insert.run(...this._bind(rec));
  }

  addMany(recs) {
    this.db.exec("BEGIN");
    try {
      for (const rec of recs) this._insert.run(...this._bind(rec));
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already aborted */ }
      throw e;
    }
  }

  update(id, patch) {
    const rec = this.get(id);
    if (!rec) return false;
    Object.assign(rec, patch);
    this._replace(rec);
    return true;
  }

  updateMany(patchById) {
    this.db.exec("BEGIN");
    try {
      let n = 0;
      for (const [id, patch] of Object.entries(patchById)) {
        const rec = this.get(id);
        if (!rec) continue;
        Object.assign(rec, patch);
        this._replace(rec);
        n++;
      }
      this.db.exec("COMMIT");
      return n;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already aborted */ }
      throw e;
    }
  }

  _replace(rec) {
    this.db.prepare(
      "UPDATE memories SET created=?, modified=?, text=?, embedding=?, " +
      "importance=?, access_count=?, last_access=?, valid_from=?, valid_to=?, " +
      "last_confirmed=?, superseded_by=?, supersedes=?, revision=?, " +
      "needs_review=?, embedding_version=?, source=?, is_constraint=?, deleted=? " +
      "WHERE id=?"
    ).run(
      rec.created, rec.modified, rec.text, embeddingToBlob(rec.embedding),
      rec.importance, rec.access_count, rec.last_access,
      rec.valid_from, rec.valid_to, rec.last_confirmed,
      rec.superseded_by, rec.supersedes, rec.revision,
      rec.needs_review ? 1 : 0, rec.embedding_version, rec.source,
      rec.is_constraint ? 1 : 0, rec.deleted ? 1 : 0, rec.id
    );
  }

  applyRecall(returnedIds, embeddingById) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const bump = this.db.prepare(
        "UPDATE memories SET access_count = access_count + 1, last_access = ? WHERE id = ?"
      );
      for (const id of returnedIds || []) bump.run(now, id);
      if (embeddingById && embeddingById.size) {
        const setEmb = this.db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");
        for (const [id, v] of embeddingById) setEmb.run(embeddingToBlob(v), id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already aborted */ }
      throw e;
    }
  }

  vacuum() {
    this.db.exec("DELETE FROM memories WHERE deleted = 1");
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return n;
  }

  hasDeleted() {
    return !!this.db.prepare("SELECT 1 AS x FROM memories WHERE deleted = 1 LIMIT 1").get();
  }

  nextId() {
    const row = this.db.prepare("SELECT MAX(id) AS m FROM memories").get();
    const max = row && row.m != null ? Number(row.m) : 0;
    const now = Date.now();
    return now > max ? now : max + 1;
  }

  stats() {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count, " +
      "SUM(CASE WHEN deleted = 0 AND valid_to IS NULL THEN 1 ELSE 0 END) AS current, " +
      "SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS superseded, " +
      "SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) AS deleted " +
      "FROM memories"
    ).get();
    let bytes = 0;
    try { bytes = fs.statSync(this.file).size; } catch { /* :memory: */ }
    return { count: row.count || 0, current: row.current || 0, superseded: row.superseded || 0, deleted: row.deleted || 0, bytes };
  }

  /*
   * searchDense without hydrating text: pull (id, embedding BLOB) and cosine
   * in JS. This is the "S1 said parse was the bottleneck, not cosine" path.
   * Ranking still = cosine only (I2).
   */
  searchDense(vector, { limit } = {}) {
    const k = limit || 5;
    const rows = this._vecCurrent.all();
    const scored = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      scored[i] = { id: rows[i].id, score: cosine(vector, blobToF32(rows[i].embedding)) };
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /*
   * Packed-buffer cosine: one Float32Array of N*768, scanned in a tight
   * loop. Tests whether typed-array cosine (no per-row object) clears the
   * 100 ms @ 100k bar that S1's JS-number cosine missed (~113 ms).
   */
  loadPacked() {
    const rows = this._vecCurrent.all();
    const n = rows.length;
    const packed = new Float32Array(n * DIM);
    const ids = new Array(n);
    for (let i = 0; i < n; i++) {
      ids[i] = rows[i].id;
      const v = blobToF32(rows[i].embedding);
      if (!v) continue;
      packed.set(v.length === DIM ? v : v.subarray(0, DIM), i * DIM);
    }
    return { ids, packed, n, dim: DIM };
  }

  close() {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* closing */ }
    this.db.close();
  }
}

function cosinePacked(query, packed, n, dim) {
  let qn = 0;
  for (let i = 0; i < dim; i++) qn += query[i] * query[i];
  qn = Math.sqrt(qn);
  const scores = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    const off = r * dim;
    let dot = 0, nn = 0;
    for (let i = 0; i < dim; i++) {
      const v = packed[off + i];
      dot += query[i] * v;
      nn += v * v;
    }
    scores[r] = qn && nn ? dot / (qn * Math.sqrt(nn)) : 0;
  }
  return scores;
}

function topKFromScores(ids, scores, k) {
  const idx = new Array(ids.length);
  for (let i = 0; i < ids.length; i++) idx[i] = i;
  idx.sort((a, b) => scores[b] - scores[a]);
  const out = [];
  for (let i = 0; i < k && i < idx.length; i++) {
    out.push({ id: ids[idx[i]], score: scores[idx[i]] });
  }
  return out;
}

/*
 * Lossless JSONL export. Neutral format: the same records JsonlStore writes.
 * This is the data-sovereignty path — the user can leave SQLite (or RM)
 * without losing a field. Streaming write so a 100k store does not become
 * one giant string.
 */
function exportJsonl(store, outFile) {
  const recs = store.all();
  const fd = fs.openSync(outFile, "w");
  try {
    for (const r of recs) {
      const rec = Object.assign({}, r);
      if (rec.embedding && rec.embedding.length && !Array.isArray(rec.embedding)) {
        rec.embedding = Array.from(rec.embedding);
      }
      fs.writeSync(fd, JSON.stringify(rec) + "\n");
    }
  } finally {
    fs.closeSync(fd);
  }
  return recs.length;
}

/*
 * Streaming JSONL import. MUST NOT readFileSync the whole file — that is
 * the S1 wall (834 MB string). Line-at-a-time so a store JSONL cannot load
 * as one string can still migrate.
 */
async function importJsonl(store, jsonlPath) {
  const input = fs.createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  const batch = [];
  store.db.exec("BEGIN");
  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      batch.push(normalize(obj));
      if (batch.length >= 500) {
        for (const rec of batch) store._insert.run(...store._bind(rec));
        n += batch.length;
        batch.length = 0;
      }
    }
    for (const rec of batch) store._insert.run(...store._bind(rec));
    n += batch.length;
    store.db.exec("COMMIT");
  } catch (e) {
    try { store.db.exec("ROLLBACK"); } catch { /* already aborted */ }
    throw e;
  }
  return n;
}

/*
 * Durable-looking JSONL write used by the sovereignty round-trip so export
 * matches the product's I5 shape. The SQLite side uses a transaction.
 */
function exportJsonlDurable(store, outFile) {
  const recs = store.all();
  const lines = recs.map((r) => {
    const rec = Object.assign({}, r);
    if (rec.embedding && rec.embedding.length && !Array.isArray(rec.embedding)) {
      rec.embedding = Array.from(rec.embedding);
    }
    return JSON.stringify(rec);
  });
  writeFileDurable(outFile, lines.join("\n") + (lines.length ? "\n" : ""));
  return recs.length;
}

module.exports = {
  SpikeSqliteStore,
  embeddingToBlob,
  blobToF32,
  cosine,
  cosinePacked,
  topKFromScores,
  exportJsonl,
  exportJsonlDurable,
  importJsonl,
  DIM,
};
