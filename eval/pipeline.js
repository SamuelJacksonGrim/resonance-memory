/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See <https://www.gnu.org/licenses/>.
 */
/*
 * eval/pipeline.js - an injectable save/recall pipeline for the RM-00 harness.
 *
 * This is a FAITHFUL composition of the real substrate modules (store.js,
 * field.js, ledger.js, record.js), mirroring server.js's saveMemory/recallMemory
 * exactly, but with the store, embedder, and field flag INJECTED so the harness
 * can:
 *   - use an isolated temp store per case,
 *   - feed a deterministic cached embedder (offline, repeatable),
 *   - force the associative field on or off per run.
 *
 * The ONLY thing here that is not shared with server.js is this ~40-line
 * orchestration. Keep it byte-faithful to server.js's recallMemory. The planned
 * follow-up (its own commit) is to extract a shared memory-core.js that both
 * server.js and this import, so they cannot drift - and THIS harness is the guard
 * that proves that extraction preserved behavior.
 */

const field = require("../field.js");
const { Ledger } = require("../ledger.js");
const { normalize, isHistoricalQuery } = require("../record.js");

// identical to server.js's cosine
function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function createMemory({ store, embed, fieldEnabled = false, ledgerPath }) {
  let _ledger = null;
  const getLedger = () => { if (!_ledger) _ledger = new Ledger(ledgerPath); return _ledger; };

  async function save(content) {
    content = (content || "").trim();
    if (!content) return "Nothing to save.";
    const now = new Date().toISOString();
    const same = store.current().find((r) => r.text === content);
    if (same) { store.update(same.id, { last_confirmed: now }); return "Already remembered."; }
    let embedding = null;
    try { embedding = (await embed([content]))[0]; } catch { embedding = null; }
    store.add(normalize({
      id: store.nextId(), created: now, modified: now, text: content,
      embedding, valid_from: now, valid_to: null, last_confirmed: now,
    }));
    return "Saved.";
  }

  async function recall(query, k = 5) {
    query = (query || "").trim();
    if (!query) return "";
    const historical = isHistoricalQuery(query);
    const mems = historical ? store.active() : store.current();
    if (!mems.length) return "";

    let ranked;
    try {
      const vectorless = mems.filter((m) => !m.embedding);
      const vecs = await embed([query, ...vectorless.map((m) => m.text)]);
      const qv = vecs[0];
      const fresh = new Map();
      vectorless.forEach((m, i) => fresh.set(String(m.id), vecs[i + 1]));
      ranked = mems
        .map((m) => ({ m, s: cosine(qv, m.embedding || fresh.get(String(m.id))) }))
        .sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.m);
      store.applyRecall(ranked.map((m) => m.id), fresh);
    } catch {
      // The cached embedder is deterministic and offline, so this path is not
      // expected in eval; kept for parity with server.js's keyword fallback.
      ranked = mems.slice(0, k);
      store.applyRecall(ranked.map((m) => m.id), null);
    }

    let out = ranked.map((m, i) =>
      (i + 1) + ". [id " + m.id + "] " + m.text +
      (m.valid_to ? "  (no longer current - superseded " + m.valid_to.slice(0, 10) + ")" : "")
    ).join("\n");

    if (fieldEnabled && mems.length > ranked.length) {
      try {
        const L = getLedger();
        const bonus = (a, b) => L.bonus(a, b);
        const edges = field.buildEdges(mems, { k: 2, minSim: 0.55, bonus });
        const rel = field.neighborhood(edges, ranked.map((m) => m.id), { hops: 1, max: 4 });
        if (rel.length) {
          const byId = new Map(mems.map((m) => [String(m.id), m]));
          out += "\n\nRelated:\n" + rel.map((e) => "- [id " + e.id + "] " + byId.get(String(e.id)).text).join("\n");
        }
        L.reinforceRecall(ranked.map((m) => m.id), rel.map((e) => e.id));
        L.tick();
        L.save();
      } catch { /* the field is additive; never let it break recall */ }
    }
    return out;
  }

  return { save, recall };
}

module.exports = { createMemory, cosine };
