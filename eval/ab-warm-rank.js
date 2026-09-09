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
 * Exploratory A/B: activation-in-rank (RESONANCE_WARM_RANK) vs cosine.
 *
 * NOT the golden gate. NOT the Phase 2.2 promotion. Flag-off is today's
 * behaviour; flag-on is cosine + 0.3 · spread-activation (same cap as
 * Related: maxBonus — not tuned against this run).
 *
 *   node eval/ab-warm-rank.js
 *   node eval/ab-warm-rank.js --weight 0.3
 *   node eval/ab-warm-rank.js --sensitivity
 *
 * Offline + deterministic (embeddings.cache.json).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const {
  loadScenarios, runScenario, poolContradiction,
} = require("./measure.js");
const { WARM_RANK_WEIGHT } = require("../memory-core.js");

const CORPORA = path.join(__dirname, "corpora");
const FILES = [
  "basic.jsonl",
  "field-noise.jsonl",
  "field-stress.jsonl",
  "adversarial.jsonl",
  "contradictions.jsonl",
  "cross-turn.jsonl",
  "weak-recall.jsonl",
  "hub-vs-apex.jsonl",
];

function fmt(x) {
  return x == null || Number.isNaN(x) ? "n/a" : Number(x).toFixed(4);
}

function delta(on, off) {
  if (on == null || off == null || Number.isNaN(on) || Number.isNaN(off)) return "n/a";
  const d = on - off;
  const sign = d > 0 ? "+" : "";
  return sign + d.toFixed(4);
}

function poolFile(reports) {
  let hits = 0, n = 0;
  let mrrSum = 0, mrrN = 0;
  let nStale = 0, nStaleDen = 0;
  let nFalse = 0, nKeep = 0;
  let liftSum = 0, liftN = 0, liftImproved = 0, liftEntered = 0;
  let hubBad = 0, hubN = 0;
  let bindYes = 0, bindN = 0;
  let relYes = 0, relN = 0;
  for (const r of reports || []) {
    const rec = r.recall_at_k;
    if (rec && rec.n) {
      hits += rec.hits;
      n += rec.n;
    }
    const m = r.mrr;
    if (m && m.n) {
      mrrSum += m.mrr * m.n;
      mrrN += m.n;
    }
    const s = r.staleness_rate;
    if (s && s.n) {
      nStale += s.n_stale;
      nStaleDen += s.n;
    }
    const f = r.false_supersession;
    if (f && f.n) {
      nFalse += f.n_false;
      nKeep += f.n;
    }
    const c = r.carryover_lift;
    if (c && c.n) {
      liftSum += c.mean_lift * c.n;
      liftN += c.n;
      liftImproved += c.n_improved || 0;
      liftEntered += c.n_entered_window || 0;
    }
    const h = r.rank_hub_contamination;
    if (h && h.n) {
      hubBad += h.n_contaminated;
      hubN += h.n;
    }
    const b = r.graph_bind_rate;
    if (b && b.n) {
      bindYes += b.n_present;
      bindN += b.n;
    }
    const rel = r.related_rescue_rate;
    if (rel && rel.n) {
      relYes += rel.n_rescued;
      relN += rel.n;
    }
  }
  return {
    n_scenarios: (reports || []).length,
    recall_at_k: n ? hits / n : null,
    recall_hits: hits,
    recall_n: n,
    mrr: mrrN ? mrrSum / mrrN : null,
    mrr_n: mrrN,
    staleness_rate: nStaleDen ? nStale / nStaleDen : null,
    n_stale: nStale,
    n_stale_den: nStaleDen,
    false_supersession: nKeep ? nFalse / nKeep : null,
    n_false: nFalse,
    n_keep: nKeep,
    carryover_lift: liftN ? liftSum / liftN : null,
    carryover_n: liftN,
    carryover_improved: liftImproved,
    carryover_entered: liftEntered,
    rank_hub_contamination: hubN ? hubBad / hubN : null,
    hub_n: hubN,
    hub_bad: hubBad,
    graph_bind_rate: bindN ? bindYes / bindN : null,
    bind_n: bindN,
    bind_yes: bindYes,
    related_rescue_rate: relN ? relYes / relN : null,
    related_n: relN,
  };
}

async function runArm(scenarios, opts) {
  const reports = [];
  for (const s of scenarios) {
    reports.push(await runScenario(s, opts));
  }
  return reports;
}

