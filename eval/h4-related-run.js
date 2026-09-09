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
 * eval/h4-related-run.js — H4 campaign scorecard.
 *
 *   node eval/h4-related-run.js
 *   node eval/h4-related-run.js --floor 0.10
 *
 * Offline, cached embeddings. Not the golden gate.
 *
 * Pre-registered (locked before looking at held-out):
 *   1. discovery_rate ≥ 0.5 on in-pool associative-carry cold-misses
 *   2. new_vs_dup ≥ 0.5 of Related:-only warm target-hits (not kNN dups)
 *   3. intrusion_rate = 0 on unrelated-control
 *   4. hub_share_of_new ≤ 0.5
 *   5. held-out associative-carry discovery_rate ≥ 0.5 AND chain shape
 *      is reported separately (expected-hard under 2-hop attenuation)
 */
const path = require("path");
const { loadScenarios, runScenario } = require("./measure.js");
const { explainMetric } = require("./metrics.js");

function pool(reports, pred) {
  const queries = [];
  for (const r of reports) {
    if (pred && !pred(r)) continue;
    for (const q of r.queries || []) queries.push(q);
  }
  return explainMetric("warm_related_discovery", { queries }, null, { k: 5 });
}

function fmt(x) {
  return x == null || Number.isNaN(x) ? "n/a" : Number(x).toFixed(3);
}

function line(label, s) {
  console.log("  " + label.padEnd(28) +
    " n=" + String(s.n).padStart(2) +
    "  cold_miss=" + String(s.n_cold_miss).padStart(2) +
    "  disc=" + String(s.n_discovery).padStart(2) +
    "  dup=" + String(s.n_duplicate_target).padStart(2) +
    "  rate=" + fmt(s.rate) +
    "  new/dup=" + fmt(s.new_vs_dup) +
    "  intr=" + fmt(s.intrusion_rate) +
    "  hub_new=" + fmt(s.hub_share_of_new));
}

