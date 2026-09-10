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
 * Lane C — edge-binding density / reachability.
 *
 * NOT the golden gate. Measures whether spread activation can REACH the
 * weak-recall target at all (a necessary condition for any combiner to
 * then lift it). Reproduce:
 *
 *   node eval/edge-density.js
 *   node eval/edge-density.js --json
 *
 * Offline + deterministic (embeddings.cache.json). Flag-off product
 * behaviour is unchanged; this file only reads the store the save path
 * already builds, then overlays hypothetical graphs in-process.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { JsonlStore } = require("../store.js");
const { createMemory, cosine } = require("./pipeline.js");
const { embed } = require("./embed-cache.js");
const { loadScenarios } = require("./measure.js");
const {
  bindSaveTimeNeighbors, SAVE_TIME_K, SAVE_TIME_MIN_COS,
  recallTimeNeighborMap, unionAdjacency, activationRankBonus,
} = require("../memory-core.js");
const { WarmField, activationEdgesFromStore, FLOOR, MAX_HOPS, WARM_EDGE_CAP } =
  require("../warm.js");
const { SEMANTIC_PRUNE_GATE } = require("../edges.js");
const field = require("../field.js");

const CORPORA = path.join(__dirname, "corpora");
const SEED_K = 15;          // K_SEARCH — same seed radius as the activation A/B
const RETURN_K = 5;
const HOPS = MAX_HOPS;      // 2

const FILES = [
  "field-stress.jsonl",
  "field-noise.jsonl",
  "adversarial.jsonl",
  "constraints.jsonl",
];

function fmt(x, d) {
  if (x == null || Number.isNaN(x)) return "n/a";
  if (typeof x === "boolean") return x ? "Y" : "n";
  if (typeof x !== "number") return String(x);
  return x.toFixed(d == null ? 3 : d);
}

function pct(n, d) {
  if (!d) return "n/a";
  return (100 * n / d).toFixed(0) + "%";
}

function textHas(text, needle) {
  return String(text || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function idsMatching(mems, needles) {
  if (!needles || !needles.length) return [];
  return (mems || []).filter((m) => needles.some((n) => textHas(m.text, n))).map((m) => String(m.id));
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-edense-"));
  const file = path.join(dir, "store.jsonl");
  return { store: new JsonlStore(file), file, dir };
}

function persistAdj(edgeStore, mems) {
  return activationEdgesFromStore(edgeStore, mems, { now: Date.now() });
}

function bfs(adj, seeds, hops) {
  const seedSet = new Set([...seeds].map(String));
  const dist = new Map();
  for (const s of seedSet) dist.set(s, 0);
  let frontier = [...seedSet];
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const id of frontier) {
      for (const n of adj.get(id) || []) {
        const k = String(n.id);
        if (dist.has(k)) continue;
        dist.set(k, h + 1);
        next.push(k);
      }
    }
    frontier = next;
  }
  return dist;
}

function degreeOf(adj, id) {
  const nbrs = adj.get(String(id)) || [];
  const seen = new Set(nbrs.map((n) => String(n.id)));
  return seen.size;
}

function edgeStats(adj, nNodes) {
  let directed = 0;
  const undirected = new Set();
  let maxDeg = 0;
  for (const [from, nbrs] of adj) {
    const deg = new Set((nbrs || []).map((n) => String(n.id))).size;
    if (deg > maxDeg) maxDeg = deg;
    for (const n of nbrs || []) {
      directed++;
      const a = String(from);
      const b = String(n.id);
      undirected.add(a < b ? a + "\t" + b : b + "\t" + a);
    }
  }
  const unique = undirected.size;
  return {
    unique,
    directed,
    maxDeg,
    meanDeg: nNodes ? (2 * unique) / nNodes : 0,
  };
}

function spreadOn(adj, hits, mems) {
  const W = new WarmField({ now: () => 1_000_000 });
  W.seedFromRetrieval(hits);
  W.spread(adj, { live: (mems || []).map((m) => String(m.id)) });
  return W;
}