function printArm(label, pooled) {
  console.log("  " + label);
  console.log("    recall@5          " + fmt(pooled.recall_at_k) +
    (pooled.recall_n ? "   (" + pooled.recall_hits + "/" + pooled.recall_n + ")" : ""));
  console.log("    mrr               " + fmt(pooled.mrr) +
    (pooled.mrr_n ? "   (n=" + pooled.mrr_n + ")" : ""));
  if (pooled.n_stale_den) {
    console.log("    staleness_rate    " + fmt(pooled.staleness_rate) +
      "   (" + pooled.n_stale + "/" + pooled.n_stale_den + ")");
  }
  if (pooled.n_keep) {
    console.log("    false_supersession " + fmt(pooled.false_supersession) +
      "   (" + pooled.n_false + "/" + pooled.n_keep + ")");
  }
  if (pooled.carryover_n) {
    console.log("    carryover_lift     " + fmt(pooled.carryover_lift) +
      "   (n=" + pooled.carryover_n +
      " improved=" + pooled.carryover_improved +
      " entered@k=" + pooled.carryover_entered + ")");
  }
  if (pooled.hub_n) {
    console.log("    rank_hub_contam    " + fmt(pooled.rank_hub_contamination) +
      "   (" + pooled.hub_bad + "/" + pooled.hub_n + " hub-without-apex)");
  }
  if (pooled.bind_n) {
    console.log("    graph_bind_rate    " + fmt(pooled.graph_bind_rate) +
      "   (" + pooled.bind_yes + "/" + pooled.bind_n + ")");
  }
  if (pooled.related_n) {
    console.log("    related_rescue     " + fmt(pooled.related_rescue_rate) +
      "   (n=" + pooled.related_n + ")");
  }
}

function printDelta(offP, onP) {
  console.log("  delta (on − off)");
  console.log("    recall@5          " + delta(onP.recall_at_k, offP.recall_at_k));
  console.log("    mrr               " + delta(onP.mrr, offP.mrr));
  if (offP.n_stale_den || onP.n_stale_den) {
    console.log("    staleness_rate    " + delta(onP.staleness_rate, offP.staleness_rate) +
      "   (lower is better)");
  }
  if (offP.n_keep || onP.n_keep) {
    console.log("    false_supersession " + delta(onP.false_supersession, offP.false_supersession) +
      "   (lower is better)");
  }
  if (offP.carryover_n || onP.carryover_n) {
    console.log("    carryover_lift     " + delta(onP.carryover_lift, offP.carryover_lift) +
      "   (higher is better)");
  }
  if (offP.hub_n || onP.hub_n) {
    console.log("    rank_hub_contam    " + delta(onP.rank_hub_contamination, offP.rank_hub_contamination) +
      "   (lower is better)");
  }
}

async function runWeight(weight, files, k) {
  const byFile = [];
  const allOff = [];
  const allOn = [];
  for (const fn of files) {
    const scenarios = loadScenarios(path.join(CORPORA, fn)).map((s) =>
      Object.assign({ file: fn }, s)
    );
    if (!scenarios.length) continue;
    const off = await runArm(scenarios, { k, fieldEnabled: false, warmRank: false });
    const on = await runArm(scenarios, {
      k, fieldEnabled: false, warmRank: true, warmRankWeight: weight,
    });
    allOff.push(...off);
    allOn.push(...on);
    byFile.push({
      file: fn,
      n: scenarios.length,
      off: poolFile(off),
      on: poolFile(on),
      offReports: off,
      onReports: on,
    });
  }
  return { byFile, allOff, allOn, off: poolFile(allOff), on: poolFile(allOn) };
}

function listKey(r) {
  // Opaque ids are Date.now() per store, so arms never share ids.
  // Compare the texts the model actually sees.
  return (r.queries || []).map((q) => (q.ranked_texts || []).join("\n")).join("\n---\n");
}

