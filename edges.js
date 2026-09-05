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
 * edges.js - the unified persistent edge substrate (Phase 0 / RM-21).
 *
 * field.js holds semantic kNN edges (ephemeral, rebuilt every recall).
 * ledger.js holds Hebbian weights (persistent, epoch-decayed, JSON sidecar).
 * This module is the one table that will absorb both: one undirected edge
 * record, two independently stored signals. It is NOT wired into recall yet
 * (that's Slice C) — build it standalone so the golden gate cannot move.
 *
 * The asymmetry is load-bearing (docs/phases/phase-0-edge-substrate.md):
 *
 *   embedding            source of truth   (what the memory means)
 *   edge semantic score  derived cache     (recomputable; validity is a
 *                                          version comparison, not a flag)
 *   hebbian weight       source of truth   (irreplaceable; the only thing
 *                                          that decays; last_updated nests
 *                                          here because that's all it clocks)
 *
 * No last_accessed on the edge. Persisting it is an edge write on every
 * recall — the BUG-002 / I5 class. The transition table's Writes? column
 * is the checklist; a read must not touch this file.
 *
 * Sidecar format is versioned (`kind: "resonance-edges"`) so an old
 * {recalls, edges:{key: number}} reader can refuse rather than treat
 * records as weights (which would NaN the ledger and, on save, wipe it).
 */

const fs = require("fs");
const { writeFileDurable } = require("./record.js");

const SIDECAR_KIND = "resonance-edges";
const SIDECAR_VERSION = 1;

const ORIGINS = { "save-time-neighbor": true, "co-activation": true };

// Must stay byte-identical to ledger.js's edgeKey until Slice C deletes that
// copy: migrated keys have to match the ones the Hebbian sidecar already wrote.
function edgeKey(a, b) { return [String(a), String(b)].sort().join(":"); }

function splitKey(k) {
  const s = String(k);
  const i = s.indexOf(":");
  if (i < 0) return [s, s];
  return [s.slice(0, i), s.slice(i + 1)];
}

function isoNow() { return new Date().toISOString(); }

class IncompatibleEdgeFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "IncompatibleEdgeFormatError";
  }
}

// -------------------------------------------------------------- record shape

/*
 * Canonical edge. Every field is backfilled on read (same migration posture
 * as record.normalize): an older on-disk record simply gains prune fields
 * etc. on first load. There is no stored "is-stale" flag — semantic validity
 * is `src_versions` vs the endpoints' current embedding_version.
 *
 * provenance.origin is how the edge came to exist, never what it currently
 * is. State is read off the signals (hebbian.weight === 0 = unreinforced).
 * migrated_from is a separate fact so a legacy sidecar edge can be both
 * genuinely co-activation AND bookkeeping-migrated.
 */
function normalizeEdge(e, now) {
  const when = now || isoNow();
  const [a, b] = [String(e.a), String(e.b)].sort();
  const sem = e.semantic && typeof e.semantic === "object" ? e.semantic : {};
  const src = sem.src_versions && typeof sem.src_versions === "object" ? sem.src_versions : {};
  const heb = e.hebbian && typeof e.hebbian === "object" ? e.hebbian : {};
  const prov = e.provenance && typeof e.provenance === "object" ? e.provenance : {};
  const origin = ORIGINS[prov.origin] ? prov.origin : (prov.origin || null);
  return {
    a,
    b,
    semantic: {
      value: typeof sem.value === "number" ? sem.value : null,
      src_versions: {
        a: src.a == null ? null : src.a,
        b: src.b == null ? null : src.b,
      },
    },
    hebbian: {
      weight: typeof heb.weight === "number" ? heb.weight : 0,
      last_updated: heb.last_updated || when,
    },
    provenance: {
      origin,
      migrated_from: prov.migrated_from || null,
    },
    created_at: e.created_at || when,
    pruned_at: e.pruned_at || null,
    prune_count: typeof e.prune_count === "number" ? e.prune_count : 0,
    first_pruned_at: e.first_pruned_at || null,
    last_reactivated_at: e.last_reactivated_at || null,
  };
}