async function populate(scenario, persist) {
  const { store, file, dir } = freshStore();
  const mem = createMemory({
    store, embed, fieldEnabled: false, edgesPath: file + ".edges.json",
    saveTimeK: persist.k, saveTimeMinCos: persist.minCos,
  });
  for (const w of scenario.writes || []) {
    const text = typeof w === "string" ? w : w.text;
    await mem.save(text);
  }
  if (persist.rebindAll) {
    const L = mem.getEdgeStore();
    const mems = store.current();
    for (const rec of mems) {
      bindSaveTimeNeighbors(rec, mems, L, { k: persist.k, minCos: persist.minCos });
    }
  }
  return { store, file, dir, mem, edges: mem.getEdgeStore() };
}

function overlayAdj(baseAdj, mems, overlay) {
  if (!overlay || overlay.kind === "persist") return baseAdj;
  if (overlay.kind === "recall-seeds") {
    const ephemeral = recallTimeNeighborMap(mems, {
      k: overlay.k, minCos: overlay.minCos, seeds: overlay.seeds,
    });
    return overlay.union === false ? ephemeral : unionAdjacency(baseAdj, ephemeral);
  }
  if (overlay.kind === "recall-all") {
    const ephemeral = recallTimeNeighborMap(mems, {
      k: overlay.k, minCos: overlay.minCos,
    });
    return overlay.union === false ? ephemeral : unionAdjacency(baseAdj, ephemeral);
  }
  return baseAdj;
}

function analyzeQuery(scenario, q, mems, baseAdj, edgeStore, overlay) {
  const qv = q._qv;
  const scored = mems
    .map((m) => ({ m, s: cosine(qv, m.embedding) }))
    .sort((a, b) => b.s - a.s);
  const seeds = scored.slice(0, SEED_K);
  const seedIds = seeds.map((x) => String(x.m.id));
  const returned = scored.slice(0, RETURN_K).map((x) => String(x.m.id));
  const adj = overlayAdj(baseAdj, mems, Object.assign({}, overlay, { seeds: seedIds }));
  const dist = bfs(adj, seedIds, HOPS);
  const hits = seeds.map((x) => ({ id: x.m.id, similarity: x.s }));
  const W = spreadOn(adj, hits, mems);

  const contains = (q.contains && q.contains.length)
    ? q.contains
    : ((scenario.expect && scenario.expect.contains) || []);
  const excludes = (q.excludes && q.excludes.length)
    ? q.excludes
    : ((scenario.expect && scenario.expect.excludes) || []);

  function probe(needles, role) {
    const ids = idsMatching(mems, needles);
    return ids.map((id) => {
      const rec = mems.find((m) => String(m.id) === id);
      const row = scored.find((x) => String(x.m.id) === id);
      const rank = row ? scored.indexOf(row) + 1 : null;
      const sim = row ? row.s : 0;
      const inReturn = returned.includes(id);
      const inSeeds = seedIds.includes(id);
      const hops = dist.has(id) ? dist.get(id) : null;
      const graphReach = hops != null && (inSeeds || hops > 0 || hops === 0);
      const E = W.get(id);
      const bonus = activationRankBonus(W, id);
      const deg = degreeOf(baseAdj, id);
      const persistNbrs = (baseAdj.get(id) || []).map((n) => {
        const other = mems.find((m) => String(m.id) === String(n.id));
        return {
          text: other ? other.text.slice(0, 48) : n.id,
          sim: n.sim,
        };
      });
      const pair = mems
        .filter((m) => String(m.id) !== id && m.embedding)
        .map((m) => ({
          id: String(m.id),
          text: m.text,
          cos: cosine(rec.embedding, m.embedding),
          seedRank: seedIds.indexOf(String(m.id)) + 1 || null,
        }))
        .sort((a, b) => b.cos - a.cos);
      return {
        role, id, text: rec ? rec.text : "?",
        rank, sim, inReturn, inSeeds,
        hops: hops, graphReach: !!graphReach && hops != null,
        E, bonus, deg, persistNbrs: persistNbrs.slice(0, 8),
        topPairs: pair.slice(0, 6).map((p) => ({
          cos: p.cos, seedRank: p.seedRank, text: p.text.slice(0, 48),
        })),
        aboveFloor: pair.filter((p) => p.cos >= SAVE_TIME_MIN_COS).length,
        above015: pair.filter((p) => p.cos >= 0.15).length,
        above045: pair.filter((p) => p.cos >= 0.45).length,
        maxPair: pair[0] ? pair[0].cos : 0,
        maxSeedPair: pair.filter((p) => p.seedRank).reduce((m, p) => Math.max(m, p.cos), 0),
      };
    });
  }

  const targets = probe(contains, "target");
  const leaks = probe(excludes, "exclude");

  // Constraint-rescue oracle (field.js, not the edge table).
  const cres = field.reachableConstraints(mems, seedIds, {
    gate: 0.45, k: 2, max: 8, exclude: returned,
  });
  const rescueIds = new Set(cres.map((e) => String(e.id)));

  return {
    query: q.query,
    n: mems.length,
    nSeeds: seedIds.length,
    targets, leaks,
    rescueHits: targets.filter((t) => rescueIds.has(t.id)).map((t) => t.id),
    stats: edgeStats(adj, mems.length),
    persistStats: edgeStats(baseAdj, mems.length),
  };
}