function movedQueries(offReports, onReports) {
  const moved = [];
  for (let i = 0; i < offReports.length; i++) {
    const a = offReports[i], b = onReports[i];
    const offHits = (a.recall_at_k && a.recall_at_k.hits) || 0;
    const onHits = (b.recall_at_k && b.recall_at_k.hits) || 0;
    const offMrr = a.metrics && a.metrics.mrr;
    const onMrr = b.metrics && b.metrics.mrr;
    const metric = offHits !== onHits ||
      (offMrr != null && onMrr != null && Math.abs(offMrr - onMrr) > 1e-9);
    const list = listKey(a) !== listKey(b);
    if (metric || list) {
      moved.push({
        id: a.id,
        metric, list,
        off_hit: offHits,
        on_hit: onHits,
        off_mrr: offMrr,
        on_mrr: onMrr,
      });
    }
  }
  return moved;
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const ki = args.indexOf("--k");
  const k = ki >= 0 ? Number(args[ki + 1]) : 5;
  const wi = args.indexOf("--weight");
  const weight = wi >= 0 ? Number(args[wi + 1]) : WARM_RANK_WEIGHT;
  const sensitivity = args.includes("--sensitivity");
  const json = args.includes("--json");

  const line = "-".repeat(72);
  console.log("\nActivation-in-rank A/B  (exploratory; flag-off default; not the 2.2 gate)");
  console.log("combiner: final = cosine + w · spread-activation   w=" + weight +
    " (Related: maxBonus; not tuned)");
  console.log("seed radius: K_SEARCH (15); field: off; k=" + k);
  console.log("reproduce: node eval/ab-warm-rank.js --weight " + weight);
  console.log(line);

  const verdict = await runWeight(weight, FILES, k);

  for (const row of verdict.byFile) {
    console.log("\n" + row.file + "  (" + row.n + " scenarios)");
    printArm("OFF  (cosine)", row.off);
    printArm("ON   (w=" + weight + ")", row.on);
    printDelta(row.off, row.on);
    const moved = movedQueries(row.offReports, row.onReports);
    if (moved.length) {
      const nMetric = moved.filter((m) => m.metric).length;
      const nList = moved.filter((m) => m.list).length;
      console.log("  moved: " + nList + " list / " + nMetric + " metric  (" + moved.length + " scenarios)");
      for (const m of moved) {
        console.log("    " + m.id +
          (m.list && !m.metric ? "  list-only" : "") +
          "  hit " + m.off_hit + "→" + m.on_hit +
          "  mrr " + fmt(m.off_mrr) + "→" + fmt(m.on_mrr));
      }
    } else {
      console.log("  no query moved (byte-identical primary on this corpus)");
    }
  }

  console.log("\n" + line);
  console.log("POOLED  (all listed corpora)");
  printArm("OFF", verdict.off);
  printArm("ON", verdict.on);
  printDelta(verdict.off, verdict.on);

  const contraOff = poolContradiction(verdict.allOff);
  const contraOn = poolContradiction(verdict.allOn);
  if (contraOff && contraOn) {
    console.log("\nCONTRADICTIONS pooled (staleness / false-supersession)");
    console.log("  OFF  stale=" + fmt(contraOff.staleness_rate) +
      "  false_ss=" + fmt(contraOff.false_supersession));
    console.log("  ON   stale=" + fmt(contraOn.staleness_rate) +
      "  false_ss=" + fmt(contraOn.false_supersession));
    console.log("  Δ    stale=" + delta(contraOn.staleness_rate, contraOff.staleness_rate) +
      "  false_ss=" + delta(contraOn.false_supersession, contraOff.false_supersession));
  }

  let sensitivityRows = null;
  if (sensitivity) {
    console.log("\n" + line);
    console.log("SENSITIVITY  (same corpora, declared weights; not a search)");
    sensitivityRows = [];
    for (const w of [0.1, weight, 1.0].filter((v, i, a) => a.indexOf(v) === i)) {
      const run = w === weight ? verdict : await runWeight(w, FILES, k);
      sensitivityRows.push({ w, off: run.off, on: run.on });
      console.log("  w=" + w +
        "  Δrecall=" + delta(run.on.recall_at_k, run.off.recall_at_k) +
        "  Δmrr=" + delta(run.on.mrr, run.off.mrr) +
        "  Δstale=" + delta(run.on.staleness_rate, run.off.staleness_rate));
    }
  }

  if (json) {
    console.log("\n" + JSON.stringify({
      generated: new Date().toISOString(),
      combiner: "cosine + w * spread-activation",
      weight, k, field: false,
      files: FILES,
      pooled: { off: verdict.off, on: verdict.on },
      byFile: verdict.byFile.map((r) => ({
        file: r.file, n: r.n, off: r.off, on: r.on,
        moved: movedQueries(r.offReports, r.onReports).map((m) => m.id),
      })),
      contradictions: {
        off: contraOff, on: contraOn,
      },
      sensitivity: sensitivityRows,
    }, null, 2));
  }

  console.log("\n" + line + "\n");
}

if (require.main === module) {
  main().catch((e) => { console.error(String(e.message || e.stack || e)); process.exit(2); });
}

module.exports = { runWeight, poolFile, FILES };
