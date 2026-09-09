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
 * Combiner-shape research (Lane B). Exploratory; not the golden, not the
 * 2.2 promotion. The question: is additive fusion the reason activation-
 * in-rank flatlined, and does a different shape lift an apex/weak-recall
 * target without promoting hubs — at a weight that does not nuke cosine?
 *
 *   node eval/combiner-research.js
 *   node eval/combiner-research.js --json
 *
 * Offline + deterministic (embeddings.cache.json). Flag-off default is
 * untouched; this file only *reads* the live recall path with warmRank
 * on for the constructed case, and applies fuseScoredWithActivation as a
 * pure function on a frozen (cosine, activation, edges) snapshot for
 * the corpora — so shapes share one graph.
 *
 * Discriminating test is apex-in-top-k vs hub-in-top-k, not recall@k.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { JsonlStore } = require("../store.js");
const { openEdgeStore } = require("../edges.js");
const {
  createCore, cosine, fuseScoredWithActivation, FUSE_SHAPES, K_SEARCH,
  WARM_RANK_WEIGHT, RRF_K, activationRankBonus, competitiveL1,
  competitiveRankNorm, neighborGraph,
} = require("../memory-core.js");
const { WarmField, activationEdgesFromStore } = require("../warm.js");
const { embed } = require("./embed-cache.js");
const { parsePrimaryHits } = require("./metrics.js");

const CORPORA = path.join(__dirname, "corpora");
const CORPUS_CASES = [
  {
    file: "field-stress.jsonl",
    id: "field-rescue",
    apex: /diabetic/i,
    hubs: [/casual dress/i, /carpool with Dana/i, /Parking is tight/i, /office coffee/i],
  },
  {
    file: "field-stress.jsonl",
    id: "field-rescue-veg",
    apex: /vegetarian/i,
    hubs: [/ribeye/i, /pot roast/i, /barbecue brisket/i, /Roast chicken/i],
  },
  {
    file: "field-stress.jsonl",
    id: "field-rescue-heights",
    apex: /terrified of heights/i,
    hubs: [/happy hour starts at six/i, /Parking downtown/i, /brewery has live music/i],
  },
  {
    file: "adversarial.jsonl",
    id: "adv-height-homonym",
    apex: /terrified of heights/i,   // MUST stay out (TBR)
    hubs: [/six feet/i],             // the right answer is the "hub" here
    inverted: true,                  // success = apex OUT, right-answer IN
    right: /six feet/i,
  },
  {
    file: "adversarial.jsonl",
    id: "adv-offtopic-quiet",
    apex: /allergic to shellfish/i,  // MUST stay out
    hubs: [/five thousand/i],
    inverted: true,
    right: /five thousand/i,
  },
];

const WEIGHTS = [0.3, 1.0];
const RRF_KS = [1, 10, 60];
const SHAPES = FUSE_SHAPES.slice();

const APEX_TEXT = "I'm diabetic, so no sugary desserts for me";
const HUB_TEXT = "Fridays are casual dress at the office";
const BRIDGE_TEXT = "I always bring lemon bars to the potluck";
const CLUSTER_SEED_TEXT = "The potluck signup sheet is on the fridge";
const QUERY_TEXT = "what should I bring to the potluck on Friday";

function unitAt(cosineVal, dim, dims) {
  const v = new Array(dims).fill(0);
  const c = Number(cosineVal);
  v[0] = c;
  // dim 0 is the query axis — writing the leftover there would zero a
  // unit query (c=1, rest=0) and make every cosine 0.
  if (dim !== 0) {
    v[dim] = Math.sqrt(Math.max(0, 1 - c * c));
  }
  return v;
}