async function embedQuery(q) {
  const v = await embed([q.query]);
  q._qv = v[0];
}

const PERSIST_ARMS = [
  { id: "K5/0.25", k: 5, minCos: 0.25, rebindAll: false },
  { id: "K10/0.25", k: 10, minCos: 0.25, rebindAll: false },
  { id: "K15/0.25", k: 15, minCos: 0.25, rebindAll: false },
  { id: "K5/0.20", k: 5, minCos: 0.20, rebindAll: false },
  { id: "K5/0.15", k: 5, minCos: 0.15, rebindAll: false },
  { id: "K15/0.15", k: 15, minCos: 0.15, rebindAll: false },
  { id: "K5/0.25+rebind", k: 5, minCos: 0.25, rebindAll: true },
];

function overlayArms() {
  return [
    { id: "persist", kind: "persist" },
    { id: "∪recall K5/0.25", kind: "recall-seeds", k: 5, minCos: 0.25 },
    { id: "∪recall K15/0.25", kind: "recall-seeds", k: 15, minCos: 0.25 },
    { id: "∪recall K5/0.15", kind: "recall-seeds", k: 5, minCos: 0.15 },
    { id: "∪recall K15/0.15", kind: "recall-seeds", k: 15, minCos: 0.15 },
    { id: "∪recall K2/0.45", kind: "recall-seeds", k: 2, minCos: 0.45 },
    { id: "recall-only K15/0.25", kind: "recall-seeds", k: 15, minCos: 0.25, union: false },
    { id: "∪all-kNN K5/0.25", kind: "recall-all", k: 5, minCos: 0.25 },
  ];
}

function targetSummary(t) {
  if (!t) return "no-target";
  const hop = t.hops == null ? "∞" : String(t.hops);
  return "rank " + t.rank +
    (t.inReturn ? " RET" : t.inSeeds ? " seed" : "") +
    " hops=" + hop +
    " E=" + fmt(t.E, 3) +
    " bonus=" + fmt(t.bonus, 3) +
    " deg=" + t.deg +
    " maxPair=" + fmt(t.maxPair, 3) +
    " maxSeed=" + fmt(t.maxSeedPair, 3);
}

