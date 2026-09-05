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
 * eval/run.js - the RM-00 harness runner.
 *
 *   npm run eval                 run all corpora, print scorecard, check regressions
 *   npm run eval -- --accept     write the current scorecard as golden.json (the gate)
 *   npm run eval -- --filter X   run only cases whose id starts with X
 *
 * Constraint cases run BOTH field:false and field:true; the gap between them is
 * the associative field's measured value - the number this project most needs and
 * has never had. Repeated cases keep ONE store across turns so the Hebbian loop
 * can strengthen edges; first_hit_turn is reported so "missed at turn 1, landed by
 * turn 4" reads as the success it is.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { JsonlStore } = require("../store.js");
const { createMemory } = require("./pipeline.js");
const { embed } = require("./embed-cache.js");
const { scoreSingle, scoreRepeat, fieldSignals } = require("./metrics.js");

const CORPORA = path.join(__dirname, "corpora");
const GOLDEN = path.join(__dirname, "golden.json");

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-eval-"));
  const file = path.join(dir, "store.jsonl");
  return { store: new JsonlStore(file), file, dir };
}

async function runCase(c, fieldOn) {
  const { store, file, dir } = freshStore();
  const mem = createMemory({ store, embed, fieldEnabled: fieldOn, edgesPath: file + ".edges.json" });
  for (const w of c.writes || []) await mem.save(w);
  const turns = c.repeat || [{ query: c.query }];
  const outputs = [];
  for (const t of turns) outputs.push(await mem.recall(t.query));
  const scored = c.repeat ? scoreRepeat(c, outputs) : scoreSingle(c, outputs[0]);
  const sig = fieldSignals(c, outputs[outputs.length - 1]);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  return {
    id: c.id, kind: c.kind, field: fieldOn, metric: c.metric || null,
    pass: scored.pass, reasons: scored.reasons,
    byTurn: scored.byTurn, first_hit_turn: scored.first_hit_turn,
    rescued: sig.rescued, bled: sig.bled, appended: sig.appended,
  };
}

async function run({ filter = null } = {}) {
  const results = [];
  for (const fileName of fs.readdirSync(CORPORA).filter((f) => f.endsWith(".jsonl"))) {
    for (const c of readJsonl(path.join(CORPORA, fileName))) {
      if (filter && !c.id.startsWith(filter)) continue;
      const modes = c.kind === "constraint" ? [false, true] : [c.field ?? false];
      for (const fieldOn of modes) results.push(await runCase(c, fieldOn));
    }
  }
  return results;
}

const key = (r) => r.id + (r.kind === "constraint" ? (r.field ? " [field:on]" : " [field:off]") : "");