function makeEdge(a, b, opts = {}) {
  // src_versions.a / .b refer to the CANONICAL endpoints (the sorted record.a /
  // record.b), not to argument order. makeEdge(2, 1, { semantic: { src_versions:
  // { a: v2, b: v1 }}}) would tag the wrong endpoint — set semantic after
  // creation with setSemantic(edge, value, { a: ver(edge.a), b: ver(edge.b) }).
  const origin = opts.origin;
  if (!ORIGINS[origin]) {
    throw new Error('makeEdge: provenance.origin must be "save-time-neighbor" or "co-activation"');
  }
  const now = opts.now || isoNow();
  return normalizeEdge({
    a,
    b,
    semantic: opts.semantic,
    hebbian: {
      weight: typeof opts.hebbianWeight === "number" ? opts.hebbianWeight : 0,
      last_updated: opts.lastUpdated || now,
    },
    provenance: { origin, migrated_from: opts.migrated_from || null },
    created_at: opts.created_at || now,
  }, now);
}

/*
 * Derived-cache validity. An edge's semantic.value is usable iff both
 * src_versions match the endpoints' current embedding_version. Stale is
 * then structurally self-evident: bump a version, the next read fails
 * the comparison, no invalidation event has to have fired (and none can
 * be silently missed). Empty semantic (migrated edges) has null versions
 * and so is invalid against any real embedding_version (>= 1).
 *
 * verA / verB are the current versions of edge.a / edge.b, in that order.
 */
function semanticValid(edge, verA, verB) {
  const src = edge && edge.semantic && edge.semantic.src_versions;
  if (!src) return false;
  return src.a === verA && src.b === verB;
}

// Two independent setters. Each leaves the other signal's bytes alone —
// collapsing them onto one scalar is the failure the whole design exists
// to prevent (a strong-semantic rarely-recalled pair would prune).
function setSemantic(edge, value, srcVersions) {
  edge.semantic = {
    value: typeof value === "number" ? value : null,
    src_versions: {
      a: srcVersions && srcVersions.a != null ? srcVersions.a : null,
      b: srcVersions && srcVersions.b != null ? srcVersions.b : null,
    },
  };
  return edge;
}

function setHebbian(edge, weight, lastUpdated) {
  edge.hebbian = {
    weight: typeof weight === "number" ? weight : 0,
    last_updated: lastUpdated || edge.hebbian.last_updated,
  };
  return edge;
}

// -------------------------------------------------------------- sidecar I/O

function looksLikeRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) &&
    v.hebbian && typeof v.hebbian.weight === "number";
}

function sidecarKind(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return "unknown";
  if (j.kind === SIDECAR_KIND) return SIDECAR_KIND;
  if (j.edges && typeof j.edges === "object" && !Array.isArray(j.edges)) {
    const vals = Object.keys(j.edges).map((k) => j.edges[k]);
    if (vals.length === 0) return "legacy-assoc";
    if (vals.every((v) => typeof v === "number")) return "legacy-assoc";
    // An old Ledger.save() on a new sidecar strips `kind` but leaves the
    // records as object values (measured). Treat that as native so the
    // learned weights survive; readLegacyAssoc still refuses them.
    if (vals.every(looksLikeRecord)) return SIDECAR_KIND;
  }
  return "unknown";
}

/*
 * The old-format reader. Understands ONLY `{ recalls, edges: { key: number } }`
 * — the shape ledger.js writes today. Seeing `kind: "resonance-edges"` (or
 * object-valued edge entries) throws rather than returning a silent subset:
 * dropping even one learned weight is data loss, and treating a record as a
 * number NaNs the bonus then overwrites the sidecar on the next Ledger.save().
 */
function readLegacyAssoc(j) {
  if (j && j.kind === SIDECAR_KIND) {
    throw new IncompatibleEdgeFormatError(
      "sidecar is " + SIDECAR_KIND + " v" + (j.version == null ? "?" : j.version) +
      "; this reader only understands pre-Phase-0 {recalls, edges:{key:number}}"
    );
  }
  const edges = (j && j.edges) || {};
  const out = {};
  for (const k of Object.keys(edges)) {
    const v = edges[k];
    if (typeof v !== "number") {
      throw new IncompatibleEdgeFormatError(
        "edge " + k + " is not a numeric Hebbian weight (refusing to misparse a newer sidecar)"
      );
    }
    out[k] = v;
  }
  return { recalls: (j && j.recalls) || 0, edges: out };
}

