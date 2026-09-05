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
 * SPIKE — not product. Measures field-off recall() when SqliteStore
 * hydrates current() ONCE and then serves from RAM (the cache a real
 * SqliteStore would keep). Uncached numbers already live in results.md;
 * this answers "is blob+JS cosine enough IF we don't re-read SQLite
 * on every recall?"
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SpikeSqliteStore } = require("./proto-store.js");
const { generateScaleCorpus, DEFAULT_SEED } = require("../../eval/substrate/generate.js");
const { createMemory } = require("../../eval/pipeline.js");
const { isCurrent } = require("../../record.js");

const HERE = __dirname;
const TMP = path.join(HERE, "tmp");
const CACHE_DIR = path.join(__dirname, "..", "..", "eval", "substrate", ".cache");
const INDEX_PATH = path.join(CACHE_DIR, "index.json");
const VEC_PATH = path.join(CACHE_DIR, "vectors.f32");
const EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";
const DIM = 768;

function hash16(t) {
  return crypto.createHash("sha256").update(String(t)).digest("hex").slice(0, 16);
}
function hrMs(t0) { return Number(process.hrtime.bigint() - t0) / 1e6; }
function fmt(ms) { return (Math.round(ms * 10) / 10).toFixed(1); }
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function trialsFor(n) {
  if (n <= 10000) return 20;
  if (n <= 50000) return 12;
  return 8;
}

class CachedStore {
  constructor(recs) { this._recs = recs; this._bumps = 0; }
  all() { return this._recs; }
  current() { return this._recs.filter(isCurrent); }
  active() { return this._recs.filter((r) => !r.deleted); }
  applyRecall() { this._bumps++; }
}

function vecFor(idx, dim, text, buf) {
  const slot = idx.entries[hash16(text)];
  const start = slot * dim * 4;
  const copy = Buffer.allocUnsafe(dim * 4);
  buf.copy(copy, 0, start, start + dim * 4);
  return new Float32Array(copy.buffer, copy.byteOffset, dim);
}

async function main() {
  const ns = (process.argv[2] || "10000,50000,100000").split(",").map(Number);
  const idx = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const dim = idx.dim || DIM;
  const vecBuf = fs.readFileSync(VEC_PATH);
  const embedMemo = new Map();
  const embed = async (texts) => texts.map((t) => {
    let v = embedMemo.get(t);
    if (!v) { v = vecFor(idx, dim, t, vecBuf); embedMemo.set(t, v); }
    return v;
  });
  const queries = [
    "where do I live", "what am I allergic to", "how tall should I make the bookshelf",
    "where do I work", "what medication do I take", "when is standup",
    "what's my dog's name", "how do I take my coffee",
  ];
  const created = "2026-01-01T00:00:00.000Z";
  const rows = [];

  for (const n of ns) {
    const dbFile = path.join(TMP, "scale-" + n + ".db");
    let recs;
    const tHyd0 = process.hrtime.bigint();
    if (fs.existsSync(dbFile)) {
      const store = new SpikeSqliteStore(dbFile);
      recs = store.current();
      store.close();
    } else {
      const corpus = generateScaleCorpus({ n, seed: DEFAULT_SEED });
      recs = corpus.records.map((r) => ({
        id: r.id, text: r.text, embedding: vecFor(idx, dim, r.text, vecBuf),
        created, deleted: false, valid_to: null,
      }));
    }
    const hydMs = hrMs(tHyd0);
    const store = new CachedStore(recs);
    const mem = createMemory({ store, embed, fieldEnabled: false });
    await mem.recall(queries[0], 5);
    const samples = [];
    const trials = trialsFor(n);
    for (let t = 0; t < trials; t++) {
      const t0 = process.hrtime.bigint();
      await mem.recall(queries[t % queries.length], 5);
      samples.push(hrMs(t0));
    }
    samples.sort((a, b) => a - b);
    const row = {
      n, hydrate_ms: hydMs, recs: recs.length, trials,
      p50: percentile(samples, 50), p95: percentile(samples, 95),
      p99: percentile(samples, 99), min: samples[0], max: samples[samples.length - 1],
    };
    rows.push(row);
    console.log("N=" + n + " hydrate=" + fmt(hydMs) + "ms cached-recall p50=" +
      fmt(row.p50) + " p95=" + fmt(row.p95) + " p99=" + fmt(row.p99) +
      " trials=" + trials);
  }

  const out = path.join(HERE, "results-cached.json");
  fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), rows }, null, 2));
  console.log("wrote " + out);
}

main().catch((e) => { console.error(e); process.exit(1); });
