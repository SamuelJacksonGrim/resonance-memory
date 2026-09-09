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
 * warm.js - ephemeral spreading activation (Phase 1). NEVER persisted (I7).
 *
 * "What's warm right now": an in-process Map
 *   id → { value, similarity, timestamp }
 * Seeded from semantic retrieval, spread over Phase 0 persistent edges,
 * attenuated per hop, lazy wall-clock decay computed on access (same
 * discipline as edges.effectiveHebbian / I6). The Map dies with the
 * process; a restart is empty. Similarity stays on the node next to
 * activation so Phase 2.2 can trace both without collapsing them.
 *
 * Ranking is not this module's job. Creating a WarmField, seeding it,
 * spreading it, decaying it must not change a recall's output string.
 * Rank entry is the Phase 2.2 gate. Tracing already emits that phase's
 * candidate shape (`semantic` / `hebbian` / `recency` / `activation` /
 * `final_score: "semantic"`) so fusion does not need a second hook.
 *
 * Knobs — tuned against the APR metric in
 * eval/substrate/activation-measure.js (docs/phases/phase-1). Do not
 * retune without re-running that readout:
 *
 *   ATTENUATION  0.5     per-hop factor, independent of edge strength.
 *                        2-hop through two 0.25 bootstrap edges from E=1:
 *                          1×0.25×0.5 = 0.125; 0.125×0.25×0.5 = 0.0156
 *                        which is below FLOOR, so weak structure dies at
 *                        2 hops. Two 0.8 edges: 0.40 then 0.16, still
 *                        observable. That's "stronger edges transmit more"
 *                        / "weak bootstrap transmits little."
 *   MAX_HOPS     2       1-hop cannot show multi-hop attenuation. 3-hop
 *                        on 0.25 edges is noise under the floor.
 *   FLOOR        0.05    below this, warm ≈ cold.
 *   CAP          256     conversation working set; evict lowest-effective.
 *   HALF_LIFE    300s    conversation-scale "right now". 5s think-pause
 *                        is ~1.1% decay — the trap the old λ_turn was
 *                        invented to avoid is imaginary with a proper H.
 *                        5 min → ½. ~13 min → floor.
 *
 * Conductance of a Phase 0 edge (pruned_at → 0; incident() already skips):
 *   clamp(max(semantic, tanh(effectiveHebbian)), 0, 1)
 * Weak save-time bootstrap (sem 0.25, heb 0) transmits 0.25. A learned
 * edge with tanh(w) > semantic transmits the learned amount. The two
 * signals stay separate on the edge; we only combine them into a
 * transmission scalar here.
 *
 * Update is max, not sum, capped at 1.0, so a dense cluster cannot
 * runaway. Spread iterates thisTurn only (ids seed/seedFromRetrieval
 * just recorded). A `live` set, when provided, is the "never resurrect
 * a soft-pruned memory" gate.
 *
 * Decay is computed on read from (value, timestamp); a get() does not
 * write the decayed number back (I6: reading does not drive the clock).
 * Setting (seed/spread) stamps timestamp = now.
 *
 * The old idle-TTL map wipe did not earn its place: with wall-clock
 * half-life + floor, energy is already gone before 30 min. One clock.
 */

const { effectiveHebbian } = require("./edges.js");

