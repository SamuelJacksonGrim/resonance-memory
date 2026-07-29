#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/*
 * record.js - the shared memory-record schema, durable writes, and the access
 * sidecar. Owned here (not in server.js) so the MCP server and the control panel
 * agree on exactly what a record is, byte for byte.
 *
 * Three things live here:
 *
 *   1. normalize()   - the ONE definition of a memory record. Every field is
 *                      backfilled on read, so a store written by any older build
 *                      loads into the current shape with no migration step.
 *
 *   2. writeFileDurable() - write-temp -> fsync -> atomic rename. Replacing a file
 *                      with writeFileSync is NOT atomic: a crash or power loss
 *                      partway through truncates the user's entire memory. Rename
 *                      within a directory is atomic on POSIX and on Windows
 *                      (MoveFileEx), so a reader sees either the whole old file or
 *                      the whole new one - never a half-written one.
 *
 *   3. AccessLog     - retention metadata (access_count / last_access) kept OUT of
 *                      the main store. Recall used to rewrite the entire store file
 *                      just to bump a counter on ~5 rows; since these counters are
 *                      RETENTION signals that never touch ranking (see the ranking
 *                      invariant), they do not belong on the read path at all.
 *                      Same sidecar pattern as ledger.js.
 *
 * Temporal fields (RM-04) are defined here too - see docs/proposed/0002.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// --------------------------------------------------------------- durable write
/*
 * Atomically replace `file` with `data`.
 *
 * The temp file is created in the SAME directory as the target: rename() is only
 * atomic within a filesystem, and os.tmpdir() is frequently a different mount.
 * We fsync the data before the rename so the bytes are on disk, not just in the
 * page cache, before anything points at them.
 */
function writeFileDurable(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + "." + Date.now() + ".tmp");
  let fd;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, data, "utf8");
    try { fs.fsyncSync(fd); } catch { /* some filesystems (and Windows shares) refuse fsync; the rename is still atomic */ }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);   // atomic: readers see all-old or all-new
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { }
    throw e;
  }
}

/* Append is already atomic for a single small write on both POSIX and Windows;
 * this wrapper exists so callers never touch fs directly and get the mkdir. */
function appendLineDurable(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, "utf8");
}

// ------------------------------------------------------------------- the record
/*
 * The canonical shape of a memory. Anything absent is backfilled, so this doubles
 * as the migration path: an old record simply gains the new fields on first read.
 *
 * Temporal model (RM-04, docs/proposed/0002) - bi-temporal, after Graphiti:
 *   valid_from     when this became true IN THE WORLD
 *   valid_to       when it stopped being true; null = still true right now
 *   last_confirmed last time we saw evidence it still holds
 *   superseded_by  id of the memory that replaced this one
 *   supersedes     back-pointer to the memory this one replaced
 *   revision       position in the supersession chain (1 = original)
 *   needs_review   an ambiguous conflict: BOTH were kept, a human should look
 *
 * A superseded memory is never deleted. valid_to is set to the successor's
 * valid_from, producing a non-overlapping validity chain you can walk backwards.
 */
function normalize(r) {
  const created = r.created || r.ts || new Date().toISOString();
  const modified = r.modified || created;
  return {
    id: r.id,
    created,
    modified,
    text: r.text,
    embedding: Array.isArray(r.embedding) ? r.embedding : null,

    // retention signals - never used in ranking
    importance: typeof r.importance === "number" ? r.importance : 0,
    access_count: typeof r.access_count === "number" ? r.access_count : 0,
    last_access: r.last_access || null,

    // temporal (RM-04)
    valid_from: r.valid_from || created,
    valid_to: r.valid_to || null,
    last_confirmed: r.last_confirmed || modified,
    superseded_by: r.superseded_by != null ? r.superseded_by : null,
    supersedes: r.supersedes != null ? r.supersedes : null,
    revision: typeof r.revision === "number" ? r.revision : 1,
    needs_review: !!r.needs_review,

    // provenance (RM-16): where this came from. Defaults to the honest answer for
    // anything written before provenance existed - the user's client said it.
    source: r.source || "user_stated",

    deleted: !!r.deleted,
  };
}

/* Currently-true: not deleted, not superseded. This is what recall answers from. */
function isCurrent(r) { return !r.deleted && !r.valid_to; }

/* Does this query explicitly ask about the past? Only then do superseded memories
 * surface. Kept deliberately narrow - a false positive here resurfaces stale facts,
 * which is exactly what the temporal model exists to prevent. */
const HISTORICAL_RE =
  /\b(used to|previous(ly)?|before|back then|in the past|formerly|history|historical|old(er)? (job|address|phone|car|name|number)|what did i (use|used) to)\b/i;
function isHistoricalQuery(q) { return HISTORICAL_RE.test(String(q || "")); }

/*
 * Mark `oldId` superseded by `newId`. Both rows survive.
 * Returns the patches to apply; the caller owns persistence so this stays pure
 * and testable.
 */
function supersedePatches(oldRec, newRec, at) {
  const when = at || newRec.valid_from || new Date().toISOString();
  return {
    old: { valid_to: when, superseded_by: newRec.id, modified: when },
    new: { supersedes: oldRec.id, revision: (oldRec.revision || 1) + 1 },
  };
}

// -------------------------------------------------------------- access sidecar
/*
 * access_count / last_access, stored beside the main store instead of inside it.
 *
 * Why: bumping a counter on 5 rows used to rewrite the ENTIRE store file on every
 * recall - O(store) work and a full-file exposure window on what is logically a
 * read. These counters govern RETENTION only (never retrieval order), so losing
 * the tail of them to a crash costs nothing that matters, while rewriting the
 * whole memory store on every read risks everything that does.
 *
 * Flushed with the same durable write as everything else.
 */
class AccessLog {
  constructor(file) {
    this.file = file;
    this.counts = new Map();   // id -> { n, last }
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const id in (j.counts || {})) this.counts.set(String(id), j.counts[id]);
    } catch { /* no sidecar yet - start empty */ }
  }

  save() {
    if (!this.dirty) return;
    try {
      writeFileDurable(this.file, JSON.stringify({ counts: Object.fromEntries(this.counts) }));
      this.dirty = false;
    } catch { /* non-fatal: retention metadata must never break recall */ }
  }

  bump(ids, at) {
    const when = at || new Date().toISOString();
    for (const id of ids) {
      const k = String(id);
      const cur = this.counts.get(k) || { n: 0, last: null };
      this.counts.set(k, { n: cur.n + 1, last: when });
      this.dirty = true;
    }
  }

  get(id) { return this.counts.get(String(id)) || { n: 0, last: null }; }

  /* Fold sidecar counts onto records read from the main store. The stored
   * access_count (from older builds, before the sidecar) is the baseline. */
  apply(records) {
    for (const r of records) {
      const a = this.counts.get(String(r.id));
      if (!a) continue;
      r.access_count = (r.access_count || 0) + a.n;
      r.last_access = a.last || r.last_access;
      r.importance = r.access_count;      // retention signal only; NOT used in ranking
    }
    return records;
  }

  /* Drop entries for ids that no longer exist, so the sidecar can't grow forever. */
  prune(liveIds) {
    const live = new Set([...liveIds].map(String));
    for (const k of [...this.counts.keys()]) {
      if (!live.has(k)) { this.counts.delete(k); this.dirty = true; }
    }
  }
}

module.exports = {
  writeFileDurable, appendLineDurable,
  normalize, isCurrent, isHistoricalQuery, supersedePatches,
  AccessLog, HISTORICAL_RE,
};