function constructedPack() {
  // Query along dim 0. Each memory gets its own leftover dimension so
  // pairwise cosine is c_i·c_j (≪ DEDUP_LO) and RM-02.b will not merge.
  const items = [
    { text: BRIDGE_TEXT, c: 0.72, dim: 1, role: "bridge" },
    { text: CLUSTER_SEED_TEXT, c: 0.70, dim: 2, role: "cluster-seed" },
    { text: "We're short on chairs for the potluck", c: 0.68, dim: 3, role: "filler" },
    { text: "The potluck needs more savory dishes this time", c: 0.66, dim: 4, role: "filler" },
    { text: "I'm bringing my three-bean chili to the potluck", c: 0.64, dim: 5, role: "filler" },
    { text: HUB_TEXT, c: 0.48, dim: 6, role: "hub" },
    { text: "I carpool with Dana on Fridays", c: 0.40, dim: 7, role: "cluster" },
    { text: "Parking is tight at the office on Fridays", c: 0.40, dim: 8, role: "cluster" },
    { text: "Someone booked the big conference room for Friday", c: 0.40, dim: 9, role: "cluster" },
    { text: "The office coffee machine broke again", c: 0.40, dim: 10, role: "cluster" },
    { text: "I have a dentist appointment Friday morning", c: 0.40, dim: 11, role: "cluster" },
    { text: "The quarterly review is next Friday", c: 0.40, dim: 12, role: "cluster" },
    { text: "Our team lunch is usually on Fridays", c: 0.40, dim: 13, role: "cluster" },
    { text: APEX_TEXT, c: 0.25, dim: 14, role: "apex" },
    { text: "The elevator is slow during the Friday rush", c: 0.10, dim: 15, role: "noise" },
  ];
  const dims = 16;
  const pack = { [QUERY_TEXT]: unitAt(1, 0, dims) };
  for (const it of items) pack[it.text] = unitAt(it.c, it.dim, dims);
  return { items, pack, dims };
}

function chainUndirected(pairs) {
  const m = new Map();
  function add(a, b, sim) {
    a = String(a); b = String(b);
    if (!m.has(a)) m.set(a, []);
    m.get(a).push({ id: b, sim });
  }
  for (const [a, b, sim] of pairs) {
    add(a, b, sim);
    add(b, a, sim);
  }
  return m;
}