function scorecard(results) {
  const line = "-".repeat(72);
  console.log("\nRM-00 eval scorecard  " + new Date().toISOString());
  console.log(line);

  // Per-case, grouped by kind
  const byKind = {};
  for (const r of results) (byKind[r.kind] ||= []).push(r);
  for (const kind of Object.keys(byKind)) {
    console.log("\n" + kind.toUpperCase());
    for (const r of byKind[kind]) {
      const tag = r.pass ? "PASS" : "FAIL";
      let extra = "";
      if (r.byTurn) extra += "  turns=[" + r.byTurn.map((b) => (b ? "1" : "0")).join(",") + "] first_hit=" + (r.first_hit_turn ?? "-");
      if (!r.pass && r.reasons.length) extra += "  (" + r.reasons.join("; ") + ")";
      console.log("  " + tag + "  " + key(r) + extra);
    }
  }

  // The headline: field off vs on, for constraint cases
  const constraints = results.filter((r) => r.kind === "constraint");
  if (constraints.length) {
    console.log("\n" + line);
    console.log("ASSOCIATIVE FIELD - measured value (constraint cases: off vs on)");
    const ids = [...new Set(constraints.map((r) => r.id))];
    let liftedToPass = 0, brokenByField = 0;
    for (const id of ids) {
      const off = constraints.find((r) => r.id === id && r.field === false);
      const on = constraints.find((r) => r.id === id && r.field === true);
      const o = off ? (off.pass ? "PASS" : "fail") : " - ";
      const n = on ? (on.pass ? "PASS" : "fail") : " - ";
      let mark = "";
      if (off && on && !off.pass && on.pass) { mark = "  <== field earned it"; liftedToPass++; }
      if (off && on && off.pass && !on.pass) { mark = "  <== field BROKE it"; brokenByField++; }
      console.log("  " + id.padEnd(24) + " off=" + o + "  on=" + n + mark);
    }
    console.log("  " + line.slice(0, 60));
    console.log("  field lifted " + liftedToPass + " case(s) fail->pass" +
      (brokenByField ? ", and BROKE " + brokenByField + " (regression!)" : ""));
  }

  // ROC / TBR split (RM-00 field metric): a forgotten constraint and a hallucinated
  // tangent are not the same failure. Track constraint rescue apart from tangent bleed.
  const rocIds = [...new Set(results.filter((r) => r.metric === "roc").map((r) => r.id))];
  if (rocIds.length) {
    console.log("\n" + line);
    console.log("CONSTRAINT RESCUE — ROC  (did the apex rule surface? off vs on)");
    let onHit = 0, offHit = 0, attributable = 0;
    for (const id of rocIds) {
      const off = results.find((r) => r.id === id && r.field === false);
      const on = results.find((r) => r.id === id && r.field === true);
      const o = off && off.rescued, n = on && on.rescued;
      if (n) onHit++; if (o) offHit++;
      let mark = "";
      if (!o && n) { mark = "  <== field rescued it"; attributable++; }
      console.log("  " + id.padEnd(22) + " off=" + (o ? "RESCUED" : " miss  ") + "  on=" + (n ? "RESCUED" : " miss  ") + mark);
    }
    const pct = (x) => (100 * x / rocIds.length).toFixed(0) + "%";
    console.log("  " + line.slice(0, 60));
    console.log("  ROC  off=" + offHit + "/" + rocIds.length + " (" + pct(offHit) + ")   on=" +
      onHit + "/" + rocIds.length + " (" + pct(onHit) + ")   field-attributable rescues: " + attributable);
  }

  const tbrIds = [...new Set(results.filter((r) => r.metric === "tbr").map((r) => r.id))];
  if (tbrIds.length) {
    console.log("\n" + line);
    console.log("TANGENT BLEED — TBR  (did forbidden junk leak in? off vs on)");
    let onBleed = 0, offBleed = 0;
    for (const id of tbrIds) {
      const off = results.find((r) => r.id === id && r.field === false);
      const on = results.find((r) => r.id === id && r.field === true);
      if (on && on.bled) onBleed++; if (off && off.bled) offBleed++;
      const tag = (r) => r ? (r.bled ? "BLED(" + r.bled + ")" : "clean  ") + " +" + r.appended + "rel" : " - ";
      console.log("  " + id.padEnd(22) + " off=" + tag(off) + "  on=" + tag(on));
    }
    const pct = (x) => (100 * x / tbrIds.length).toFixed(0) + "%";
    console.log("  " + line.slice(0, 60));
    console.log("  TBR  off=" + offBleed + "/" + tbrIds.length + " (" + pct(offBleed) + ")   on=" +
      onBleed + "/" + tbrIds.length + " (" + pct(onBleed) + ")   (+Nrel = memories the field appended)");
  }

  // Totals
  const passed = results.filter((r) => r.pass).length;
  console.log("\n" + line);
  console.log("TOTAL: " + passed + "/" + results.length + " checks passed");
  console.log(line + "\n");

  return { generated: new Date().toISOString(), passed, total: results.length,
    cases: Object.fromEntries(results.map((r) => [key(r), r.pass])) };
}

function gate(current) {
  if (!fs.existsSync(GOLDEN)) {
    console.log("No golden.json yet. Review the scorecard above, then lock it in:");
    console.log("  npm run eval -- --accept\n");
    return 0;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  const regressions = [], improvements = [];
  for (const [k, wasPass] of Object.entries(golden.cases || {})) {
    const now = current.cases[k];
    if (now === undefined) continue;
    if (wasPass && !now) regressions.push(k);
    if (!wasPass && now) improvements.push(k);
  }
  if (improvements.length) console.log("IMPROVED since golden: " + improvements.join(", "));
  if (regressions.length) {
    console.error("REGRESSION - these cases flipped PASS -> FAIL:");
    for (const k of regressions) console.error("  " + k);
    console.error("");
    return 1;
  }
  console.log("No regressions vs golden.\n");
  return 0;
}

(async () => {
  const args = process.argv.slice(2);
  const accept = args.includes("--accept");
  const fi = args.indexOf("--filter");
  const filter = fi >= 0 ? args[fi + 1] : null;

  const results = await run({ filter });
  const current = scorecard(results);

  if (accept) {
    fs.writeFileSync(GOLDEN, JSON.stringify(current, null, 2));
    console.log("Wrote golden.json (" + current.passed + "/" + current.total + ").\n");
    process.exit(0);
  }
  process.exit(gate(current));
})().catch((e) => { console.error(String(e.message || e)); process.exit(2); });
