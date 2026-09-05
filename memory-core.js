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
 *   getEdgeStore  () -> EdgeStore (lazy: built on first field-on recall OR first
 *                                  save-time bind. Field toggle needs no restart.
 *                                  Duck-typed: bonus/reinforceRecall/save;
 *                                  save-time bind also needs get/put.
 *                                  acceptRequest is optional (Phase 0.3 dedup).
 *                                  tick() is retired — I6, Phase 0.2.)
 *   getLedger     () -> same surface as getEdgeStore; kept as a fallback alias so
 *                       a leftover injector still works. Live path uses getEdgeStore.
 *   warmEnabled   () -> boolean   (RESONANCE_WARM_FIELD; default off)
 *   getWarm       () -> WarmField (lazy, like getEdgeStore; in-proc Map, never persisted)
 *   getEdges      (mems, L) -> Map  ALWAYS a Map, never null. Cap is at spread().
 *   saveSeed      () -> boolean   (production may pass true; eval MUST pass false)
 *   warmTrace     () -> boolean   (RESONANCE_WARM_TRACE; default off, zero-cost)
 *   warmEdgeCap   () -> number    (RESONANCE_WARM_EDGE_CAP; default 512)
 *   dedupThresholds () -> { hi, lo }  (RM-02.b cosine bands. Production reads
 *                                  live config + env; eval/tests use defaults
 *                                  or inject. Never read CONFIG_PATH here —
 *                                  that would make the golden depend on the
 *                                  user's panel file.)
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
  detectNearDuplicate, pickMergeSurvivor,
} = require("./record.js");
const { makeEdge, setSemantic, semanticValid, hebbianDecayType, reactivateEdge } = require("./edges.js");

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
 * Save-time semantic bind (Phase 0.1). K neighbors above SAVE_TIME_MIN_COS are
 * persisted on the EdgeStore as a derived cache; Hebbian weight starts at 0
 * (no seeded baseline — an unreinforced edge's learned signal is genuinely
 * zero). Recall does NOT read these edges yet: Related: still comes from
 * field.js at minSim 0.55. The two thresholds are deliberately different
 * (phase-0 Risk #2):
 *
 *   0.55 at RECALL  — a tight gate for what surfaces in Related:
 *   0.25 at SAVE    — a looser net for what's worth persisting as structure
 *                     (Phase 0.4 SEMANTIC_PRUNE_GATE matches this: below it
 *                     an edge wouldn't even be created today, so it is the
 *                     prune floor. Do not raise prune to 0.55.)
 *
 * Unifying them would either drop persistable structure (raising this to 0.55)
 * or flood Related: (lowering recall to 0.25). Do not silently collapse them.
 * The cost of the O(N) scan this implies is measured by eval/save-time-cost.js;
 * that sweep, not this comment, decides whether RM-07 is mandatory.
 */
const SAVE_TIME_K = 5;
const SAVE_TIME_MIN_COS = 0.25;

/*
 * Cosine-banded dedup at save (RM-02.b). Thresholds are CONFIG, not
 * constants — env `RESONANCE_DEDUP_HI` / `RESONANCE_DEDUP_LO` plus the
 * live-config keys `dedup_hi` / `dedup_lo` (same pattern as the field
 * toggle). These defaults are the tuned values.
 *
 * Tuned on eval/duplicates (nomic-embed-text-v1.5, eval/RESULTS.md
 * RM-02.a geometry, confirmed RM-02.b A/B):
 *   HI paraphrases  0.9522–0.9883  (tea 0.9522 is the tightest HI)
 *   mid (same fact, more specific)  0.9261–0.9435
 *   controls  ≤ ~0.69  (dog/cat ~0.69, peanuts/peanut-allergy ~0.67)
 *
 * 0.95 / 0.88 separate those three bands. HI-only restatement leaves
 * the three mid extras and misses the pre-declared 50% bar (0.1667
 * vs ≤ 0.1591) — the mid merge is what acceptance actually demands.
 * 0.88 sits well above the control ceiling, so dog/cat cannot merge
 * (that would drop recall@5 below 1.0, a FAIL even if dup_rate looks
 * great).
 *
 * ≥ hi (not >): the spec is "cosine ≥ DEDUP_HI". Tea at 0.9522 clears
 * 0.95 with margin, so the equality case is hypothetical; if a pair
 * sat exactly on 0.95 we treat it as restatement (keep the original,
 * don't rewrite) rather than merge. That's the conservative I8 choice
 * for near-identity.
 *
 * The scan is O(N) cosine, same cost class as the 0.1 save-time bind
 * (eval/save-time-cost.js: p95 77.1 ms at N=100k). Not a reason to
 * force RM-07 from this slice.
 */
const DEDUP_HI = 0.95;
const DEDUP_LO = 0.88;

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readDedupThresholds(config) {
  const hiEnv = envNumber("RESONANCE_DEDUP_HI", DEDUP_HI);
  const loEnv = envNumber("RESONANCE_DEDUP_LO", DEDUP_LO);
  const c = config && typeof config === "object" ? config : {};
  const hi = typeof c.dedup_hi === "number" && Number.isFinite(c.dedup_hi) ? c.dedup_hi : hiEnv;
  const lo = typeof c.dedup_lo === "number" && Number.isFinite(c.dedup_lo) ? c.dedup_lo : loEnv;
  return { hi, lo };
}

/*
 * Default edge source for warmth (and, later, a Phase 0 swap). ALWAYS returns a
 * Map (possibly empty). NEVER null — null-as-sentinel would disable field
 * neighborhood on large stores (WARM_EDGE_CAP gates spread(), not Related:).
 */
function defaultGetEdges(mems, L) {
  const list = mems || [];
  const byId = new Map(list.map((m) => [String(m.id), m]));
  return field.buildEdges(list, {
    k: 2, minSim: 0.55,
    bonus: L ? (a, b) => L.bonus(a, b, {
      type: hebbianDecayType(byId.get(String(a)), byId.get(String(b))),
    }) : () => 0,
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

/*
 * Persist the new record's top-K semantic neighbors into the EdgeStore.
 *
 * Deliberately NOT field.buildEdges: that path is recall-time (k=2, minSim
 * 0.55, mutual kNN, Hebbian bonus blended in). This is save-time structure
 * (K=5, minCos 0.25, no bonus, not mutual). Recall still uses field.js;
 * wiring Related: to this table is a later, gated slice.
 *
 * src_versions are tagged to the CANONICAL endpoints (edge.a / edge.b after
 * sort), never to makeEdge's argument order — the Slice B gotcha. New edges
 * get hebbian.weight = 0 and origin "save-time-neighbor". An existing edge
 * (e.g. co-activation) has its semantic cache refreshed if stale; Hebbian
 * bytes and origin are left alone. Sidecar write is one EdgeStore.save at
 * the end, and only if something actually changed (transition table:
 * "save where edge exists → write only if semantic recomputed").
 *
 * I5: this writes the SIDECAR, never the JSONL store.
 */
function bindSaveTimeNeighbors(rec, mems, edgeStore, opts = {}) {
  if (!edgeStore || typeof edgeStore.get !== "function" || typeof edgeStore.put !== "function") {
    return { bound: 0, wrote: false };
  }
  const vec = rec && rec.embedding;
  if (!Array.isArray(vec) || vec.length === 0) return { bound: 0, wrote: false };

  const k = opts.k != null ? opts.k : SAVE_TIME_K;
  const minCos = opts.minCos != null ? opts.minCos : SAVE_TIME_MIN_COS;
  const scores = [];
  for (const m of mems || []) {
    if (String(m.id) === String(rec.id)) continue;
    if (!Array.isArray(m.embedding) || m.embedding.length === 0) continue;
    const cos = cosine(vec, m.embedding);
    if (cos >= minCos) scores.push({ m, cos });
  }
  scores.sort((a, b) => b.cos - a.cos);
  const top = scores.slice(0, k);
  if (!top.length) return { bound: 0, wrote: false };

  const byId = new Map();
  for (const m of mems || []) byId.set(String(m.id), m);
  byId.set(String(rec.id), rec);

  let wrote = false;
  const now = typeof edgeStore.now === "function" ? edgeStore.now() : undefined;
  for (const { m, cos } of top) {
    let edge = edgeStore.get(rec.id, m.id);
    if (!edge) {
      // makeEdge sorts endpoints; do NOT pass semantic here — src_versions
      // would follow argument order, not canonical a/b (Slice B).
      edge = edgeStore.put(makeEdge(rec.id, m.id, {
        origin: "save-time-neighbor",
        hebbianWeight: 0,
      }));
      wrote = true;
    } else if (edge.pruned_at) {
      // save() touching an endpoint of a pruned edge revives it in place
      // (Phase 0.4 / I1: reactivation is a consequence of an existing
      // mutation, never a fifth tool). created_at and hebbian stay put.
      reactivateEdge(edge, now);
      wrote = true;
    }
    const recA = byId.get(String(edge.a));
    const recB = byId.get(String(edge.b));
    const verA = recA && typeof recA.embedding_version === "number" ? recA.embedding_version : 1;
    const verB = recB && typeof recB.embedding_version === "number" ? recB.embedding_version : 1;
    if (!semanticValid(edge, verA, verB)) {
      setSemantic(edge, cos, { a: verA, b: verB });
      wrote = true;
    }
  }
  if (wrote && typeof edgeStore.save === "function") edgeStore.save();
  return { bound: top.length, wrote };
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
  dedupThresholds = () => readDedupThresholds(null),
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

  // Server-side reactivation (Phase 0.4 / I1). A save/edit that touches an
  // endpoint revives that id's pruned incident edges in place. Not a tool.
  // Wrapped so a missing EdgeStore cannot fail the verb (I3).
  function tryReactivateIncident(id) {
    try {
      if (id == null) return;
      const L = hebbianStore();
      if (!L || typeof L.reactivateIncident !== "function") return;
      const n = L.reactivateIncident(id);
      if (n && typeof L.save === "function") L.save();
    } catch { /* reactivation must never break save/edit */ }
  }

  // Save-time semantic bind. Sidecar write (I5 allows it — I5 protects the
  // JSONL store). Wrapped so a missing/corrupt EdgeStore cannot fail save (I3).
  // No vector → nothing to compare; bind later when a real vector exists.
  // requestId: same MCP request retried must not re-bind (0.3). No id
  // (eval / tests) applies normally.
  function tryBindSaveTime(rec, mems, requestId) {
    try {
      if (!Array.isArray(rec && rec.embedding) || rec.embedding.length === 0) return;
      const L = hebbianStore();
      if (!L) return;
      if (typeof L.acceptRequest === "function" && !L.acceptRequest(requestId)) return;
      bindSaveTimeNeighbors(rec, mems, L);
    } catch { /* save-time bind must never break save */ }
  }

  // Restatement (byte-identical OR cosine ≥ DEDUP_HI): bump confirmation +
  // access_count, do not append. access_count is a retention signal (I2:
  // never rank). The original text stays; nothing is lost (I8).
  function confirmRestatement(existing, now) {
    store.update(existing.id, {
      last_confirmed: now,
      access_count: (existing.access_count || 0) + 1,
    });
    tryReactivateIncident(existing.id);  // save touching an existing endpoint (0.4)
    tryPrimeSave(existing.id);
    return "Already remembered — confirmed it's still current. (" + store.current().length + " memories total.)";
  }

  // Mid-band merge. Reuses supersedePatches (RM-03 machinery) so the loser
  // is linked with superseded_by and recoverable, never hard-deleted (I8).
  // Survivor text is one of the two originals (pickMergeSurvivor) — never a
  // blend. Metadata is unioned onto the survivor.
  function commitMerge(incoming, existing, mems, now, requestId) {
    const survivor = pickMergeSurvivor(existing, incoming);
    const loser = survivor === incoming ? existing : incoming;
    const p = supersedePatches(loser, survivor, now);
    const union = {
      last_confirmed: now,
      is_constraint: !!(existing.is_constraint || incoming.is_constraint),
      access_count: (existing.access_count || 0) + (incoming.access_count || 0) + 1,
    };
    if (existing.source === "user_stated" || incoming.source === "user_stated") {
      union.source = "user_stated";
    }

    if (survivor === incoming) {
      Object.assign(incoming, p.new, union);
      store.add(incoming);
      store.update(existing.id, p.old);
      tryBindSaveTime(incoming, mems.filter((m) => String(m.id) !== String(existing.id)), requestId);
      tryPrimeSave(incoming.id);
      return "Saved — merged a near-duplicate, retiring memory " + existing.id +
             ". (" + store.current().length + " memories total.)";
    }

    // Existing text is longer or equal: keep it current, persist the
    // incoming as already-superseded so the shorter wording is recoverable.
    Object.assign(incoming, p.old);
    store.add(incoming);
    store.update(existing.id, Object.assign({}, p.new, union));
    tryReactivateIncident(existing.id);
    tryPrimeSave(existing.id);
    return "Saved — merged a near-duplicate into memory " + existing.id +
           ". (" + store.current().length + " memories total.)";
  }

  function resolveDedupBands() {
    try {
      const t = typeof dedupThresholds === "function" ? dedupThresholds() : dedupThresholds;
      if (t && typeof t.hi === "number" && typeof t.lo === "number") return t;
    } catch { /* injected getter must never break save */ }
    return { hi: DEDUP_HI, lo: DEDUP_LO };
  }

  async function save(content, opts) {
    const requestId = opts && opts.requestId;
    content = (content || "").trim();
    if (!content) return "Nothing to save: `content` was empty.";
    const now = new Date().toISOString();

    // Exact restatement of a memory that is still true: confirm it rather than
    // storing a second copy. Free (no embed). Cosine-banded HI restatement
    // below generalizes this to semantic near-identity (RM-02.b).
    const mems = store.current();
    const same = mems.find((r) => r.text === content);
    if (same) return confirmRestatement(same, now);

    let embedding = null;
    try { embedding = (await embed([content]))[0]; } catch { embedding = null; }
    const rec = normalize({
      id: store.nextId(), created: now, modified: now, text: content,
      embedding, valid_from: now, valid_to: null, last_confirmed: now,
      embedding_version: 1,   // first generation, even if this save's embed failed
    });

    // RM-02.b: cosine-banded dedup against already-stored vectors.
    // No vector (embedder down) → can't compare → fall through to append,
    // don't crash. Dedup before RM-03: a near-identical restatement is the
    // same fact, not a correction. Scan is O(N) cosine, same class as the
    // 0.1 save-time bind — not a reason to force RM-07 from this slice.
    let dup = null;
    try {
      dup = detectNearDuplicate(rec, mems, cosine, resolveDedupBands());
    } catch { dup = null; }
    if (dup && dup.action === "restate") return confirmRestatement(dup.match, now);
    if (dup && dup.action === "merge") return commitMerge(rec, dup.match, mems, now, requestId);

    // RM-03: does this correct a fact we already hold? A save carrying an explicit
    // correction cue ("moved", "now", "no longer"...) retires the single most-similar
    // current memory rather than piling a contradiction beside it. See docs/proposed
    // /0002 and eval/RESULTS.md for why the cue - not cosine - is the precision gate.
    const superseded = detectSupersession(rec, mems, cosine);
    if (superseded) {
      const p = supersedePatches(superseded, rec, now);
      Object.assign(rec, p.new);            // new memory carries supersedes/revision
      store.add(rec);                       // append the correction as current
      store.update(superseded.id, p.old);   // retire the old row (valid_to/superseded_by)
      // Bind against still-current neighbors, not the row we just retired
      // (edge inheritance across supersession is Phase 7, undecided).
      tryBindSaveTime(rec, mems.filter((m) => String(m.id) !== String(superseded.id)), requestId);
      tryPrimeSave(rec.id);
      return "Saved — updated what I knew, retiring memory " + superseded.id +
             ". (" + store.current().length + " memories total.)";
    }
    store.add(rec);
    tryBindSaveTime(rec, mems, requestId);
    tryPrimeSave(rec.id);
    return "Saved. (" + store.current().length + " memories total.)";
  }

  async function recall(query, k = 5, opts) {
    // recall(query, { requestId }) — k omitted. Eval/tests pass (query) or (query, k).
    if (k != null && typeof k === "object") { opts = k; k = 5; }
    const requestId = opts && opts.requestId;
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
          const byId = new Map(mems.map((m) => [String(m.id), m]));
          // Discovery bonus uses the wall-clock-decayed weight (effectiveHebbian),
          // never the stored one. Type picks the half-life (constraint ~30d /
          // fact ~7d). Computed on read — no write (I6).
          const bonus = (a, b) => L.bonus(a, b, {
            type: hebbianDecayType(byId.get(String(a)), byId.get(String(b))),
          });
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
            out += "\n\nRelated:\n" + merged.map((e) => "- [id " + e.id + "] " + byId.get(String(e.id)).text).join("\n");
          }
          // Hebbian reinforcement on the returned payload, provenance-discounted.
          // Writes the SIDECAR (.edges.json), never the JSONL store (I5 / BUG-002).
          // Decay is NOT ticked here — I6: reading must not drive the decay clock.
          // reinforceRecall is retained (the differentiator); tick() is gone.
          // Materialize-on-mutation (0.3) happens inside _bump; typeFn picks
          // the same half-life class bonus() used on this turn. requestId
          // makes a retried MCP tools/call apply once; no id → apply (eval).
          const applied = L.reinforceRecall(
            ranked.map((m) => m.id),
            merged.map((e) => e.id),
            {
              requestId,
              typeFn: (a, b) => hebbianDecayType(byId.get(String(a)), byId.get(String(b))),
            }
          );
          // Skip the sidecar rewrite on a duplicate request (no new bytes).
          // A duck-typed mock that returns undefined still saves (`!== false`).
          if (applied !== false) L.save();
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

  // opts.requestId is accepted (server threads it into every verb) but
  // unused for dedup: the transition table forbids a dedup-record stamp
  // on edit. Phase 0.4 reactivation is the one edge write edit is allowed
  // — and only when a pruned incident edge actually exists. No pruned
  // edges → sidecar bytes unchanged (the 0.3 tests).
  async function edit(id, content, _opts) {
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
    tryReactivateIncident(id);
    return embedded
      ? "Edited memory " + id + "."
      : "Edited memory " + id + ", but re-embedding failed - it will match on keywords only until edited again.";
  }

  function remove(id, _opts) {
    if (id === undefined || id === null || id === "") return "Provide the `id` shown in a recall listing.";
    const ok = store.update(id, { deleted: true, modified: new Date().toISOString() });
    if (ok) {
      try { if (warmEnabled()) warm().forget(id); } catch { /* I3 */ }
    }
    return ok ? "Deleted memory " + id + "." : "No memory with id " + id + ".";
  }

  return { save, recall, edit, remove };
}

module.exports = {
  createCore, cosine, keywordScore, defaultGetEdges, asEdgeMap,
  bindSaveTimeNeighbors, SAVE_TIME_K, SAVE_TIME_MIN_COS,
  DEDUP_HI, DEDUP_LO, readDedupThresholds,
};
