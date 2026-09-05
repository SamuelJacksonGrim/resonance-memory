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
 * memory-core.js - the four cognitive verbs, as ONE implementation.
 *
 * This used to live inline in server.js, with eval/pipeline.js keeping a hand-copied
 * "faithful mirror" beside it. Two copies of the recall path is exactly the drift the
 * RM-00 harness exists to catch, so the shared behavior now lives here and BOTH the
 * MCP server and the eval harness build on it. The RM-00 golden is the proof this
 * extraction preserved behavior byte-for-byte.
 *
 * Everything environment-specific is INJECTED, nothing is reached for:
 *   store         a JsonlStore (or any object with the same method surface)
 *   embed         async (texts[]) -> vectors[]   (network in prod, cached in eval)
 *   fieldEnabled  () -> boolean   (live config read in prod, a fixed flag in eval)
 *   getEdgeStore  () -> EdgeStore (lazy: the unified sidecar is only built on first
 *                                  field use, so the field toggle needs no restart.
 *                                  Duck-typed: bonus/reinforceRecall/tick/save.)
 *   getLedger     () -> same surface as getEdgeStore; kept as a fallback alias so
 *                       a leftover injector still works. Live path uses getEdgeStore.
 *   warmEnabled   () -> boolean   (RESONANCE_WARM_FIELD; default off)
 *   getWarm       () -> WarmField (lazy, like getEdgeStore; in-proc Map, never persisted)
 *   getEdges      (mems, L) -> Map  ALWAYS a Map, never null. Cap is at spread().
 *   saveSeed      () -> boolean   (production may pass true; eval MUST pass false)
 *   warmTrace     () -> boolean   (RESONANCE_WARM_TRACE; default off, zero-cost)
 *   warmEdgeCap   () -> number    (RESONANCE_WARM_EDGE_CAP; default 512)
 *
 * Ranking is COSINE ONLY (see server.js's invariants); the field is additive and
 * never allowed to throw into the recall path. Warmth in PR1 is the same: seed
 * and spread run when enabled, but nothing is read into the output string.
 */

const field = require("./field.js");
const {
  WarmField, shouldSpread, WARM_EDGE_CAP, emitWarmTrace,
} = require("./warm.js");
const {
  normalize, isHistoricalQuery, detectSupersession, supersedePatches,
} = require("./record.js");

// Reciprocal-kNN edge construction (RM-00 field experiment, 2026-08-01). Directional
// kNN let a one-sided "hub" node bleed into a seed's neighborhood as a false positive
// (the noise-schedule 'Thursday' collision). Requiring the association to be mutual
// pruned that FP with no regressions - a Pareto win on the corpus - so it is now the
// DEFAULT topology. Set RESONANCE_FIELD_MUTUAL=0 to fall back to directional kNN.
const FIELD_MUTUAL = !["0", "false", "no"].includes(String(process.env.RESONANCE_FIELD_MUTUAL || "").toLowerCase());

// Constraint rescue (RM-00 field experiment #2). Decouple the internal SEARCH radius
// from the RETURN radius: cosine-rank all memories, hand the model the top RETURN_K,
// but let the field's constraint walk seed from the top K_SEARCH - so a bridge like
// "lemon bars" (rank 7) becomes a seed and can route to the constraint behind it
// ("diabetic", rank 21) that the model never sees directly. CONSTRAINT_GATE is the
// min cosine for a constraint<->seed link; 0.55 (stage 1) forms diabetic/veg bridges,
// 0.45 (stage 2) reaches the heights<->rooftop isolate (0.472). Env-overridable to A/B.
const K_SEARCH = Number(process.env.RESONANCE_FIELD_KSEARCH) || 15;
// 0.45 (stage 2) is the DEFAULT: it reaches the heights<->rooftop isolate (0.472) that
// the 0.55 edge gate misses, and on the corpus it cost zero tangent bleed. The gate only
// governs whether a TYPED constraint finds a bridge, so it cannot loosen ordinary recall.
const CONSTRAINT_GATE = process.env.RESONANCE_CONSTRAINT_GATE ? Number(process.env.RESONANCE_CONSTRAINT_GATE) : 0.45;

/*
 * Default edge source for warmth (and, later, a Phase 0 swap). ALWAYS returns a
 * Map (possibly empty). NEVER null — null-as-sentinel would disable field
 * neighborhood on large stores (WARM_EDGE_CAP gates spread(), not Related:).
 */
function defaultGetEdges(mems, L) {
  return field.buildEdges(mems || [], {
    k: 2, minSim: 0.55,
    bonus: L ? (a, b) => L.bonus(a, b) : () => 0,
    mutual: FIELD_MUTUAL,
  });
}

function asEdgeMap(edges) {
  return edges instanceof Map ? edges : new Map();
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Fallback ranking when the embedder is unreachable at recall time. Deliberately
// crude - it exists so a dead endpoint degrades to keyword overlap rather than an
// error, not to compete with cosine.
function keywordScore(query, text) {
  const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of q) if (t.includes(w)) hits++;
  return q.size ? hits / q.size : 0;
}

/*
 * Build the four verbs over an injected environment. Returns { save, recall, edit,
 * remove }. `remove` (not `delete`) avoids the reserved word; callers map their own
 * verb name onto it.
 *
 * Warmth flags default off: decay/seed/spread do not run, output is today's
 * cosine (+ field). When warmEnabled is true, the silent hook still must not
 * change the output string (PR1); Related: consumption is PR2, rank is PR3.
 */
function createCore({
  store, embed,
  fieldEnabled = () => false,
  getEdgeStore,
  getLedger,
  warmEnabled = () => false,
  saveSeed = () => false,
  getWarm,
  getEdges,
  warmTrace = () => false,
  warmEdgeCap = () => WARM_EDGE_CAP,
}) {

  // Lazy fallback so a test can pass warmEnabled without getWarm. Production
  // always injects getWarm (one Map per MCP process).
  let _warm = null;
  function warm() {
    if (getWarm) return getWarm();
    if (!_warm) _warm = new WarmField();
    return _warm;
  }

  // Hebbian sidecar. EdgeStore is the live implementation (Slice C); getLedger
  // remains a duck-typed fallback. Returning null skips the additive field
  // (same as the old getLedger() throw → catch), so a test that never injects
  // a sidecar still gets plain cosine. A present-but-empty/corrupt store still
  // runs semantic kNN with bonus 0 (I3 fail-open).
  function hebbianStore() {
    if (typeof getEdgeStore === "function") return getEdgeStore();
    if (typeof getLedger === "function") return getLedger();
    return null;
  }

  function edgesFor(mems) {
    const L = hebbianStore();
    return asEdgeMap((getEdges || defaultGetEdges)(mems, L));
  }

  function pruneWarm(W, mems) {
    const live = new Set((mems || []).map((m) => String(m.id)));
    for (const [id] of [...W.entries()]) {
      if (!live.has(String(id))) W.forget(id);
    }
  }

  // Internal prime (I1: not a tool). Whole path in try/catch — I3.
  function tryPrimeSave(id) {
    try {
      if (!warmEnabled() || !saveSeed() || id == null) return;
      const W = warm();
      W.seed([id], 1.0);
      const mems = store.current();
      if (shouldSpread(mems, warmEdgeCap())) W.spread(edgesFor(mems));
    } catch { /* warmth must never break save */ }
  }

  async function save(content) {
    content = (content || "").trim();
    if (!content) return "Nothing to save: `content` was empty.";
    const now = new Date().toISOString();

    // Exact restatement of a memory that is still true: confirm it rather than
    // storing a second copy. Near-duplicate detection (cosine-banded) is RM-02;
    // this is only the free, unambiguous case.
    const same = store.current().find((r) => r.text === content);
    if (same) {
      store.update(same.id, { last_confirmed: now });
      tryPrimeSave(same.id);
      return "Already remembered — confirmed it's still current. (" + store.current().length + " memories total.)";
    }

    let embedding = null;
    try { embedding = (await embed([content]))[0]; } catch { embedding = null; }
    const rec = normalize({
      id: store.nextId(), created: now, modified: now, text: content,
      embedding, valid_from: now, valid_to: null, last_confirmed: now,
      embedding_version: 1,   // first generation, even if this save's embed failed
    });

    // RM-03: does this correct a fact we already hold? A save carrying an explicit
    // correction cue ("moved", "now", "no longer"...) retires the single most-similar
    // current memory rather than piling a contradiction beside it. See docs/proposed
    // /0002 and eval/RESULTS.md for why the cue - not cosine - is the precision gate.
    const superseded = detectSupersession(rec, store.current(), cosine);
    if (superseded) {
      const p = supersedePatches(superseded, rec, now);
      Object.assign(rec, p.new);            // new memory carries supersedes/revision
      store.add(rec);                       // append the correction as current
      store.update(superseded.id, p.old);   // retire the old row (valid_to/superseded_by)
      tryPrimeSave(rec.id);
      return "Saved — updated what I knew, retiring memory " + superseded.id +
             ". (" + store.current().length + " memories total.)";
    }
    store.add(rec);
    tryPrimeSave(rec.id);
    return "Saved. (" + store.current().length + " memories total.)";
  }

  async function recall(query, k = 5) {
    query = (query || "").trim();
    if (!query) return "Provide a `query` string to recall.";
    // Answer from what is currently true. Superseded memories surface only when the
    // question is explicitly about the past ("where did I used to work").
    const historical = isHistoricalQuery(query);
    const mems = historical ? store.active() : store.current();
    if (!mems.length) {
      return store.active().length
        ? "Nothing current matches. (Older, superseded memories exist — ask about the past to see them.)"
        : "No memories saved yet.";
    }

    let ranked;               // the top-k the model actually sees (return radius)
    let seedPool = [];        // wider top-K_SEARCH ids: the field's constraint walk seeds
    try {
      // Embed the query plus only the records missing a stored vector (legacy or a
      // save-time endpoint outage). Steady state: nothing missing -> one embed call.
      const vectorless = mems.filter((m) => !m.embedding);
      const vecs = await embed([query, ...vectorless.map((m) => m.text)]);
      const qv = vecs[0];
      const fresh = new Map();
      vectorless.forEach((m, i) => fresh.set(String(m.id), vecs[i + 1]));

      const scored = mems
        .map((m) => ({ m, s: cosine(qv, m.embedding || fresh.get(String(m.id))) }))
        .sort((a, b) => b.s - a.s);
      ranked = scored.slice(0, k).map((x) => x.m);
      seedPool = scored.slice(0, K_SEARCH).map((x) => x.m.id);

      store.applyRecall(ranked.map((m) => m.id), fresh); // backfill + bump in one write
    } catch {
      const scored = mems
        .map((m) => ({ m, s: keywordScore(query, m.text) }))
        .sort((a, b) => b.s - a.s);
      ranked = scored.slice(0, k).filter((x, i) => x.s > 0 || i === 0).map((x) => x.m);
      seedPool = scored.slice(0, K_SEARCH).map((x) => x.m.id);
      store.applyRecall(ranked.map((m) => m.id), null); // bump access even on fallback
    }

    // When history was asked for, say plainly which memories are no longer current
    // so the model doesn't present a superseded fact as the present truth.
    let out = ranked.map((m, i) =>
      (i + 1) + ". [id " + m.id + "] " + m.text +
      (m.valid_to ? "  (no longer current — superseded " + m.valid_to.slice(0, 10) + ")" : "")
    ).join("\n");
    if (fieldEnabled() && mems.length > ranked.length) {
      try {
        const L = hebbianStore();
        if (L) {
          const bonus = (a, b) => L.bonus(a, b);
          const edges = field.buildEdges(mems, { k: 2, minSim: 0.55, bonus, mutual: FIELD_MUTUAL });
          // General neighborhood: forward one hop from the RETURNED seeds (unchanged).
          const rel = field.neighborhood(edges, ranked.map((m) => m.id), { hops: 1, max: 4 });
          // Constraint rescue: apex rules reachable from the WIDER seed pool. Restricted
          // to typed constraints so the expanded radius can't re-drag non-constraint hubs.
          const cres = field.reachableConstraints(mems, seedPool, { gate: CONSTRAINT_GATE, k: 2, max: 4, exclude: ranked.map((m) => m.id) });
          // Merge (constraints first), drop anything already returned or duplicated.
          const seen = new Set(ranked.map((m) => String(m.id)));
          const merged = [];
          for (const e of [...cres, ...rel]) {
            const key = String(e.id);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(e);
          }
          if (merged.length) {
            const byId = new Map(mems.map((m) => [String(m.id), m]));
            out += "\n\nRelated:\n" + merged.map((e) => "- [id " + e.id + "] " + byId.get(String(e.id)).text).join("\n");
          }
          // Hebbian reinforcement on the returned payload, provenance-discounted.
          // Writes the SIDECAR (.edges.json), never the JSONL store (I5 / BUG-002).
          L.reinforceRecall(ranked.map((m) => m.id), merged.map((e) => e.id));
          L.tick();
          L.save();
        }
      } catch { /* the field is additive; never let it break recall */ }
    }

    // Silent warm hook (PR1). Flags default off → this block does not run and
    // 27/31 is the field's A/B, unchanged. When warmEnabled, decay/seed/spread
    // run and E is observable via WarmField.trace, but `out` is not consulted
    // — byte-identical to warm-off. Related: consumption is PR2; rank is PR3.
    // I3: the whole path is in try/catch and degrades to the cosine `out` already
    // built. I7: nothing here writes E to disk.
    try {
      if (warmEnabled()) {
        const W = warm();
        W.decayAll({ turns: 1 });
        pruneWarm(W, mems);
        W.seed(ranked.map((m) => m.id), 1.0);
        if (shouldSpread(mems, warmEdgeCap())) W.spread(edgesFor(mems));
        // Zero-cost when off: one boolean, no stringify, no iteration.
        if (warmTrace()) emitWarmTrace(W, { query, primary: ranked });
      }
    } catch { /* warmth is additive; never let it break recall */ }

    return out;
  }

  async function edit(id, content) {
    if (id === undefined || id === null || id === "") return "Provide the `id` shown in a recall listing.";
    content = (content || "").trim();
    if (!content) return "Provide the new `content`.";
    // A failed re-embed must never reach store.update(): it Object.assigns the
    // patch, so a null here would overwrite a good vector. Keep the old one - a
    // stale vector still ranks, and the next successful edit repairs it.
    // embedding_version moves in lockstep with the vector. Bumping it on a
    // failed embed would make text-drifted-from-vector look like a genuine
    // re-embed, and every incident edge would falsely self-invalidate
    // (Phase 0 validity-by-comparison; BUG-008 class). Omit both fields.
    let embedding = null;
    try { embedding = (await embed([content]))[0]; } catch { embedding = null; }
    const embedded = Array.isArray(embedding) && embedding.length > 0;
    const now = new Date().toISOString();
    // An edit is a correction in place: the fact is current again as of now.
    const patch = { text: content, modified: now, last_confirmed: now };
    if (embedded) {
      patch.embedding = embedding;   // omitted entirely on failure
      const current = store.get(id);
      if (!current) return "No memory with id " + id + ".";
      const prev = typeof current.embedding_version === "number" ? current.embedding_version : 1;
      patch.embedding_version = prev + 1;
    }
    const ok = store.update(id, patch);
    if (!ok) return "No memory with id " + id + ".";
    return embedded
      ? "Edited memory " + id + "."
      : "Edited memory " + id + ", but re-embedding failed - it will match on keywords only until edited again.";
  }

  function remove(id) {
    if (id === undefined || id === null || id === "") return "Provide the `id` shown in a recall listing.";
    const ok = store.update(id, { deleted: true, modified: new Date().toISOString() });
    if (ok) {
      try { if (warmEnabled()) warm().forget(id); } catch { /* I3 */ }
    }
    return ok ? "Deleted memory " + id + "." : "No memory with id " + id + ".";
  }

  return { save, recall, edit, remove };
}

module.exports = { createCore, cosine, keywordScore, defaultGetEdges, asEdgeMap };