function freshStore(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-combiner-" + (tag || "x") + "-"));
  const file = path.join(dir, "store.jsonl");
  return { store: new JsonlStore(file), file, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}

function textMatch(text, spec) {
  if (!spec) return false;
  if (spec instanceof RegExp) return spec.test(text);
  return String(text).toLowerCase().indexOf(String(spec).toLowerCase()) >= 0;
}

function inTop(ranked, spec, k) {
  const n = k != null ? k : ranked.length;
  for (let i = 0; i < n && i < ranked.length; i++) {
    if (textMatch(ranked[i].text, spec)) return { hit: true, rank: i + 1, text: ranked[i].text };
  }
  return { hit: false, rank: null, text: null };
}

function rankedTexts(fused, k) {
  return (fused || []).slice(0, k).map((x) => ({
    id: String(x.m.id),
    text: x.m.text,
    cosine: x.s,
    bonus: x.bonus,
    signal: x.signal,
    final: x.final,
  }));
}

/*
 * Build the constructed store, inject the apex-vs-hub graph, snapshot
 * cosine + activation. Tests and the CLI share this so the numbers in
 * combiner-research.md cannot drift from the gate.
 *
 * Graph (why these edges): a cosine seed (lemon bars) 1-hops to the
 * isolated apex; a different cosine seed 1-hops into a 8-node Friday
 * cluster. Seed radius is 5, so hub + cluster + apex are NOT cosine
 * seeds and earn a surplus bonus. That is the A/B's w=1.0 failure
 * signature (hubs just outside top-k), isolated from save-time kNN.
 */
async function snapshotConstructed() {
  const { items, pack } = constructedPack();
  const embedFn = async (texts) => texts.map((t) => pack[t] || unitAt(0, 1, 16));
  const { store, dir } = freshStore("con");
  const setup = createCore({ store, embed: embedFn, warmEnabled: () => false, saveSeed: () => false });
  for (const it of items) await setup.save(it.text);
  const recs = store.current();
  const byText = new Map(recs.map((m) => [m.text, m]));
  const idOf = (t) => String(byText.get(t).id);
  const apexId = idOf(APEX_TEXT);
  const hubId = idOf(HUB_TEXT);
  const bridgeId = idOf(BRIDGE_TEXT);
  const seedId = idOf(CLUSTER_SEED_TEXT);
  const clusterIds = items.filter((it) => it.role === "cluster").map((it) => idOf(it.text));

  const pairs = [[bridgeId, apexId, 1.0], [seedId, hubId, 0.9]];
  for (const c of clusterIds) {
    pairs.push([seedId, c, 0.9]);
    pairs.push([hubId, c, 0.9]);
  }
  for (let i = 0; i < clusterIds.length; i++) {
    for (let j = i + 1; j < clusterIds.length; j++) {
      pairs.push([clusterIds[i], clusterIds[j], 0.9]);
    }
  }
  const edges = chainUndirected(pairs);

  const qv = pack[QUERY_TEXT];
  const scored = recs
    .map((m) => ({ m, s: cosine(qv, m.embedding) }))
    .sort((a, b) => b.s - a.s);
  const W = new WarmField({ hops: 2, now: () => 1_000_000, halfLife: 1e9 });
  W.seedFromRetrieval(scored.slice(0, 5).map((x) => ({ id: x.m.id, similarity: x.s })));
  W.spread(edges, { live: recs.map((m) => String(m.id)) });

  const snap = {
    kind: "constructed",
    query: QUERY_TEXT,
    k: 5,
    seedK: 5,
    scored,
    W,
    edges,
    apexId,
    hubId,
    recs,
    cosineOrder: scored.map((x, i) => ({
      rank: i + 1,
      id: String(x.m.id),
      text: x.m.text,
      cosine: x.s,
      bonus: activationRankBonus(W, x.m.id),
      activation: W.get(x.m.id),
    })),
  };
  snap.dir = dir;
  return snap;
}

function describeNode(snap, id) {
  const graph = neighborGraph(snap.edges);
  const bonusOf = (x) => activationRankBonus(snap.W, x);
  const row = snap.cosineOrder.find((r) => r.id === String(id));
  if (!row) return null;
  return Object.assign({}, row, {
    l1: competitiveL1(id, bonusOf, graph),
    ranknorm: competitiveRankNorm(id, bonusOf, graph),
    degree: (graph.get(String(id)) || []).length,
  });
}

function fuseSnapshot(snap, shape, weight, rrfK) {
  return fuseScoredWithActivation(snap.scored, snap.W, weight, {
    shape, rrfK: rrfK != null ? rrfK : RRF_K, edges: snap.edges,
  });
}

function apexHubOutcome(fused, snap, k) {
  const ranked = rankedTexts(fused, k);
  const apex = inTop(ranked, APEX_TEXT, k);
  const hub = inTop(ranked, HUB_TEXT, k);
  let verdict;
  if (apex.hit && !hub.hit) verdict = "apex";
  else if (hub.hit && !apex.hit) verdict = "hub";
  else if (apex.hit && hub.hit) verdict = apex.rank < hub.rank ? "both-apex-ahead" : "both-hub-ahead";
  else verdict = "neither";
  return { apex, hub, verdict, ranked };
}

async function recallConstructed(shape, weight, rrfK) {
  const { items, pack } = constructedPack();
  const embedFn = async (texts) => texts.map((t) => pack[t] || unitAt(0, 1, 16));
  const { store, dir } = freshStore("rec");
  const setup = createCore({ store, embed: embedFn, warmEnabled: () => false, saveSeed: () => false });
  for (const it of items) await setup.save(it.text);
  const recs = store.current();
  const byText = new Map(recs.map((m) => [m.text, m]));
  const idOf = (t) => String(byText.get(t).id);
  const pairs = [[idOf(BRIDGE_TEXT), idOf(APEX_TEXT), 1.0], [idOf(CLUSTER_SEED_TEXT), idOf(HUB_TEXT), 0.9]];
  const clusterIds = items.filter((it) => it.role === "cluster").map((it) => idOf(it.text));
  for (const c of clusterIds) {
    pairs.push([idOf(CLUSTER_SEED_TEXT), c, 0.9]);
    pairs.push([idOf(HUB_TEXT), c, 0.9]);
  }
  for (let i = 0; i < clusterIds.length; i++) {
    for (let j = i + 1; j < clusterIds.length; j++) pairs.push([clusterIds[i], clusterIds[j], 0.9]);
  }
  const edges = chainUndirected(pairs);
  const W = new WarmField({ hops: 2, now: () => 1_000_000, halfLife: 1e9 });
  const core = createCore({
    store, embed: embedFn,
    warmEnabled: () => true,
    warmRank: () => true,
    warmRankWeight: () => weight,
    warmRankShape: () => shape,
    warmRankRrfK: () => (rrfK != null ? rrfK : RRF_K),
    warmRankSeedK: () => 5,
    getWarm: () => W,
    getEdges: () => edges,
    saveSeed: () => false,
  });
  const out = await core.recall(QUERY_TEXT, 5);
  cleanup(dir);
  return { hits: parsePrimaryHits(out), output: out };
}

function loadCase(file, id) {
  const lines = fs.readFileSync(path.join(CORPORA, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const c = lines.find((x) => x.id === id);
  if (!c) throw new Error("missing corpus case " + id);
  return c;
}

async function snapshotCorpus(spec) {
  const c = loadCase(spec.file, spec.id);
  const { store, file, dir } = freshStore(spec.id);
  let _edges = null;
  const getEdgeStore = () => {
    if (!_edges) _edges = openEdgeStore({ store, file: file + ".edges.json" });
    return _edges;
  };
  const core = createCore({
    store, embed,
    fieldEnabled: () => false,
    getEdgeStore,
    warmEnabled: () => true,
    warmRank: () => false,
    saveSeed: () => false,
  });
  for (const w of c.writes) await core.save(w);
  const mems = store.current();
  const qv = (await embed([c.query], { role: "query" }))[0];
  const scored = mems
    .map((m) => ({ m, s: cosine(qv, m.embedding) }))
    .sort((a, b) => b.s - a.s);
  const W = new WarmField({ hops: 2, now: () => 1_000_000, halfLife: 1e9 });
  const seedK = K_SEARCH;
  W.seedFromRetrieval(scored.slice(0, seedK).map((x) => ({ id: x.m.id, similarity: x.s })));
  const edges = activationEdgesFromStore(getEdgeStore(), mems, { now: 1_000_000 });
  W.spread(edges, { live: mems.map((m) => String(m.id)) });

  const graph = neighborGraph(edges);
  const bonusOf = (id) => activationRankBonus(W, id);
  const cosineOrder = scored.map((x, i) => {
    const id = String(x.m.id);
    const bonus = bonusOf(id);
    return {
      rank: i + 1,
      id,
      text: x.m.text,
      cosine: x.s,
      activation: W.get(id),
      bonus,
      l1: competitiveL1(id, bonusOf, graph),
      ranknorm: competitiveRankNorm(id, bonusOf, graph),
      degree: (graph.get(id) || []).length,
      seed: i < seedK,
      is_constraint: !!x.m.is_constraint,
    };
  });

  function findSpec(rx) {
    return cosineOrder.find((r) => textMatch(r.text, rx)) || null;
  }

  cleanup(dir);
  return {
    kind: "corpus",
    id: spec.id,
    query: c.query,
    k: 5,
    seedK,
    scored,
    W,
    edges,
    cosineOrder,
    apex: findSpec(spec.apex),
    hubs: (spec.hubs || []).map(findSpec).filter(Boolean),
    right: spec.right ? findSpec(spec.right) : null,
    inverted: !!spec.inverted,
    n: mems.length,
  };
}

function corpusOutcome(fused, snap, k) {
  const ranked = rankedTexts(fused, k);
  const apexHit = snap.apex ? inTop(ranked, snap.apex.text, k) : { hit: false, rank: null };
  const hubHits = (snap.hubs || []).map((h) => inTop(ranked, h.text, k)).filter((h) => h.hit);
  const rightHit = snap.right ? inTop(ranked, snap.right.text, k) : null;
  let verdict;
  if (snap.inverted) {
    // Adversarial: the "apex" is a constraint that must stay OUT.
    if (apexHit.hit) verdict = "poison-in";
    else if (rightHit && rightHit.hit) verdict = "clean";
    else verdict = "right-miss";
  } else if (apexHit.hit && hubHits.length === 0) verdict = "apex";
  else if (!apexHit.hit && hubHits.length) verdict = "hub";
  else if (apexHit.hit && hubHits.length) {
    const bestHub = Math.min.apply(null, hubHits.map((h) => h.rank));
    verdict = apexHit.rank < bestHub ? "both-apex-ahead" : "both-hub-ahead";
  } else verdict = "neither";
  return { apex: apexHit, hubs: hubHits, right: rightHit, verdict, ranked };
}

function fmt(x, n) {
  if (x == null || Number.isNaN(x)) return "n/a";
  return Number(x).toFixed(n == null ? 4 : n);
}

function printNode(label, row) {
  if (!row) {
    console.log("    " + label + ": (not in store)");
    return;
  }
  console.log("    " + label +
    "  cos-rank " + row.rank +
    "  cos " + fmt(row.cosine) +
    "  E " + fmt(row.activation) +
    "  bonus " + fmt(row.bonus) +
    "  l1 " + fmt(row.l1) +
    "  ranknorm " + fmt(row.ranknorm) +
    "  deg " + row.degree +
    (row.seed ? "  SEED" : "") +
    (row.is_constraint ? "  constraint" : ""));
  console.log("      " + JSON.stringify(row.text).slice(0, 88));
}

function printOutcome(label, o) {
  const apexBit = o.apex && o.apex.hit ? "apex@" + o.apex.rank : "apex-out";
  const hubBit = o.hub && o.hub.hit ? "hub@" + o.hub.rank
    : (o.hubs && o.hubs.length ? "hub@" + o.hubs.map((h) => h.rank).join(",") : "hub-out");
  console.log("    " + label.padEnd(28) + "  " + String(o.verdict).padEnd(18) + "  " + apexBit + "  " + hubBit);
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const json = args.includes("--json");
  const line = "-".repeat(78);

  console.log("\nCombiner-shape research  (exploratory; flag-off default; not the 2.2 gate)");
  console.log("shapes: " + SHAPES.join(", "));
  console.log("weights (declared, not a search): " + WEIGHTS.join(", ") +
    "   rrf k: " + RRF_KS.join(", ") + "   locked w=" + WARM_RANK_WEIGHT);
  console.log("reproduce: node eval/combiner-research.js");
  console.log(line);

  const constructed = await snapshotConstructed();
  const apexInfo = describeNode(constructed, constructed.apexId);
  const hubInfo = describeNode(constructed, constructed.hubId);
  console.log("\nCONSTRUCTED apex-vs-hub  (injected graph; seedK=5, k=5)");
  console.log("  cosine top-5 cutoff = " + fmt(constructed.cosineOrder[4].cosine) +
    "  (" + constructed.cosineOrder[4].text.slice(0, 40) + ")");
  printNode("APEX", apexInfo);
  printNode("HUB ", hubInfo);

  const constructedTable = [];
  console.log("  outcomes:");
  for (const shape of SHAPES) {
    const ks = shape === "rrf" ? RRF_KS : [RRF_K];
    for (const rrfK of ks) {
      for (const w of WEIGHTS) {
        const fused = fuseSnapshot(constructed, shape, w, rrfK);
        const o = apexHubOutcome(fused, constructed, 5);
        const label = shape === "rrf" ? ("rrf k=" + rrfK + " w=" + w) : (shape + " w=" + w);
        printOutcome(label, o);
        constructedTable.push({ shape, weight: w, rrfK: shape === "rrf" ? rrfK : null, verdict: o.verdict, apex: o.apex, hub: o.hub });
      }
    }
  }

  // Live recall path check (createCore, not just the pure function).
  console.log("  live recall path (createCore):");
  for (const [shape, w, expect] of [
    ["additive", 1.0, "hub"],
    ["l1", 1.0, "apex"],
  ]) {
    const live = await recallConstructed(shape, w);
    const apex = inTop(live.hits, APEX_TEXT, 5);
    const hub = inTop(live.hits, HUB_TEXT, 5);
    let verdict = "neither";
    if (apex.hit && !hub.hit) verdict = "apex";
    else if (hub.hit && !apex.hit) verdict = "hub";
    else if (apex.hit && hub.hit) verdict = apex.rank < hub.rank ? "both-apex-ahead" : "both-hub-ahead";
    console.log("    " + (shape + " w=" + w).padEnd(28) + "  " + verdict +
      (verdict === expect ? "  (matches snapshot)" : "  (DIVERGES from snapshot expect=" + expect + ")"));
  }
  cleanup(constructed.dir);

  const corpusSnaps = [];
  for (const spec of CORPUS_CASES) {
    const snap = await snapshotCorpus(spec);
    corpusSnaps.push({ spec, snap });
    console.log("\n" + line);
    console.log("CORPUS  " + spec.id + "  n=" + snap.n + "  seedK=" + snap.seedK +
      (spec.inverted ? "  [adversarial: apex must stay OUT]" : ""));
    console.log("  query: " + snap.query);
    printNode("APEX", snap.apex);
    for (let i = 0; i < snap.hubs.length; i++) printNode("HUB" + (i + 1), snap.hubs[i]);
    if (snap.right) printNode("RIGHT", snap.right);

    const actRanked = snap.cosineOrder.filter((r) => r.bonus > 0)
      .sort((a, b) => b.bonus - a.bonus);
    console.log("  activation-arm (surplus bonus > 0), top 8:");
    for (const r of actRanked.slice(0, 8)) {
      console.log("    bonus-rank " + (actRanked.indexOf(r) + 1) +
        "  cos-rank " + r.rank +
        "  bonus " + fmt(r.bonus) +
        "  l1 " + fmt(r.l1) +
        "  " + JSON.stringify(r.text).slice(0, 70));
    }
    if (!actRanked.length) console.log("    (empty — nothing to fuse; save-time graph did not reach a non-seed)");

    console.log("  outcomes:");
    for (const shape of SHAPES) {
      const ks = shape === "rrf" ? RRF_KS : [RRF_K];
      for (const rrfK of ks) {
        for (const w of WEIGHTS) {
          const fused = fuseSnapshot(snap, shape, w, rrfK);
          const o = corpusOutcome(fused, snap, 5);
          const label = shape === "rrf" ? ("rrf k=" + rrfK + " w=" + w) : (shape + " w=" + w);
          printOutcome(label, o);
        }
      }
    }
  }

  console.log("\n" + line);
  console.log("READING NOTES (not a ship decision)");
  console.log("  additive  cosine + w·bonus          — the A/B that measured zero / hub-at-w=1");
  console.log("  rrf       1/(k+rank_cos) + w/(k+rank_act)  — scale-free; k=60 is 0003's default");
  console.log("  ranknorm  cosine + w·neighborhood-rank-norm — proto-2.3 (tied local-max = 1.0)");
  console.log("  l1        cosine + w·neighborhood-L1-share  — proto-2.4 (uniform cluster = 1/n)");
  console.log("  multiplicative  cosine·(1 + w·bonus) — 0003's other candidate; cannot close a large gap");
  console.log(line + "\n");

  if (json) {
    console.log(JSON.stringify({
      generated: new Date().toISOString(),
      shapes: SHAPES,
      weights: WEIGHTS,
      rrfK: RRF_KS,
      constructed: {
        apex: apexInfo,
        hub: hubInfo,
        cutoff: constructed.cosineOrder[4],
        table: constructedTable,
      },
      corpus: corpusSnaps.map(({ spec, snap }) => ({
        id: spec.id,
        inverted: spec.inverted,
        apex: snap.apex,
        hubs: snap.hubs,
        n: snap.n,
      })),
    }, null, 2));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(String(e && e.stack || e)); process.exit(2); });
}

module.exports = {
  snapshotConstructed, fuseSnapshot, apexHubOutcome, recallConstructed,
  snapshotCorpus, corpusOutcome, constructedPack,
  APEX_TEXT, HUB_TEXT, QUERY_TEXT, BRIDGE_TEXT, CLUSTER_SEED_TEXT,
  SHAPES, WEIGHTS, CORPUS_CASES,
};
