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
 * Phase 1 custom eval — Activation Propagation Ratio (APR).
 *
 * Pre-declared in docs/phases/phase-1-transient-activation.md BEFORE 1.3
 * was written. Not a recall metric: activation's own behaviour. Rank
 * identity and I7 live in test.js; this file is the propagation readout
 * the knobs were tuned against.
 *
 *   node eval/substrate/activation-measure.js
 *
 * Exit 0 iff every claim holds. Also required from test.js so a red
 * readout cannot hide behind "I ran the unit tests."
 */
"use strict";

const {
  WarmField, ATTENUATION, MAX_HOPS, FLOOR, CAP, HALF_LIFE_SECONDS,
  conductance, activationEdgesFromStore,
} = require("../../warm.js");
const { makeEdge, setSemantic, EdgeStore } = require("../../edges.js");

const EPS = 1e-9;
const T0 = "2026-01-01T00:00:00.000Z";

function chainEdges(pairs) {
  const m = new Map();
  for (const [a, b, sim] of pairs) {
    if (!m.has(a)) m.set(a, []);
    m.get(a).push({ id: b, sim });
  }
  return m;
}

function close(a, b) { return Math.abs(a - b) < EPS; }

function runMeasure() {
  const failed = [];
  const rows = [];

  function claim(id, name, pass, detail) {
    rows.push({ id, name, pass: !!pass, detail });
    if (!pass) failed.push(id + " " + name + " — " + detail);
  }

  const frozen = () => 1_000_000;

  // --- 1 neighbor coupling ------------------------------------------------
  {
    const W = new WarmField({ hops: 1, now: frozen });
    W.seed(["A"], 0.9);
    W.spread(chainEdges([["A", "B", 0.8]]));
    const got = W.get("B");
    const want = 0.9 * 0.8 * ATTENUATION;
    claim(1, "neighbor coupling",
      got > 0 && close(got, want) && got < W.get("A"),
      "E_B=" + got + " want " + want + " (E_A * γ * α)");
  }

  // --- 2 conductance monotonicity ----------------------------------------
  {
    const hi = new WarmField({ hops: 1, now: frozen });
    const lo = new WarmField({ hops: 1, now: frozen });
    hi.seed(["A"], 1.0);
    lo.seed(["A"], 1.0);
    hi.spread(chainEdges([["A", "B", 0.9]]));
    lo.spread(chainEdges([["A", "B", 0.4]]));
    claim(2, "conductance monotonicity",
      hi.get("B") > lo.get("B"),
      "E_B(0.9)=" + hi.get("B") + " vs E_B(0.4)=" + lo.get("B"));
  }

  // --- 3 multi-hop attenuation -------------------------------------------
  {
    const W = new WarmField({ hops: 2, now: frozen });
    W.seed(["A"], 0.9);
    W.spread(chainEdges([["A", "B", 0.8], ["B", "C", 0.8]]));
    const eA = W.get("A"), eB = W.get("B"), eC = W.get("C");
    const wantB = 0.9 * 0.8 * ATTENUATION;
    const wantC = wantB * 0.8 * ATTENUATION;
    claim(3, "multi-hop attenuation",
      eA > eB && eB > eC && eC > 0 && close(eB, wantB) && close(eC, wantC),
      "E_A=" + eA + " E_B=" + eB + " E_C=" + eC + " (want " + wantB + " > " + wantC + ")");
  }

  // --- 4 hop bound -------------------------------------------------------
  {
    const W = new WarmField({ hops: 1, now: frozen });
    W.seed(["A"], 0.9);
    W.spread(chainEdges([["A", "B", 0.8], ["B", "C", 0.8]]));
    claim(4, "hop bound",
      W.get("B") > 0 && W.get("C") === 0,
      "hops=1 E_B=" + W.get("B") + " E_C=" + W.get("C") + " (want 0)");
  }

  // --- 5 bootstrap vs learned --------------------------------------------
  {
    const boot = makeEdge("A", "B", { origin: "save-time-neighbor", now: T0, hebbianWeight: 0 });
    setSemantic(boot, 0.25, { a: 1, b: 1 });
    const learned = makeEdge("A", "B", { origin: "co-activation", now: T0, hebbianWeight: 2.0 });
    setSemantic(learned, 0.25, { a: 1, b: 1 });
    const gBoot = conductance(boot, T0);
    const gLearn = conductance(learned, T0);
    const Wboot = new WarmField({ hops: 1, now: frozen });
    const Wlearn = new WarmField({ hops: 1, now: frozen });
    const storeBoot = new EdgeStore(null);
    storeBoot.put(boot);
    const storeLearn = new EdgeStore(null);
    storeLearn.put(learned);
    const mems = [{ id: "A" }, { id: "B" }];
    Wboot.seed(["A"], 1.0);
    Wlearn.seed(["A"], 1.0);
    Wboot.spread(activationEdgesFromStore(storeBoot, mems, { now: T0 }), { live: ["A", "B"] });
    Wlearn.spread(activationEdgesFromStore(storeLearn, mems, { now: T0 }), { live: ["A", "B"] });
    claim(5, "bootstrap vs learned",
      gBoot < gLearn && Wboot.get("B") < Wlearn.get("B") && Wboot.get("B") > 0,
      "γ_boot=" + gBoot + " γ_learn=" + gLearn +
      " E_B boot=" + Wboot.get("B") + " learned=" + Wlearn.get("B"));
  }

  // --- 6 runaway bound ---------------------------------------------------
  {
    const W = new WarmField({ hops: 1, cap: 32, now: frozen });
    const pairs = [];
    for (let i = 0; i < 100; i++) pairs.push(["A", "n" + i, 1.0]);
    W.seed(["A"], 1.0);
    W.spread(chainEdges(pairs));
    let maxE = 0;
    for (const [, n] of W.nodes) if (n.value > maxE) maxE = n.value;
    claim(6, "runaway bound",
      maxE <= 1 && W.nodes.size <= 32,
      "maxE=" + maxE + " size=" + W.nodes.size + " cap=32");
  }

  // --- 7 half-life (wall-clock, 5s pause is not a dump) ------------------
  {
    let t = 1_000_000;
    const W = new WarmField({ now: () => t, halfLife: HALF_LIFE_SECONDS });
    W.seed(["A"], 1.0);
    t += 5000;                             // 5s think-pause
    const afterPause = W.get("A");
    t = 1_000_000 + HALF_LIFE_SECONDS * 1000;
    const atH = W.get("A");
    const pauseOk = afterPause > 0.98;     // ~1.1% decay at H=300s
    const halfOk = Math.abs(atH - 0.5) < 1e-9;
    claim(7, "half-life",
      pauseOk && halfOk,
      "5s→" + afterPause + " (want >0.98); t=H→" + atH + " (want 0.5)");
  }

  // --- extras the phase doc named as gates, cheap to keep here -----------
  {
    const W = new WarmField({ hops: 2, now: frozen });
    W.seed(["A"], 1.0);
    W.spread(chainEdges([["A", "B", 0.8]]));
    W.forget("B");
    W.seed(["A"], 1.0);
    W.spread(chainEdges([["A", "B", 0.8]]), { live: ["A"] }); // B not live
    claim("P", "no resurrect",
      W.get("B") === 0,
      "E_B after forget+spread-without-live=" + W.get("B"));
  }
  {
    const pruned = makeEdge("A", "B", { origin: "save-time-neighbor", now: T0 });
    setSemantic(pruned, 0.9, { a: 1, b: 1 });
    pruned.pruned_at = T0;
    const store = new EdgeStore(null);
    store.put(pruned);
    const W = new WarmField({ hops: 1, now: frozen });
    W.seed(["A"], 1.0);
    W.spread(activationEdgesFromStore(store, [{ id: "A" }, { id: "B" }], { now: T0 }),
      { live: ["A", "B"] });
    claim("Q", "pruned edge silent",
      W.get("B") === 0 && conductance(pruned, T0) === 0,
      "E_B=" + W.get("B") + " γ=" + conductance(pruned, T0));
  }

  return {
    pass: failed.length === 0,
    failed,
    rows,
    knobs: {
      attenuation: ATTENUATION,
      hops: MAX_HOPS,
      floor: FLOOR,
      cap: CAP,
      halfLifeSeconds: HALF_LIFE_SECONDS,
    },
  };
}

function format(result) {
  const lines = [];
  lines.push("Phase 1 APR readout  (activation's own behaviour; not a recall metric)");
  lines.push("knobs: α=" + result.knobs.attenuation +
    " hops=" + result.knobs.hops +
    " floor=" + result.knobs.floor +
    " cap=" + result.knobs.cap +
    " H=" + result.knobs.halfLifeSeconds + "s");
  for (const r of result.rows) {
    lines.push("  " + (r.pass ? "ok  " : "FAIL") + "  #" + r.id + "  " + r.name + "  " + r.detail);
  }
  lines.push(result.pass
    ? "APR: all claims hold."
    : "APR: FAILED — " + result.failed.join(" | "));
  return lines.join("\n");
}

if (require.main === module) {
  const result = runMeasure();
  console.log(format(result));
  process.exit(result.pass ? 0 : 1);
}

module.exports = { runMeasure, format };