function nowMs() { return Date.now(); }

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name, fallback) {
  const n = envNumber(name, fallback);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const ATTENUATION = envNumber("RESONANCE_WARM_ATTENUATION", 0.5);
const MAX_HOPS = envInt("RESONANCE_WARM_HOPS", 2);
const FLOOR = envNumber("RESONANCE_WARM_FLOOR", 0.05);
const CAP = envInt("RESONANCE_WARM_CAP", 256);
const HALF_LIFE_SECONDS = envNumber("RESONANCE_WARM_HALFLIFE", 300);
// Cap is applied at spread() only (shouldSpread), never inside getEdges, so a
// large store cannot disable the field's Related: path. 0 is a legitimate
// "never spread" value — do not `Number(x) || 512`.
const WARM_EDGE_CAP = envInt("RESONANCE_WARM_EDGE_CAP", 512);

function normalizeSeed(sim) {
  const x = Number(sim);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return x >= 1 ? 1 : x;
}

function effectiveActivation(value, timestamp, now, halfLife) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const h = Number(halfLife);
  // Non-positive / non-finite → no decay (fail open; a bad parameter must
  // not wipe the session). Same posture as edges.lambdaFromHalfLife.
  if (!Number.isFinite(h) || h <= 0) return v;
  const tNow = Number(now);
  const tThen = Number(timestamp);
  if (!Number.isFinite(tNow) || !Number.isFinite(tThen)) return v;
  const dt = Math.max(0, (tNow - tThen) / 1000);
  if (dt === 0) return v;
  return v * Math.pow(2, -dt / h);
}

/*
 * Transmission scalar of one Phase 0 edge. Pruned → 0. Semantic and
 * Hebbian stay independent on the record; this is only how much energy
 * crosses the edge THIS hop.
 */
function conductance(edge, now, opts) {
  if (!edge || edge.pruned_at) return 0;
  const sem = edge.semantic && typeof edge.semantic.value === "number"
    ? edge.semantic.value : 0;
  const heb = effectiveHebbian(edge, now, opts || {});
  const posSem = sem > 0 ? sem : 0;
  const posHeb = heb > 0 ? heb : 0;
  const h = Math.tanh(posHeb);
  const c = posSem + h - posSem * h;   // EXPERIMENT: noisy-OR (soft-OR), was Math.max(posSem, h) — either carries alone, both corroborate
  if (!Number.isFinite(c) || c <= 0) return 0;
  return c > 1 ? 1 : c;
}

/*
 * Adjacency for spread(), built from the persistent edge table. Walks
 * L.edges once (O(E)); falls back to incident() if the duck-type has no
 * Map. Skips pruned_at (belt: incident() already does). Drops endpoints
 * not in the live memory set so a deleted id cannot be warmed from a
 * neighbor.
 *
 * `sim` on the returned neighbors is conductance, not raw cosine — the
 * spread contract is E_target = max(E_target, E_source * sim * α).
 */
function activationEdgesFromStore(L, mems, opts) {
  opts = opts || {};
  const live = new Set((mems || []).map((m) => String(m && m.id != null ? m.id : m)));
  const map = new Map();
  if (!L || live.size === 0) return map;
  const now = opts.now != null ? opts.now : Date.now();
  const hebOpts = opts.hebOpts || {};

  function add(from, to, c) {
    if (!live.has(from) || !live.has(to) || !(c > 0)) return;
    if (!map.has(from)) map.set(from, []);
    map.get(from).push({ id: to, sim: c });
  }

  if (L.edges && typeof L.edges.values === "function") {
    for (const e of L.edges.values()) {
      if (!e || e.pruned_at) continue;
      const c = conductance(e, now, hebOpts);
      add(String(e.a), String(e.b), c);
      add(String(e.b), String(e.a), c);
    }
    return map;
  }
  if (typeof L.incident === "function") {
    for (const id of live) {
      let nbrs;
      try { nbrs = L.incident(id) || []; } catch { continue; }
      for (const e of nbrs) {
        if (!e || e.pruned_at) continue;
        const other = String(e.a) === id ? String(e.b) : String(e.a);
        add(id, other, conductance(e, now, hebOpts));
      }
    }
  }
  return map;
}

function vectorCount(mems) {
  // Typed arrays (SqliteStore) fail Array.isArray; cosine still works.
  return (mems || []).filter((m) => {
    const e = m && m.embedding;
    return !!(e && e.length > 0 && typeof e[0] === "number");
  }).length;
}

function shouldSpread(mems, cap) {
  const n = cap == null ? WARM_EDGE_CAP : cap;
  return vectorCount(mems) <= n;
}