async function runCorpus(stem, opts) {
  const file = path.join(__dirname, "corpora", stem + ".jsonl");
  const scenarios = loadScenarios(file);
  const reports = [];
  for (const s of scenarios) {
    reports.push(await runScenario(s, opts));
  }
  return reports;
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const fi = args.indexOf("--floor");
  const floor = fi >= 0 ? Number(args[fi + 1]) : 0.05;
  const opts = {
    k: 5,
    fieldEnabled: true,
    warmRelated: true,
    warmRelatedFloor: floor,
  };
  console.log("H4 campaign  floor=" + floor + "  " + new Date().toISOString());
  console.log("mechanism: spread-only leftover + persist-net 1-hop to this-turn seeds");
  console.log("warm turns seed field-OFF (no Hebbian confound); probe field-ON\n");

  const xt = await runCorpus("cross-turn", opts);
  const h4 = await runCorpus("h4-related", opts);
  const all = xt.concat(h4);

  console.log("cross-turn (mostly typed-constraint stars — duplicate detector)");
  line("all", pool(xt));
  line("associative-carry", pool(xt, (r) => r.subset === "associative-carry"));
  line("direct-leftover", pool(xt, (r) => r.subset === "direct-leftover"));
  line("unrelated-control", pool(xt, (r) => r.subset === "unrelated-control"));
  line("hub-warm-attack", pool(xt, (r) => r.subset === "hub-warm-attack"));

  console.log("\nh4-related (non-constraint; the H4 window)");
  line("all", pool(h4));
  line("in-pool assoc-carry", pool(h4, (r) => r.subset === "associative-carry" && !r.held_out));
  line("held-out assoc-carry", pool(h4, (r) => r.subset === "associative-carry" && r.held_out));
  line("star", pool(h4, (r) => r.shape === "star" && r.subset === "associative-carry"));
  line("chain (2nd shape)", pool(h4, (r) => r.shape === "chain"));
  line("direct-leftover", pool(h4, (r) => r.subset === "direct-leftover"));
  line("unrelated-control", pool(h4, (r) => r.subset === "unrelated-control"));
  line("hub-warm-attack", pool(h4, (r) => r.subset === "hub-warm-attack"));

  console.log("\nper-case");
  for (const r of all) {
    const s = r.warm_related_discovery || {};
    const q = (s.byQuery && s.byQuery[0]) || {};
    const tag = (r.held_out ? "HOLD " : "     ") + (r.shape || "-") + "/" + (r.subset || "-");
    console.log("  " + String(r.id).padEnd(32) + tag.padEnd(36) +
      " bind=" + fmt(r.metrics.graph_bind_rate) +
      "  coldR=" + (q.target_in_cold ? "Y" : "n") +
      " warmR=" + (q.target_in_warm ? "Y" : "n") +
      " disc=" + (q.discovery ? "Y" : "n") +
      " dup=" + (q.duplicate ? "Y" : "n") +
      " new=" + (q.n_new != null ? q.n_new : 0) +
      " hub_new=" + (q.n_new_hub != null ? q.n_new_hub : 0) +
      " intr=" + (q.n_warm_intrusion != null ? q.n_warm_intrusion : 0));
  }

  const inpool = pool(h4, (r) => r.subset === "associative-carry" && !r.held_out);
  const held = pool(h4, (r) => r.subset === "associative-carry" && r.held_out);
  const chain = pool(h4, (r) => r.shape === "chain");
  const unrelated = pool(all, (r) => r.subset === "unrelated-control");
  const xtAssoc = pool(xt, (r) => r.subset === "associative-carry");
  const hubShare = pool(h4);

  console.log("\npre-registered clauses (H4, this mechanism)");
  const c1 = inpool.n_cold_miss ? inpool.rate >= 0.5 : false;
  const c2new = inpool.new_vs_dup == null ? null : inpool.new_vs_dup >= 0.5;
  const c2xt = xtAssoc.n_duplicate_target >= xtAssoc.n_discovery;
  const c3 = unrelated.intrusion_rate === 0 && (unrelated.unrelated_target_lift === 0 || unrelated.unrelated_target_lift == null);
  const c4 = hubShare.hub_share_of_new == null || hubShare.hub_share_of_new <= 0.5;
  const c5held = held.n_cold_miss ? held.rate >= 0.5 : false;
  const c5chain = chain.n > 0;
  console.log("  1 in-pool assoc-carry discovery_rate ≥ 0.5     " +
    (c1 ? "PASS" : "FAIL") + "  (" + fmt(inpool.rate) + " on " + inpool.n_cold_miss + " cold-miss)");
  console.log("  2a in-pool new-vs-dup ≥ 0.5 of warm target-hits " +
    (c2new ? "PASS" : "FAIL") + "  (" + fmt(inpool.new_vs_dup) + ")");
  console.log("  2b cross-turn typed-constraint mostly duplicate " +
    (c2xt ? "PASS (dup≥disc, as predicted)" : "NOTE") +
    "  disc=" + xtAssoc.n_discovery + " dup=" + xtAssoc.n_duplicate_target);
  console.log("  3 unrelated: no labeled intrusion AND no target lift " +
    (c3 ? "PASS" : "FAIL") + "  (intr=" + fmt(unrelated.intrusion_rate) +
    " target_lift=" + fmt(unrelated.unrelated_target_lift) + ")");
  console.log("  4 hub_share_of_new ≤ 0.5                        " +
    (c4 ? "PASS" : "FAIL") + "  (" + fmt(hubShare.hub_share_of_new) + ")");
  console.log("  5a held-out assoc-carry discovery_rate ≥ 0.5    " +
    (c5held ? "PASS" : "FAIL") + "  (" + fmt(held.rate) + " on " + held.n_cold_miss + " cold-miss)");
  console.log("  5b chain shape reported                         " +
    (c5chain ? "YES" : "NO") + "  rate=" + fmt(chain.rate) +
    " (expected-hard: 2-hop leftover vs floor)");
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { main, pool };