async function runCorpus() {
  const scenarios = [];
  for (const fn of FILES) {
    const loaded = loadScenarios(path.join(CORPORA, fn));
    for (const s of loaded) {
      const queries = (s.queries || []).map((q) => ({
        query: q.query,
        contains: q.contains || (s.expect && s.expect.contains) || [],
        excludes: q.excludes || (s.expect && s.expect.excludes) || [],
      }));
      // loadScenarios already folded expect.contains into queriesFromCase
      scenarios.push({
        file: fn, id: s.id, writes: s.writes, queries, kind: s.kind,
      });
    }
  }

  for (const s of scenarios) {
    for (const q of s.queries) await embedQuery(q);
  }

  const byArm = [];
  // Persist arms: full save each time. Overlay arms run on K5/0.25 persist.
  for (const persist of PERSIST_ARMS) {
    const rows = [];
    for (const s of scenarios) {
      const pop = await populate(s, persist);
      const mems = pop.store.current();
      const adj = persistAdj(pop.edges, mems);
      const stats = edgeStats(adj, mems.length);
      for (const q of s.queries) {
        const a = analyzeQuery(s, q, mems, adj, pop.edges, { kind: "persist" });
        rows.push({
          id: s.id, file: s.file, persist: persist.id,
          overlay: "persist", n: mems.length, stats, pruned: 0,
          targets: a.targets, leaks: a.leaks, rescueHits: a.rescueHits,
        });
      }
      // I8: a persist floor below SEMANTIC_PRUNE_GATE is born already
      // dead — pruneSweep marks the new edges and they drop out of
      // incident()/spread. Measure coverage AFTER that sweep.
      if (persist.minCos < SEMANTIC_PRUNE_GATE) {
        const pruned = pop.edges.pruneSweep();
        const adjAfter = persistAdj(pop.edges, mems);
        const statsAfter = edgeStats(adjAfter, mems.length);
        for (const q of s.queries) {
          const a = analyzeQuery(s, q, mems, adjAfter, pop.edges, { kind: "persist" });
          rows.push({
            id: s.id, file: s.file, persist: persist.id + "+pruned",
            overlay: "persist", n: mems.length, stats: statsAfter, pruned,
            targets: a.targets, leaks: a.leaks, rescueHits: a.rescueHits,
          });
        }
      }
      try { fs.rmSync(pop.dir, { recursive: true, force: true }); } catch { /* tmp */ }
    }
    byArm.push({ persist: persist.id, overlay: "persist", rows });
  }

  // Overlays on the default persist (K=5 / 0.25), one populate per scenario.
  const overlayRows = [];
  for (const s of scenarios) {
    const pop = await populate(s, { k: SAVE_TIME_K, minCos: SAVE_TIME_MIN_COS, rebindAll: false });
    const mems = pop.store.current();
    const adj = persistAdj(pop.edges, mems);
    for (const ov of overlayArms()) {
      for (const q of s.queries) {
        const a = analyzeQuery(s, q, mems, adj, pop.edges, ov);
        overlayRows.push({
          id: s.id, file: s.file, persist: "K5/0.25", overlay: ov.id,
          n: mems.length, stats: a.stats, persistStats: a.persistStats,
          targets: a.targets, leaks: a.leaks, rescueHits: a.rescueHits,
        });
      }
    }
    try { fs.rmSync(pop.dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
  return { scenarios, persist: byArm, overlays: overlayRows };
}

function isRescue(row) {
  return String(row.id).startsWith("field-rescue");
}

function isTbr(row) {
  return String(row.file).indexOf("adversarial") >= 0 || String(row.file).indexOf("field-noise") >= 0;
}

function coverage(rows, pred) {
  let n = 0, hit = 0, act = 0, seed = 0, ret = 0, missGraph = 0;
  const details = [];
  for (const r of rows) {
    if (!pred(r)) continue;
    for (const t of r.targets || []) {
      n++;
      if (t.inReturn) ret++;
      if (t.inSeeds) seed++;
      if (t.graphReach) hit++;
      if (t.E > FLOOR) act++;
      if (!t.graphReach) missGraph++;
      details.push({ id: r.id, overlay: r.overlay, persist: r.persist, t });
    }
  }
  return { n, graph: hit, act, seed, ret, missGraph, details };
}

function leakCount(rows, pred) {
  let n = 0, graph = 0, act = 0;
  for (const r of rows) {
    if (!pred(r)) continue;
    for (const t of r.leaks || []) {
      n++;
      if (t.graphReach && !t.inReturn) graph++;
      if (t.E > FLOOR && !t.inReturn) act++;
    }
  }
  return { n, graph, act };
}

function printTargetTable(rows, title) {
  console.log("\n" + title);
  console.log("-".repeat(88));
  for (const r of rows) {
    const t = (r.targets || [])[0];
    if (!t) continue;
    console.log("  " + (r.persist || "") + (r.overlay && r.overlay !== "persist" ? " " + r.overlay : "") +
      "  " + r.id);
    console.log("      " + targetSummary(t));
    if (t.topPairs && t.topPairs.length) {
      console.log("      pairs: " + t.topPairs.map((p) =>
        fmt(p.cos, 3) + (p.seedRank ? "@s" + p.seedRank : "") + " " + p.text
      ).join(" | "));
    }
    if (t.persistNbrs && t.persistNbrs.length) {
      console.log("      persist nbrs: " + t.persistNbrs.map((p) =>
        fmt(p.sim, 3) + " " + p.text
      ).join(" | "));
    } else if (t.deg === 0) {
      console.log("      persist nbrs: (none)");
    }
  }
}

function printCoverageLine(label, c, leaks) {
  const leakStr = leaks && leaks.n
    ? "  leak-graph " + leaks.graph + "/" + leaks.n + "  leak-E " + leaks.act + "/" + leaks.n
    : "";
  console.log("  " + label.padEnd(28) +
    " graph " + c.graph + "/" + c.n +
    " (" + pct(c.graph, c.n) + ")" +
    "  E>floor " + c.act + "/" + c.n +
    "  seed " + c.seed + "/" + c.n +
    "  ret " + c.ret + "/" + c.n +
    leakStr);
}

async function costProbe() {
  // Sequential save-time bind over the UNION of the measured corpora so
  // density is real nomic geometry, not random 768-d (those never clear 0.25).
  const texts = [];
  const seen = new Set();
  for (const fn of FILES) {
    for (const s of loadScenarios(path.join(CORPORA, fn))) {
      for (const w of s.writes || []) {
        const t = typeof w === "string" ? w : w.text;
        if (t && !seen.has(t)) { seen.add(t); texts.push(t); }
      }
    }
  }
  const vecs = await embed(texts);
  const mems = texts.map((t, i) => ({
    id: String(i + 1), text: t, embedding: vecs[i], embedding_version: 1,
  }));
  const out = [];
  for (const k of [5, 10, 15]) {
    for (const minCos of [0.25, 0.15]) {
      const { EdgeStore } = require("../edges.js");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-edense-cost-"));
      const store = new EdgeStore(path.join(dir, "e.json"));
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < mems.length; i++) {
        bindSaveTimeNeighbors(mems[i], mems.slice(0, i), store, { k, minCos });
      }
      const t1 = process.hrtime.bigint();
      const adj = persistAdj(store, mems);
      const stats = edgeStats(adj, mems.length);
      const pruned = minCos < SEMANTIC_PRUNE_GATE ? store.pruneSweep() : 0;
      out.push({
        n: mems.length, k, minCos, ms: Number(t1 - t0) / 1e6,
        unique: stats.unique, meanDeg: stats.meanDeg, maxDeg: stats.maxDeg, pruned,
      });
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
    }
  }

  // Recall-time seed-kNN cost: 15 sources × N on this corpus, then scale note.
  const seeds = mems.slice(0, SEED_K).map((m) => m.id);
  const t2 = process.hrtime.bigint();
  recallTimeNeighborMap(mems, { k: 5, minCos: 0.25, seeds });
  const t3 = process.hrtime.bigint();
  const recallMs = Number(t3 - t2) / 1e6;

  return { sequential: out, recallSeedMs: recallMs, n: mems.length, seedK: SEED_K };
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const json = args.includes("--json");
  const line = "=".repeat(88);
  console.log("\nEdge-binding density / reachability  (Lane C; exploratory; not the golden)");
  console.log("seed radius K_SEARCH=" + SEED_K + "  hops=" + HOPS +
    "  floor=" + FLOOR + "  WARM_EDGE_CAP=" + WARM_EDGE_CAP);
  console.log("coverage = target is graph-reachable from the query's seeds in ≤" +
    HOPS + " hops (incl. being a seed).");
  console.log("reproduce: node eval/edge-density.js");
  console.log(line);

  const result = await runCorpus();
  const cost = await costProbe();

  // --- status-quo detail on the three rescue leaves ---
  const base = result.persist.find((a) => a.persist === "K5/0.25");
  printTargetTable((base.rows || []).filter(isRescue),
    "STATUS QUO  persist K=5 minCos=0.25  — field-rescue leaves");
  printTargetTable((base.rows || []).filter(isTbr),
    "STATUS QUO  TBR / noise — contains (the intended hit)");
  console.log("\nSTATUS QUO  TBR / noise — excludes (activation-in-rank leak risk)");
  console.log("-".repeat(88));
  for (const r of (base.rows || []).filter(isTbr)) {
    for (const t of r.leaks || []) {
      console.log("  " + r.id + "  EXCLUDE " + targetSummary(t));
      console.log("      " + (t.text || "").slice(0, 72));
    }
    if (!(r.leaks || []).length) console.log("  " + r.id + "  (no exclude matched a stored row)");
  }

  console.log("\nSTATUS QUO coverage");
  printCoverageLine("rescue leaves",
    coverage(base.rows, isRescue), leakCount(base.rows, isRescue));
  printCoverageLine("all associative",
    coverage(base.rows, () => true), leakCount(base.rows, isTbr));
  printCoverageLine("TBR/noise excludes",
    { n: 0, graph: 0, act: 0, seed: 0, ret: 0 }, leakCount(base.rows, isTbr));

  // Why vegetarian/heights miss: dump the three leaves even if n is small.
  console.log("\nLEAF DIAGNOSIS (status quo)");
  for (const r of (base.rows || []).filter(isRescue)) {
    const t = r.targets[0];
    if (!t) continue;
    const why = [];
    if (t.inReturn) why.push("already in top-" + RETURN_K + " (coverage vacuous)");
    else if (t.inSeeds) why.push("in seed pool (rank " + t.rank + ") — combiner zeros seed energy; surplus needs incoming E > sim");
    if (t.deg === 0) why.push("DEGREE 0 in persist table (save-time bind never wired it)");
    if (!t.graphReach) why.push("no path from seeds in ≤" + HOPS + " hops");
    if (t.graphReach && t.E <= FLOOR) why.push("path exists but E=" + fmt(t.E, 3) + " ≤ floor " + FLOOR);
    if (t.maxPair < SAVE_TIME_MIN_COS) why.push("max pairwise cosine " + fmt(t.maxPair, 3) + " < save floor 0.25 — K cannot help, only a lower floor or recall-time bind");
    if (t.maxPair >= SAVE_TIME_MIN_COS && t.deg === 0) why.push("a pair clears 0.25 but save-order K dropped it");
    if (t.maxSeedPair >= 0.45 && t.deg === 0) why.push("constraint-rescue would fire (seed pair ≥0.45) on a DIFFERENT graph");
    console.log("  " + r.id + "  " + why.join("; "));
  }

  console.log("\n" + line);
  console.log("PERSIST ARMS  (save-time K / floor; overlay=persist)");
  const persistLabels = [];
  for (const arm of result.persist) {
    persistLabels.push(arm.persist);
    const prunedRows = (arm.rows || []).filter((r) => String(r.persist).endsWith("+pruned"));
    const liveRows = (arm.rows || []).filter((r) => !String(r.persist).endsWith("+pruned"));
    printCoverageLine(arm.persist, coverage(liveRows, isRescue), leakCount(liveRows, isTbr));
    if (prunedRows.length) {
      printCoverageLine(arm.persist + "+pruned",
        coverage(prunedRows, isRescue), leakCount(prunedRows, isTbr));
    }
  }
  // Rescue-leaf per-arm detail
  for (const arm of result.persist) {
    const rescue = (arm.rows || []).filter((r) => isRescue(r) && !String(r.persist).endsWith("+pruned"));
    if (!rescue.length) continue;
    console.log("    " + arm.persist + " leaves: " + rescue.map((r) => {
      const t = r.targets[0];
      return r.id.replace("field-rescue", "fr") +
        "(h=" + (t && t.hops == null ? "∞" : t && t.hops) +
        " E=" + fmt(t && t.E, 2) + " deg=" + (t && t.deg) + ")";
    }).join("  "));
  }

  console.log("\nOVERLAY ARMS  (on persist K=5/0.25)");
  const ovIds = overlayArms().map((o) => o.id);
  for (const id of ovIds) {
    const rows = result.overlays.filter((r) => r.overlay === id);
    printCoverageLine(id, coverage(rows, isRescue), leakCount(rows, isTbr));
  }
  for (const id of ovIds) {
    const rescue = result.overlays.filter((r) => r.overlay === id && isRescue(r));
    console.log("    " + id + " leaves: " + rescue.map((r) => {
      const t = r.targets[0];
      return r.id.replace("field-rescue", "fr") +
        "(h=" + (t && t.hops == null ? "∞" : t && t.hops) +
        " E=" + fmt(t && t.E, 2) + ")";
    }).join("  "));
  }

  console.log("\n" + line);
  console.log("COST  sequential bind over union of measured corpora (n=" + cost.n +
    ", real nomic vectors)");
  console.log("| K | minCos | unique edges | mean deg | max deg | pruned (I8) | total ms |");
  for (const r of cost.sequential) {
    console.log("| " + r.k + " | " + r.minCos.toFixed(2) + " | " + r.unique +
      " | " + r.meanDeg.toFixed(2) + " | " + r.maxDeg + " | " + r.pruned +
      " | " + r.ms.toFixed(1) + " |");
  }
  console.log("recall-time seed-kNN (" + cost.seedK + " × " + cost.n + ")  " +
    cost.recallSeedMs.toFixed(2) + " ms on this corpus.");
  console.log("Scan cost is O(N) regardless of K (Phase 0.1: p95 77.1 ms at N=100k).");
  console.log("K only changes how many of those neighbors are WRITTEN.");
  console.log("WARM_EDGE_CAP=" + WARM_EDGE_CAP +
    " already skips spread when the store has more vectors than that — denser");
  console.log("persist does not help activation at S1 scale unless the cap is raised.");

  const k5 = cost.sequential.find((r) => r.k === 5 && r.minCos === 0.25);
  const k15 = cost.sequential.find((r) => r.k === 15 && r.minCos === 0.25);
  if (k5 && k15 && k5.unique) {
    const ratio = k15.unique / k5.unique;
    console.log("On this union, K=15/K=5 unique-edge ratio = " + ratio.toFixed(2) +
      ". Extrapolating Phase 0.1's ~2.5 unique/node at K=5, 100k → ~" +
      Math.round(2.5 * ratio) + " unique/node, ~" +
      Math.round(250000 * ratio) + " edges.");
  }

  if (json) {
    console.log("\n" + JSON.stringify({
      generated: new Date().toISOString(),
      seedK: SEED_K, hops: HOPS, floor: FLOOR, cap: WARM_EDGE_CAP,
      persist: result.persist.map((a) => ({
        persist: a.persist,
        coverage: coverage(a.rows, isRescue),
        leaks: leakCount(a.rows, isTbr),
        rescue: (a.rows || []).filter(isRescue).map((r) => ({
          id: r.id, targets: r.targets, leaks: r.leaks, stats: r.stats, pruned: r.pruned,
        })),
      })),
      overlays: ovIds.map((id) => {
        const rows = result.overlays.filter((r) => r.overlay === id);
        return {
          overlay: id,
          coverage: coverage(rows, isRescue),
          leaks: leakCount(rows, isTbr),
          rescue: rows.filter(isRescue).map((r) => ({ id: r.id, targets: r.targets })),
        };
      }),
      cost,
    }, null, 2));
  }

  console.log("\n" + line + "\n");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack || e);
    process.exit(2);
  });
}

module.exports = { bfs, overlayAdj, persistAdj, edgeStats };
