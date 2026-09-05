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
 * SPIKE — not product. sqlite-vec MATCH latency at N=100k against the
 * scale-100000.db left by run.js.
 */
"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const { SpikeSqliteStore, embeddingToBlob, DIM } = require("./proto-store.js");

const dll = path.join(__dirname, "vendor", "vec0.dll");
const dbFile = path.join(__dirname, "tmp", "scale-100000.db");
const store = new SpikeSqliteStore(dbFile);
const packed = store.loadPacked();
store.close();
console.log("loaded packed n=" + packed.n);

const q = packed.packed.subarray(0, DIM); // first vector as query
const qblob = embeddingToBlob(q);

const vecDb = path.join(__dirname, "tmp", "vec-100k.db");
const db = new DatabaseSync(vecDb, { allowExtension: true });
db.enableLoadExtension(true);
db.loadExtension(dll);
db.exec("PRAGMA journal_mode=WAL");
db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding FLOAT[" + DIM + "] distance_metric=cosine)");
const count = db.prepare("SELECT COUNT(*) AS n FROM vec_items").get().n;
if (count !== packed.n) {
  db.exec("DELETE FROM vec_items");
  const ins = db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)");
  const t0 = process.hrtime.bigint();
  db.exec("BEGIN");
  for (let i = 0; i < packed.n; i++) {
    const v = packed.packed.subarray(i * DIM, (i + 1) * DIM);
    ins.run(BigInt(packed.ids[i]), embeddingToBlob(v));
  }
  db.exec("COMMIT");
  console.log("inserted " + packed.n + " in " + (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) + " ms");
} else {
  console.log("reusing " + count + " vec0 rows");
}
const stmt = db.prepare("SELECT rowid AS id, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT 5");
stmt.all(qblob);
const samples = [];
for (let i = 0; i < 8; i++) {
  const t0 = process.hrtime.bigint();
  stmt.all(qblob);
  samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
samples.sort((a, b) => a - b);
console.log("sqlite-vec 100k kNN ms", samples.map((x) => x.toFixed(1)).join(", "),
  "p50=" + samples[Math.floor(samples.length * 0.5)].toFixed(1),
  "max=" + samples[samples.length - 1].toFixed(1));
db.close();
