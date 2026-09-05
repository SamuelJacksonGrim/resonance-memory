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
 * store.js - the storage backend, behind the Store seam.
 *
 * Lives in its own module so it can be constructed and tested without starting
 * the MCP stdio loop, and so a second backend (SQLite; see docs/proposed/0005
 * and 0010) can sit alongside JsonlStore without touching memory-core.js. The
 * MCP verbs never see anything in here.
 *
 * RM-07 slice 1: SqliteStore is SELECTABLE (RESONANCE_STORE=sqlite or live-config
 * `store: "sqlite"`). Default stays JsonlStore until conformance + golden parity
 * land the default switch. openStore() is the one construction path.
 *
 * RM-07 slice 2a: JSONL→SQLite is a separate streaming migrator
 * (`migrate-sqlite.js`, `node entry.js --migrate`). openStore() does NOT
 * auto-run it (first-open hook is the default-switch slice 4). If sqlite
 * is selected, a sibling JSONL exists, and the .db is missing, we warn —
 * constructing SqliteStore would create an empty .db and the next
 * --migrate would ignore the JSONL (protocol step 1).
 */

const fs = require("fs");
const {
  writeFileDurable, appendLineDurable, normalize, isCurrent, AccessLog,
} = require("./record.js");

// ------------------------------------------------------------------- Store
// Swappable backend. This one is flat JSONL; a Lantern-backed Store can replace
// it later with the same method surface, leaving the MCP verbs untouched.
class JsonlStore {
  constructor(file) {
    this.file = file;
    // Retention metadata lives in a sidecar so recall never rewrites the store.
    this.access = new AccessLog(file + ".access.json");
  }

  all() {
    if (!fs.existsSync(this.file)) return [];
    const recs = fs.readFileSync(this.file, "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return normalize(JSON.parse(l)); } catch { return null; } })
      .filter(Boolean);
    return this.access.apply(recs);   // fold in sidecar access counts
  }

  /* Not deleted. Includes superseded memories - use current() to exclude those. */
  active() { return this.all().filter((r) => !r.deleted); }

  /* Currently true: not deleted, not superseded. What recall answers from. */
  current() { return this.all().filter(isCurrent); }

  get(id) { const k = String(id); return this.all().find((r) => String(r.id) === k) || null; }

  // Durable full rewrite: temp -> fsync -> atomic rename. Only mutations land here
  // (save/edit/delete/vacuum), never a read.
  _writeAll(recs) {
    const data = recs.map((r) => JSON.stringify(r)).join("\n") + (recs.length ? "\n" : "");
    writeFileDurable(this.file, data);
    // `recs` came from all(), so they already carry the sidecar's counts folded in.
    // Now that those totals are persisted in the store itself, the sidecar must be
    // cleared - otherwise the next read folds them in AGAIN and access_count doubles
    // on every edit/vacuum. A full rewrite is the natural checkpoint for this.
    this.access.consolidate();
    this.access.save();
  }

  add(rec) { appendLineDurable(this.file, JSON.stringify(rec) + "\n"); }

  // patch matched by id (string-compared so a number or string id both work)
  update(id, patch) {
    const key = String(id);
    const recs = this.all();
    let found = false;
    for (const r of recs) { if (String(r.id) === key) { Object.assign(r, patch); found = true; } }
    if (found) this._writeAll(recs);
    return found;
  }

  // Apply several patches in ONE rewrite: { id -> patch }. Used by supersession,
  // where two rows change together and must not be observable half-applied.
  updateMany(patchById) {
    const recs = this.all();
    let n = 0;
    for (const r of recs) {
      const p = patchById[String(r.id)];
      if (p) { Object.assign(r, p); n++; }
    }
    if (n) this._writeAll(recs);
    return n;
  }

  /*
   * Record a recall. Access bumps go to the sidecar (no store write at all).
   * Freshly-computed vectors DO belong in the store, but that only happens for
   * legacy rows or after an embedder outage - so in steady state a recall
   * performs zero writes to the memory store.
   */
  applyRecall(returnedIds, embeddingById) {
    this.access.bump(returnedIds);
    this.access.save();
    if (embeddingById && embeddingById.size) {
      const recs = this.all();
      let n = 0;
      for (const r of recs) {
        const v = embeddingById.get(String(r.id));
        // First-time backfill of a vectorless row (legacy, or a save-time
        // embedder outage). The vector now matches the text, but this is not
        // a re-embed: embedding_version stays at the normalize() default (1).
        // Bumping here would make a save-time failure look like an edit()
        // mutation, which Phase 0's version-comparison cache cannot tell apart.
        if (v) { r.embedding = v; n++; }
      }
      if (n) this._writeAll(recs);
    }
  }

  vacuum() {
    const kept = this.all().filter((r) => !r.deleted);
    this._writeAll(kept);   // consolidates + clears the sidecar; nothing left to prune
    return kept.length;
  }

  hasDeleted() { return this.all().some((r) => r.deleted); }

  nextId() {
    const ids = this.all().map((r) => Number(r.id)).filter((n) => !Number.isNaN(n));
    const max = ids.length ? Math.max(...ids) : 0;
    const now = Date.now();
    return now > max ? now : max + 1;
  }
}

/*
 * Backend selectability (RM-07 slice 1). Default is jsonl — the default
 * switch is a later slice, after conformance + RM-00 golden parity.
 * Live-config `store` wins over env RESONANCE_STORE, same pattern as the
 * field toggle. A backend change needs a process restart (you cannot
 * hot-swap engines under an open file).
 */
function resolveStoreBackend(config) {
  if (config && (config.store === "sqlite" || config.store === "jsonl")) return config.store;
  const raw = String(process.env.RESONANCE_STORE || "jsonl").toLowerCase();
  return raw === "sqlite" ? "sqlite" : "jsonl";
}

function sqlitePathFor(file) {
  const s = String(file || "");
  if (/\.db$/i.test(s)) return s;
  if (/\.jsonl$/i.test(s)) return s.replace(/\.jsonl$/i, ".db");
  return s + ".db";
}

function openStore(file, opts) {
  const backend = (opts && opts.backend) || resolveStoreBackend(opts && opts.config);
  if (backend === "sqlite") {
    const { SqliteStore } = require("./store-sqlite.js");
    const dbPath = sqlitePathFor(file);
    // Not an auto-migrate. Protocol step 1: a live .db makes leftover JSONL
    // invisible. Creating an empty .db beside an existing JSONL is how a
    // user loses the store without --migrate. Warn so the footgun is loud.
    if (file && !fs.existsSync(dbPath) && fs.existsSync(file)) {
      console.warn(
        "RESONANCE: JSONL store exists at " + file + " but the SQLite backend " +
        "is selected and " + dbPath + " is missing. The JSONL will NOT be read. " +
        "Run: node entry.js --migrate"
      );
    }
    return new SqliteStore(dbPath);
  }
  return new JsonlStore(file);
}

module.exports = { JsonlStore, openStore, resolveStoreBackend, sqlitePathFor };
Object.defineProperty(module.exports, "SqliteStore", {
  enumerable: true,
  get() { return require("./store-sqlite.js").SqliteStore; },
});