class WarmField {
  constructor(opts) {
    opts = opts || {};
    this.nodes = new Map();            // id -> { value, similarity, timestamp }
    this.thisTurn = new Set();         // ids seeded this tick; spread iterates ONLY these
    this.attenuation = opts.attenuation != null ? opts.attenuation : ATTENUATION;
    this.hops = opts.hops != null ? opts.hops : MAX_HOPS;
    this.floor = opts.floor != null ? opts.floor : FLOOR;
    this.cap = opts.cap != null ? opts.cap : CAP;
    this.halfLife = opts.halfLife != null ? opts.halfLife : HALF_LIFE_SECONDS;
    this.now = opts.now || nowMs;      // injectable for tests; returns epoch ms
  }

  effective(node, now) {
    if (!node) return 0;
    return effectiveActivation(
      node.value,
      node.timestamp,
      now != null ? now : this.now(),
      this.halfLife
    );
  }

  get(id) {
    const k = String(id);
    const n = this.nodes.get(k);
    if (!n) return 0;
    const v = this.effective(n);
    if (v < this.floor) {
      this.nodes.delete(k);
      this.thisTurn.delete(k);
      return 0;
    }
    return v;
  }

  similarity(id) {
    const n = this.nodes.get(String(id));
    return n && n.similarity != null ? n.similarity : null;
  }

  // Save-prime and simple tests. Energy is normalized; similarity is not
  // a retrieval score here (null).
  seed(ids, energy) {
    const e = normalizeSeed(energy == null ? 1.0 : energy);
    const now = this.now();
    this.thisTurn = new Set();
    if (e >= this.floor) {
      for (const id of ids || []) {
        const k = String(id);
        this.nodes.set(k, { value: e, similarity: null, timestamp: now });
        this.thisTurn.add(k);
      }
    }
    this._evictCap();
  }

  // 1.2: seed from semantic retrieval. `hits` is [{ id, similarity }] or
  // the recall scored shape [{ m, s }]. Activation = clamp(sim, 0, 1);
  // the raw similarity is stored beside it, not folded in.
  seedFromRetrieval(hits) {
    const now = this.now();
    this.thisTurn = new Set();
    for (const h of hits || []) {
      if (!h) continue;
      const id = h.id != null ? h.id : (h.m && h.m.id);
      if (id == null) continue;
      const sim = h.similarity != null ? h.similarity : h.s;
      const e = normalizeSeed(sim);
      if (e < this.floor) continue;
      const k = String(id);
      const simStored = Number(sim);
      this.nodes.set(k, {
        value: e,
        similarity: Number.isFinite(simStored) ? simStored : e,
        timestamp: now,
      });
      this.thisTurn.add(k);
    }
    this._evictCap();
  }

  // edges: Map<id, [{ id, sim }]> — sim is conductance (from
  // activationEdgesFromStore) or a test-injected weight.
  // Iterates thisTurn only, then clears it. Newly warmed ids are added
  // to the hop frontier, not to thisTurn, so a later recall does not
  // re-spread from leftover warmth. hops>1 walks that frontier so the
  // hop bound is real.
  // Update: E_target = min(1.0, max(E_target, E_source * sim * α)).
  // `live` (iterable of ids): refuse to write an id that is not in the
  // current memory set — never resurrect a soft-pruned / deleted record.
  spread(edges, opts) {
    opts = opts || {};
    const depth = opts.hops != null ? opts.hops : this.hops;
    const att = opts.attenuation != null ? opts.attenuation : this.attenuation;
    const live = opts.live != null ? new Set([...opts.live].map(String)) : null;
    const sources = [...this.thisTurn];
    this.thisTurn.clear();
    if (!edges || !sources.length || !(depth > 0)) return;
    const now = this.now();
    let frontier = sources;
    const seen = new Set(sources.map(String));
    for (let h = 0; h < depth; h++) {
      const next = [];
      for (const s of frontier) {
        const eSrc = this.get(s);
        if (!(eSrc > 0)) continue;
        const nbrs = edges.get(s) || edges.get(Number(s)) || edges.get(String(s)) || [];
        for (const e of nbrs) {
          const k = String(e.id);
          if (live && !live.has(k)) continue;
          const incoming = eSrc * (e.sim || 0) * att;
          if (!(incoming >= this.floor)) continue;
          const cur = this.get(k);
          const nv = Math.min(1.0, Math.max(cur, incoming));
          if (nv < this.floor) continue;
          if (nv > cur) {
            const prev = this.nodes.get(k);
            this.nodes.set(k, {
              value: nv,
              similarity: prev && prev.similarity != null ? prev.similarity : null,
              timestamp: now,
            });
          }
          if (!seen.has(k)) {
            seen.add(k);
            next.push(k);
          }
        }
      }
      frontier = next;
    }
    this._evictCap();
  }

