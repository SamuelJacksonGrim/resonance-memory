/*
 * field.js - the associative layer for resonance-memory (Phase 2a, Node prototype).
 *
 * Builds a semantic association graph over stored memories from the vectors we
 * ALREADY store at save time - no new embedding calls, no LLM extraction. Edges
 * are per-node k-nearest-neighbors by cosine of full memory text vs full memory
 * text. That is the RICH-TO-RICH regime the measured finding says works; kNN is
 * relative per node, so it dodges the absolute-similarity floor (~0.45) that made
 * a global threshold connect everything.
 *
 * Recall can then expand from cosine seeds to a neighborhood (a region, not a
 * record). Co-activation reinforcement (memories recalled together strengthen
 * their edge) is a separate, additive weight - it never touches query ranking,
 * which stays pure cosine per the ROADMAP invariant.
 */

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/*
 * Build kNN association edges.
 *   records: [{ id, text, embedding }]  (embedding may be null -> node has no edges)
 *   opts.k: neighbors per node (default 3)
 *   opts.minSim: floor to drop weak/generic links (default 0.55)
 *   opts.bonus: (idA, idB) => number, a bounded Hebbian bonus added to cosine
 *               before gating/ranking (default: none). Lets a learned association
 *               lift a weak-cosine edge over the gate without erasing semantics.
 * Returns Map<id, [{ id, sim }]> sorted by blended score desc.
 */
function buildEdges(records, opts = {}) {
  const k = opts.k || 3;
  const minSim = opts.minSim != null ? opts.minSim : 0.55;
  const bonus = opts.bonus || (() => 0);
  const withVec = records.filter((r) => Array.isArray(r.embedding));
  const edges = new Map();
  for (const a of withVec) {
    const sims = [];
    for (const b of withVec) {
      if (a.id === b.id) continue;
      const s = cosine(a.embedding, b.embedding) + bonus(a.id, b.id);
      if (s >= minSim) sims.push({ id: b.id, sim: s });
    }
    sims.sort((x, y) => y.sim - x.sim);
    edges.set(a.id, sims.slice(0, k));
  }
  return edges;
}

/*
 * Expand from seed ids to their neighborhood.
 *   edges: Map from buildEdges
 *   seedIds: ids of the cosine-ranked query hits
 *   opts.hops: graph hops (default 1), opts.max: cap on returned related ids
 * Returns [{ id, sim, via }] for related ids NOT already in seedIds, sorted by sim.
 */
function neighborhood(edges, seedIds, opts = {}) {
  const hops = opts.hops || 1;
  const max = opts.max || 5;
  const seeds = new Set(seedIds.map(String));
  const seen = new Set(seeds);
  const out = [];
  let frontier = [...seedIds];
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const s of frontier) {
      for (const e of (edges.get(s) || edges.get(Number(s)) || [])) {
        const key = String(e.id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: e.id, sim: e.sim, via: s });
        next.push(e.id);
      }
    }
    frontier = next;
  }
  out.sort((a, b) => b.sim - a.sim);
  return out.slice(0, max);
}

module.exports = { cosine, buildEdges, neighborhood };