/*
 * One-way in-memory conversion. Every key in the legacy map becomes an edge
 * record — a dropped key is the pre-declared silent-data-loss signature.
 *
 * Timestamps: we do not know when the Hebbian weight was first written, so
 * both hebbian.last_updated and created_at are stamped at migration time.
 * They are LOWER BOUNDS, not the true original times. Do not treat them as
 * age. origin stays "co-activation" (the genuine fact); migrated_from carries
 * the bookkeeping. semantic is empty — computed on first use (Slice C / 0.1).
 */
function migrateAssoc(j, now) {
  const when = now || isoNow();
  const parsed = readLegacyAssoc(j);
  const out = new Map();
  for (const k of Object.keys(parsed.edges)) {
    const [a, b] = splitKey(k);
    const rec = makeEdge(a, b, {
      origin: "co-activation",
      migrated_from: "assoc.json",
      now: when,
      hebbianWeight: parsed.edges[k],
    });
    out.set(edgeKey(a, b), rec);
  }
  return out;
}

function envelope(edges) {
  const obj = {};
  for (const [k, rec] of edges) obj[k] = rec;
  return { kind: SIDECAR_KIND, version: SIDECAR_VERSION, edges: obj };
}

// -------------------------------------------------------------- store

/*
 * Persistent edge table. Constructed like Ledger: pass a path, get a Map.
 *
 * Fail-open (I3): a missing or corrupt sidecar loads empty and does not
 * throw. Learned weight is gone; memories are not. load() never writes
 * (I5) — even a successful in-memory migration stays in memory until an
 * explicit save(). That way a read path constructing the store cannot
 * rewrite the sidecar.
 */
class EdgeStore {
  constructor(file, opts = {}) {
    this.file = file;
    this.now = opts.now || isoNow;
    this.edges = new Map();
    this.migrated = false;   // true iff this load converted a legacy .assoc.json
    this.load();
  }

  load() {
    this.edges = new Map();
    this.migrated = false;
    try {
      if (!this.file || !fs.existsSync(this.file)) return;
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const kind = sidecarKind(j);
      if (kind === SIDECAR_KIND) {
        const bag = j.edges;
        // kind is right but the payload isn't a map — fail open, don't
        // Object.keys an array of numbers into garbage records.
        if (!bag || typeof bag !== "object" || Array.isArray(bag)) return;
        const when = this.now();
        for (const k of Object.keys(bag)) {
          const rec = normalizeEdge(bag[k], when);
          this.edges.set(edgeKey(rec.a, rec.b), rec);
        }
        return;
      }
      if (kind === "legacy-assoc") {
        this.edges = migrateAssoc(j, this.now());
        this.migrated = true;
        return;
      }
      // unknown shape: fail open (empty). Do not guess.
    } catch {
      this.edges = new Map();
      this.migrated = false;
    }
  }

  save() {
    try {
      writeFileDurable(this.file, JSON.stringify(envelope(this.edges)));
    } catch { /* non-fatal: the field must never break recall (I3) */ }
  }

  get(a, b) { return this.edges.get(edgeKey(a, b)); }

  has(a, b) { return this.edges.has(edgeKey(a, b)); }

  put(edge) {
    const rec = normalizeEdge(edge, this.now());
    this.edges.set(edgeKey(rec.a, rec.b), rec);
    return rec;
  }

  all() { return [...this.edges.values()]; }

  get size() { return this.edges.size; }

  // Incident edges for an id. Slice C uses this to absorb field.js's
  // Map<id, [{id, sim}]> neighbour lists without scanning the store twice.
  incident(id) {
    const s = String(id);
    const out = [];
    for (const e of this.edges.values()) {
      if (e.pruned_at) continue;
      if (e.a === s || e.b === s) out.push(e);
    }
    return out;
  }
}

module.exports = {
  edgeKey,
  makeEdge,
  normalizeEdge,
  semanticValid,
  setSemantic,
  setHebbian,
  sidecarKind,
  readLegacyAssoc,
  migrateAssoc,
  IncompatibleEdgeFormatError,
  SIDECAR_KIND,
  SIDECAR_VERSION,
  EdgeStore,
};