  forget(id) {
    const k = String(id);
    this.nodes.delete(k);
    this.thisTurn.delete(k);
  }

  pruneTo(liveIds) {
    const live = new Set((liveIds || []).map(String));
    for (const id of [...this.nodes.keys()]) {
      if (!live.has(id)) this.forget(id);
    }
  }

  clear() {
    this.nodes.clear();
    this.thisTurn.clear();
  }

  trace(id) { return this.get(id); }

  entries() { return this.nodes.entries(); }

  snapshot() {
    const now = this.now();
    const out = {};
    for (const [id, n] of this.nodes) {
      const v = this.effective(n, now);
      if (v >= this.floor) out[id] = v;
    }
    return out;
  }

  _evictCap() {
    if (this.nodes.size <= this.cap) return;
    const now = this.now();
    const ranked = [...this.nodes.entries()]
      .map(([id, n]) => [id, this.effective(n, now)])
      .sort((a, b) => a[1] - b[1]);
    const drop = ranked.length - this.cap;
    for (let i = 0; i < drop; i++) {
      this.nodes.delete(ranked[i][0]);
      this.thisTurn.delete(ranked[i][0]);
    }
  }
}

/*
 * Tracing helper. Callers MUST gate on the trace flag before calling so the
 * hot path is a single boolean check when RESONANCE_WARM_TRACE is off (no
 * stringify, no iteration). activation is its own field — do not collapse it
 * into final_score (Phase 2.1). Phase 1 does not rank, so final_score stays
 * "semantic". Shape matches Phase 2.2's per-candidate record so that gate
 * can consume this hook rather than grow a second one.
 */
function emitActivationTrace(W, info) {
  if (!W) return;
  const candidates = [];
  const activation = {};
  const ids = [...W.nodes.keys()];
  for (const id of ids) {
    const v = W.get(id);
    if (!(v > 0)) continue;
    const sim = W.similarity(id);
    candidates.push({
      candidate_id: String(id),
      semantic: sim,
      hebbian: null,     // Phase 2.2 fills; not a rank input here
      recency: null,     // I2b telemetry; Phase 2.2 may trace it
      activation: v,
      final_score: "semantic",
    });
    activation[id] = v;
  }
  const row = {
    query: info && info.query,
    query_id: info && info.query_id,
    primary: ((info && info.primary) || []).map((m) => String(m && m.id != null ? m.id : m)),
    candidates,
    activation,
    final_score: "semantic",
  };
  try { process.stderr.write("[warm-trace] " + JSON.stringify(row) + "\n"); } catch { /* never throw */ }
}

const emitWarmTrace = emitActivationTrace;

module.exports = {
  WarmField,
  shouldSpread,
  vectorCount,
  WARM_EDGE_CAP,
  ATTENUATION,
  MAX_HOPS,
  FLOOR,
  CAP,
  HALF_LIFE_SECONDS,
  normalizeSeed,
  effectiveActivation,
  conductance,
  activationEdgesFromStore,
  emitActivationTrace,
  emitWarmTrace,
};
