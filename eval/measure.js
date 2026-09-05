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
 * eval/measure.js — reporting metrics (A/B), distinct from the golden gate.
 *
 *   node eval/measure.js                     all measurement corpora, all registered metrics
 *   node eval/measure.js --corpus duplicates  one file / scenario-id prefix
 *   node eval/measure.js --k 5               recall_at_k's k (default 5)
 *   node eval/measure.js --json              machine-readable (02.b A/B)
 *   node eval/measure.js --bands             also print pairwise cosine within each group
 *
 * Reuses `pipeline.js` → `memory-core.js`. Does not write golden.json, does
 * not change product behaviour. Measurement corpora (`kind: "duplicates"` /
 * `gate: false`) are skipped by `eval/run.js` so this cannot flip the gate.
 *
 * Levers that will shift (write-path, warm-field, fusion) belong HERE as
 * runner flags, not inside a metric: a metric is a number over a result
 * shape; the runner decides which core flags produced the result. Today:
 * field off (I2: rank is cosine), k=5. `--field` is reserved so 02.b /
 * fusion don't grow a second runner.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { JsonlStore } = require("../store.js");
const { createMemory, cosine } = require("./pipeline.js");
const { embed } = require("./embed-cache.js");
const {
  computeMetric, explainMetric, listMetrics, groupsFromWrites, parsePrimaryHits,
} = require("./metrics.js");

const CORPORA = path.join(__dirname, "corpora");

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function isSelfContainedScenario(c) {
  return c && Array.isArray(c.writes) && Array.isArray(c.queries);
}

function isMeasurementLine(c) {
  if (!c) return false;
  if (c.kind === "duplicates" || c.kind === "measure" || c.gate === false) return true;
  if (c.role === "write" || c.role === "query" || c.role === "meta") return true;
  return isSelfContainedScenario(c) && !c.expect;
}

function loadScenarios(file) {
  const lines = readJsonl(file);
  const scenarios = [];
  let current = null;
  const flush = () => { if (current) { scenarios.push(current); current = null; } };
  for (const c of lines) {
    if (isSelfContainedScenario(c)) {
      flush();
      scenarios.push({
        id: c.id,
        kind: c.kind || "measure",
        writes: c.writes,
        queries: c.queries,
        note: c.note || "",
      });
      continue;
    }
    if (c.role === "meta" || (c.kind && c.id && !c.role && !c.text && !c.query)) {
      flush();
      current = { id: c.id, kind: c.kind || "measure", writes: [], queries: [], note: c.note || "" };
      continue;
    }
    if (c.role === "write" || (c.text && c.dup_group && !c.query)) {
      if (!current) throw new Error(file + ": write line before a meta/id line");
      current.writes.push(c);
      continue;
    }
    if (c.role === "query" || (c.query && (c.relevant_groups || c.relevant_ids || c.relevant_texts))) {
      if (!current) throw new Error(file + ": query line before a meta/id line");
      current.queries.push(c);
      continue;
    }
  }
  flush();
  return scenarios;
}

function loadAllScenarios(filter) {
  const out = [];
  for (const fn of fs.readdirSync(CORPORA).filter((f) => f.endsWith(".jsonl"))) {
    const file = path.join(CORPORA, fn);
    const lines = readJsonl(file);
    if (!lines.some(isMeasurementLine)) continue;
    const stem = fn.replace(/\.jsonl$/, "");
    for (const s of loadScenarios(file)) {
      if (filter && !String(s.id).startsWith(filter) && stem !== filter && !stem.startsWith(filter)) continue;
      out.push(Object.assign({ file: fn }, s));
    }
  }
  return out;
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-measure-"));
  const file = path.join(dir, "store.jsonl");
  return { store: new JsonlStore(file), file, dir };
}

function resolveRelevant(q, records, groups) {
  if (Array.isArray(q.relevant_ids) && q.relevant_ids.length) {
    return q.relevant_ids.map(String);
  }
  const wanted = new Set();
  if (Array.isArray(q.relevant_groups)) {
    for (const g of q.relevant_groups) {
      for (const t of groups[g] || []) wanted.add(t);
    }
  }
  if (Array.isArray(q.relevant_texts)) {
    for (const t of q.relevant_texts) wanted.add(t);
  }
  return records.filter((r) => wanted.has(r.text)).map((r) => String(r.id));
}

async function pairwiseCosines(groups) {
  const out = {};
  for (const [gid, texts] of Object.entries(groups)) {
    const uniq = [...new Set(texts)];
    if (uniq.length < 2) continue;
    const vecs = await embed(uniq);
    const pairs = [];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        pairs.push({ a: uniq[i], b: uniq[j], cosine: cosine(vecs[i], vecs[j]) });
      }
    }
    out[gid] = pairs;
  }
  return out;
}

