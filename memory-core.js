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
 *   getLedger     () -> Ledger    (lazy: the Hebbian sidecar is only built on first
 *                                  field use, so the field toggle needs no restart)
 *
 * Ranking is COSINE ONLY (see server.js's invariants); the field is additive and
 * never allowed to throw into the recall path.
 */

const field = require("./field.js");
const {
  normalize, isHistoricalQuery, detectSupersession, supersedePatches,
} = require("./record.js");

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
 */
function createCore({ store, embed, fieldEnabled = () => false, getLedger }) {

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
      return "Already remembered — confirmed it's still current. (" + store.current().length + " memories total.)";
    }

    let embedding = null;
    try { embedding = (await embed([content]))[0]; } catch { embedding = null; }
    const rec = normalize({
      id: store.nextId(), created: now, modified: now, text: content,
      embedding, valid_from: now, valid_to: null, last_confirmed: now,
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
      return "Saved — updated what I knew, retiring memory " + superseded.id +
             ". (" + store.current().length + " memories total.)";
    }
    store.add(rec);
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

    let ranked;
    try {
      // Embed the query plus only the records missing a stored vector (legacy or a
      // save-time endpoint outage). Steady state: nothing missing -> one embed call.
      const vectorless = mems.filter((m) => !m.embedding);
      const vecs = await embed([query, ...vectorless.map((m) => m.text)]);
      const qv = vecs[0];
      const fresh = new Map();
      vectorless.forEach((m, i) => fresh.set(String(m.id), vecs[i + 1]));

      ranked = mems
        .map((m) => ({ m, s: cosine(qv, m.embedding || fresh.get(String(m.id))) }))
        .sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.m);

      store.applyRecall(ranked.map((m) => m.id), fresh); // backfill + bump in one write
    } catch {
      ranked = mems
        .map((m) => ({ m, s: keywordScore(query, m.text) }))
        .sort((a, b) => b.s - a.s).slice(0, k)
        .filter((x, i) => x.s > 0 || i === 0).map((x) => x.m);
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
        const L = getLedger();
        const bonus = (a, b) => L.bonus(a, b);
        const edges = field.buildEdges(mems, { k: 2, minSim: 0.55, bonus });
        const rel = field.neighborhood(edges, ranked.map((m) => m.id), { hops: 1, max: 4 });
        if (rel.length) {
          const byId = new Map(mems.map((m) => [String(m.id), m]));
          out += "\n\nRelated:\n" + rel.map((e) => "- [id " + e.id + "] " + byId.get(String(e.id)).text).join("\n");
        }
        // Hebbian reinforcement on the returned payload, provenance-discounted.
        L.reinforceRecall(ranked.map((m) => m.id), rel.map((e) => e.id));
        L.tick();
        L.save();
      } catch { /* the field is additive; never let it break recall */ }
    }
    return out;
  }

  async function edit(id, content) {
    if (id === undefined || id === null || id === "") return "Provide the `id` shown in a recall listing.";
    content = (content || "").trim();
    if (!content) return "Provide the new `content`.";
    let embedding = null;
    try { embedding = (await embed([content]))[0]; } catch { embedding = null; }
    const now = new Date().toISOString();
    // An edit is a correction in place: the fact is current again as of now.
    const ok = store.update(id, { text: content, embedding, modified: now, last_confirmed: now });
    return ok ? "Edited memory " + id + "." : "No memory with id " + id + ".";
  }

  function remove(id) {
    if (id === undefined || id === null || id === "") return "Provide the `id` shown in a recall listing.";
    const ok = store.update(id, { deleted: true, modified: new Date().toISOString() });
    return ok ? "Deleted memory " + id + "." : "No memory with id " + id + ".";
  }

  return { save, recall, edit, remove };
}

module.exports = { createCore, cosine, keywordScore };