async function runScenario(scenario, opts) {
  const k = opts && opts.k != null ? Number(opts.k) : 5;
  const fieldEnabled = !!(opts && opts.fieldEnabled);
  const { store, file, dir } = freshStore();
  const mem = createMemory({
    store, embed, fieldEnabled, edgesPath: file + ".edges.json",
  });

  const writes = (scenario.writes || []).map((w) => (typeof w === "string" ? { text: w } : w));
  const saveLog = [];
  for (const w of writes) {
    const msg = await mem.save(w.text);
    saveLog.push({ text: w.text, dup_group: w.dup_group || null, band: w.band || null, msg });
  }

  const records = store.current();
  const groups = groupsFromWrites(writes);
  const dupExplain = explainMetric("duplicate_rate", { records }, { groups });

  const queries = [];
  for (const q of scenario.queries || []) {
    const output = await mem.recall(q.query, k);
    const ranked = parsePrimaryHits(output);
    queries.push({
      id: q.id || q.query,
      query: q.query,
      ranked_ids: ranked.map((h) => String(h.id)),
      ranked_texts: ranked.map((h) => h.text),
      relevant_ids: resolveRelevant(q, records, groups),
      relevant_groups: q.relevant_groups || null,
      output,
    });
  }
  const recallExplain = explainMetric("recall_at_k", { queries }, scenario, { k });

  const exactCaught = saveLog.filter((s) => /already remembered/i.test(s.msg || "")).length;

  let bands = null;
  if (opts && opts.bands) bands = await pairwiseCosines(groups);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }

  return {
    id: scenario.id,
    file: scenario.file || null,
    k, field: fieldEnabled,
    n_writes: writes.length,
    n_stored_current: records.length,
    n_groups: Object.keys(groups).length,
    exact_restatements_caught: exactCaught,
    metrics: {
      duplicate_rate: dupExplain.rate,
      recall_at_k: recallExplain.rate,
    },
    duplicate_rate: dupExplain,
    recall_at_k: recallExplain,
    queries,
    saveLog,
    groups,
    bands,
  };
}

function printHuman(reports, { k }) {
  const line = "-".repeat(72);
  console.log("\nRM-00 reporting metrics  " + new Date().toISOString());
  console.log("(A/B numbers, not the golden gate. Reproduce: node eval/measure.js)");
  console.log(line);
  console.log("registered: " + listMetrics().map((m) => m.name).join(", "));

  for (const r of reports) {
    console.log("\n" + (r.id || "(unnamed)") + (r.file ? "  [" + r.file + "]" : ""));
    console.log("  writes=" + r.n_writes + "  stored_current=" + r.n_stored_current +
      "  groups=" + r.n_groups + "  exact_restatements_caught=" + r.exact_restatements_caught);
    console.log("  duplicate_rate  " + r.metrics.duplicate_rate.toFixed(4) +
      "   (extras=" + r.duplicate_rate.extras + "/" + r.duplicate_rate.n +
      ", G*=" + r.duplicate_rate.gStar + ")");
    console.log("  recall@" + k + "         " + r.metrics.recall_at_k.toFixed(4) +
      "   (" + r.recall_at_k.hits + "/" + r.recall_at_k.n + " queries hit)");
    if (r.recall_at_k.misses && r.recall_at_k.misses.length) {
      console.log("    misses: " + r.recall_at_k.misses.join(", "));
    }
    if (r.bands) {
      console.log("  pairwise cosine (multi-member groups):");
      for (const [gid, pairs] of Object.entries(r.bands)) {
        for (const p of pairs) {
          const tag = p.cosine >= 0.95 ? "hi " : p.cosine >= 0.88 ? "mid" : "low";
          console.log("    " + gid.padEnd(16) + " " + p.cosine.toFixed(4) + " " + tag);
        }
      }
    }
  }
  console.log("\n" + line + "\n");
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const json = args.includes("--json");
  const bands = args.includes("--bands");
  const fieldEnabled = args.includes("--field");
  const ci = args.indexOf("--corpus");
  const filter = ci >= 0 ? args[ci + 1] : null;
  const ki = args.indexOf("--k");
  const k = ki >= 0 ? Number(args[ki + 1]) : 5;

  const scenarios = loadAllScenarios(filter);
  if (!scenarios.length) {
    console.error("No measurement scenarios" + (filter ? " matching --corpus " + filter : "") + ".");
    process.exit(2);
  }
  const reports = [];
  for (const s of scenarios) reports.push(await runScenario(s, { k, fieldEnabled, bands }));

  if (json) {
    console.log(JSON.stringify({
      generated: new Date().toISOString(),
      k, field: fieldEnabled,
      metrics: listMetrics().map((m) => ({ name: m.name, description: m.description })),
      scenarios: reports.map((r) => ({
        id: r.id,
        n_writes: r.n_writes,
        n_stored_current: r.n_stored_current,
        n_groups: r.n_groups,
        exact_restatements_caught: r.exact_restatements_caught,
        metrics: r.metrics,
        duplicate_rate: r.duplicate_rate,
        recall_at_k: r.recall_at_k,
        bands: r.bands,
        misses: r.recall_at_k.misses,
      })),
    }, null, 2));
  } else {
    printHuman(reports, { k });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(2); });
}

module.exports = {
  loadScenarios, loadAllScenarios, runScenario, resolveRelevant, isMeasurementLine,
};
