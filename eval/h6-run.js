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
 * eval/h6-run.js — H6 consumption harness (injected recall block).
 *
 * Arms A/B/D/N, same primary IDs+order across A/B/D (asserted BEFORE any
 * generation), greedy + fixed seed, fail-loud if the driver is down, per-arm
 * log of {exact injected prompt, model id/config, gen params, raw output,
 * parsed answer}, replay support.
 *
 * Consumption format is the recall block injected into context — not a
 * live recall_memory tool-call. That is forced by the primary-identity
 * control (a tool-calling driver could vary its own top-k between arms).
 *
 * Default CLI does NOT contact the driver. --live is for after GPT audits
 * the fixtures. Tests inject a stub via `driver.complete`.
 *
 *   node eval/h6-run.js                  # refuse live; print the checkpoint
 *   node eval/h6-run.js --assemble-only  # prompts + primary-identity assert
 *   node eval/h6-run.js --replay <log>   # re-parse stored raw outputs
 *   node eval/h6-run.js --live           # stock qwen3.6; FAILS LOUD if down
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { parseFixtureOutput } = require("./h6-parse.js");
const { loadAllFixtures } = require("./h6-audit-check.js");

const ARMS = ["A", "B", "D", "N"];

const DEFAULT_DRIVER = {
  id: process.env.H6_DRIVER_MODEL || "qwen3.6-35B-A3B",
  url: process.env.H6_DRIVER_URL || "http://localhost:1234/v1/chat/completions",
  temperature: 0,
  seed: 7,
  max_tokens: 128,
  timeout_ms: Number(process.env.H6_DRIVER_TIMEOUT_MS) || 60000,
};

/*
 * Same system text on every arm. Deliberately does NOT mention Related:
 * as a privileged channel and does NOT say to ignore it — coaching either
 * way would pollute the utilization test. The driver sees the RM recall
 * block (numbered primary, then Related:) and an output contract.
 */
const SYSTEM = [
  "You are answering one factual question about a fictional person's notes.",
  "Use only the injected recall block below (the numbered memories and any Related: section).",
  "Do not use world knowledge. Do not guess.",
  "Reply with a single slot value. Do not list alternatives.",
].join(" ");

function formatPrimary(primary) {
  return (primary || []).map((m, i) =>
    (i + 1) + ". [id " + m.id + "] " + m.text
  ).join("\n");
}

function formatRelated(related) {
  const items = !related ? [] : (Array.isArray(related) ? related : [related]);
  if (!items.length) return "";
  return "Related:\n" + items.map((e) => "- [id " + e.id + "] " + e.text).join("\n");
}

function formatRecallBlock(primary, related) {
  const p = formatPrimary(primary);
  const r = formatRelated(related);
  return r ? p + "\n\n" + r : p;
}

function conversationPrefix(fix) {
  const lines = [];
  if (fix.turn_0 && String(fix.turn_0).trim()) lines.push("User: " + String(fix.turn_0).trim());
  if (fix.turn_1 && String(fix.turn_1).trim()) lines.push("User: " + String(fix.turn_1).trim());
  if (!lines.length) return "";
  return "Prior context:\n" + lines.join("\n");
}

function relatedForArm(fix, arm) {
  if (arm === "A") return fix.related;
  if (arm === "B") return fix.filler;
  if (arm === "D") return fix.related_d;
  if (arm === "N") return fix.n_related || fix.filler;
  throw new Error("unknown arm " + arm);
}

function primaryForArm(fix, arm) {
  if (arm === "N") return fix.n_primary;
  return fix.primary;
}

function assembleArm(fix, arm) {
  if (!ARMS.includes(arm)) throw new Error("unknown arm " + arm);
  const primary = primaryForArm(fix, arm);
  const related = relatedForArm(fix, arm);
  const recall = formatRecallBlock(primary, related);
  const conv = conversationPrefix(fix);
  const userParts = [];
  if (conv) {
    userParts.push(conv);
    userParts.push("");
  }
  userParts.push("Recall:");
  userParts.push(recall);
  userParts.push("");
  userParts.push("Question: " + fix.query);
  userParts.push("Answer with the single value only.");
  const user = userParts.join("\n");
  const primaryBlock = formatPrimary(primary);
  return {
    arm,
    system: SYSTEM,
    user,
    prompt: SYSTEM + "\n\n" + user,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    primaryBlock,
    relatedBlock: formatRelated(related),
    primaryIds: (primary || []).map((m) => String(m.id)),
  };
}

function assembleArms(fix) {
  const out = {};
  for (const arm of ARMS) out[arm] = assembleArm(fix, arm);
  return out;
}

/*
 * Load-bearing control. A/B/D must see the same primary IDs and order
 * byte-for-byte. Throws — never continues into generation on a mismatch.
 */
function assertPrimaryIdentity(assembled, fix) {
  const id = (fix && fix.id) || "(unknown)";
  const a = assembled.A;
  const b = assembled.B;
  const d = assembled.D;
  if (!a || !b || !d) throw new Error(id + ": missing A/B/D assembly");
  if (a.primaryBlock !== b.primaryBlock || a.primaryBlock !== d.primaryBlock) {
    throw new Error(id + ": primary block is not byte-identical across A/B/D");
  }
  const idsA = a.primaryIds.join("\0");
  if (idsA !== b.primaryIds.join("\0") || idsA !== d.primaryIds.join("\0")) {
    throw new Error(id + ": primary IDs/order are not identical across A/B/D");
  }
  if (fix && Array.isArray(fix.primary_ids)) {
    const want = fix.primary_ids.map(String).join("\0");
    if (idsA !== want) {
      throw new Error(id + ": assembled primary IDs do not match fixture.primary_ids");
    }
  }
  return a.primaryBlock;
}

function driverConfig(overrides) {
  const o = overrides || {};
  return {
    id: o.id || o.model || DEFAULT_DRIVER.id,
    url: o.url || DEFAULT_DRIVER.url,
    temperature: o.temperature != null ? o.temperature : DEFAULT_DRIVER.temperature,
    seed: o.seed != null ? o.seed : DEFAULT_DRIVER.seed,
    max_tokens: o.max_tokens != null ? o.max_tokens : DEFAULT_DRIVER.max_tokens,
    timeout_ms: o.timeout_ms != null ? o.timeout_ms : DEFAULT_DRIVER.timeout_ms,
    complete: typeof o.complete === "function" ? o.complete : null,
    fetch: typeof o.fetch === "function" ? o.fetch : fetch,
  };
}

function genParams(cfg) {
  return {
    temperature: cfg.temperature,
    seed: cfg.seed,
    max_tokens: cfg.max_tokens,
    enable_thinking: false,
  };
}

function messageContent(body) {
  if (!body) return "";
  if (typeof body === "string") return body;
  const choice = body.choices && body.choices[0];
  const msg = (choice && choice.message) || body.content || body;
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  if (typeof msg.content === "string") return msg.content;
  if (msg.content && typeof msg.content.text === "string") return msg.content.text;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => (typeof p === "string" ? p : (p && p.text) || "")).join("");
  }
  return "";
}

function driverDown(err) {
  const msg = err && err.message ? err.message : String(err);
  const e = new Error("H6 DRIVER DOWN: " + msg + " — refusing to score (not a 0)");
  e.code = "H6_DRIVER_DOWN";
  e.cause = err;
  return e;
}

/*
 * Fail-loud generation. A down driver must NEVER become a silent 0-score.
 * Stub path: driver.complete(prompt, { arm, fixture, assembled }).
 */
async function callDriver(assembled, cfg) {
  const driver = driverConfig(cfg);
  if (driver.complete) {
    const raw = await driver.complete(assembled.prompt, {
      arm: assembled.arm,
      messages: assembled.messages,
    });
    return String(raw == null ? "" : raw);
  }
  const body = {
    model: driver.id,
    messages: assembled.messages,
    temperature: driver.temperature,
    seed: driver.seed,
    max_tokens: driver.max_tokens,
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  let res;
  try {
    res = await driver.fetch(driver.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(driver.timeout_ms),
    });
  } catch (e) {
    throw driverDown(e);
  }
  if (!res || !res.ok) {
    const status = res ? res.status : "no-response";
    throw driverDown(new Error("HTTP " + status + " from " + driver.url));
  }
  let json;
  try { json = await res.json(); }
  catch (e) { throw driverDown(e); }
  return messageContent(json);
}

function evaluateCase(fix, armParsed) {
  const A = !!(armParsed.A && armParsed.A.ok);
  const B = !!(armParsed.B && armParsed.B.ok);
  const D = !!(armParsed.D && armParsed.D.ok);
  const N = !!(armParsed.N && armParsed.N.ok);
  const s1 = fix.stratum === "related-necessary";
  const s2 = fix.stratum === "primary-sufficient";
  const dropN = N;
  const dropB = s1 && B; // S1 B-succeeds cannot distinguish unused vs leak
  const valid = !dropN && !dropB;
  return {
    id: fix.id,
    stratum: fix.stratum,
    family: fix.family,
    held_out: !!fix.held_out,
    A_correct: A,
    B_correct: B,
    D_correct: D,
    N_correct: N,
    // McNemar off-diagonals. See h6-build-notes.md for the A→B naming.
    b_to_a: !B && A,           // B wrong → A correct (S1 win)
    a_to_b: !A && B,           // A wrong → B correct (S1 mechanism failure)
    a_to_d: A && !D,           // A correct → D wrong (S2 hijack)
    drop_n_pass: dropN,
    drop_b_succeeds: dropB,
    valid,
    s1, s2,
  };
}

function summarize(caseRows) {
  const rows = caseRows || [];
  const s1All = rows.filter((r) => r.s1);
  const s2All = rows.filter((r) => r.s2);
  const nPass = rows.filter((r) => r.drop_n_pass);
  const bSucc = rows.filter((r) => r.drop_b_succeeds);
  const s1 = s1All.filter((r) => r.valid);
  const s2 = s2All.filter((r) => r.valid);
  const s1Held = s1.filter((r) => r.held_out);
  const s1In = s1.filter((r) => !r.held_out);
  const rate = (n, d) => d ? n / d : null;
  const count = (arr, fn) => arr.filter(fn).length;
  const s1_b_to_a = count(s1, (r) => r.b_to_a);
  const s1_a_to_b = count(s1, (r) => r.a_to_b);
  const s2_a_to_d = count(s2, (r) => r.a_to_d);
  const accA_s1 = rate(count(s1, (r) => r.A_correct), s1.length);
  const accB_s1 = rate(count(s1, (r) => r.B_correct), s1.length);
  const accA_s2 = rate(count(s2, (r) => r.A_correct), s2.length);
  const accD_s2 = rate(count(s2, (r) => r.D_correct), s2.length);
  return {
    n_cases: rows.length,
    n_pass_dropped: nPass.map((r) => r.id),
    b_succeeds_dropped: bSucc.map((r) => r.id),
    s1_valid_n: s1.length,
    s1_inpool_n: s1In.length,
    s1_heldout_n: s1Held.length,
    s2_valid_n: s2.length,
    s1_b_to_a: s1_b_to_a,
    s1_b_to_a_rate: rate(s1_b_to_a, s1.length),
    s1_a_to_b: s1_a_to_b,
    s1_a_to_b_rate: rate(s1_a_to_b, s1.length),
    s1_acc_A: accA_s1,
    s1_acc_B: accB_s1,
    s1_delta_A_minus_B: accA_s1 != null && accB_s1 != null ? accA_s1 - accB_s1 : null,
    s1_heldout_b_to_a_rate: rate(count(s1Held, (r) => r.b_to_a), s1Held.length),
    s2_a_to_d: s2_a_to_d,
    s2_hijack_rate: rate(s2_a_to_d, s2.length),
    s2_acc_A: accA_s2,
    s2_acc_D: accD_s2,
    s2_delta_A_minus_D: accA_s2 != null && accD_s2 != null ? accA_s2 - accD_s2 : null,
    n_accuracy: rate(count(rows, (r) => r.N_correct), rows.length),
  };
}

function applyDecisionRule(summary) {
  const s = summary || {};
  const use = s.s1_b_to_a_rate != null && s.s1_b_to_a_rate >= 0.5
    && s.s1_delta_A_minus_B != null && s.s1_delta_A_minus_B > 0
    && s.s1_heldout_b_to_a_rate != null && s.s1_heldout_b_to_a_rate >= 0.5
    && s.s1_valid_n >= 2
    && s.s1_b_to_a >= 2;
  const hijack = s.s2_hijack_rate != null && s.s2_hijack_rate <= 0.20;
  return {
    demonstrated_use: !!use,
    no_routine_hijack: !!hijack,
    n_contamination_count: (s.n_pass_dropped || []).length,
    n_gate_applied: true, // N-pass cases are excluded before efficacy scoring
    verdict_eligible: !!use && !!hijack,
    scoped_sentence: "H6 for qwen3.6 (stock), h6-stratum1+2, injected-recall-block: "
      + ((use && hijack) ? "pass" : "fail")
      + " (computed offline from logs; live run is a later node).",
  };
}

function makeArmLog(assembled, raw, parsed, cfg) {
  const driver = driverConfig(cfg);
  return {
    prompt: assembled.prompt,
    messages: assembled.messages,
    model: driver.id,
    url: driver.url,
    gen_params: genParams(driver),
    raw: raw,
    parsed: parsed,
    primary_ids: assembled.primaryIds,
  };
}

async function runCase(fix, cfg) {
  const assembled = assembleArms(fix);
  const primaryBlock = assertPrimaryIdentity(assembled, fix);
  const arms = {};
  for (const arm of ARMS) {
    const raw = await callDriver(assembled[arm], cfg);
    const parsed = parseFixtureOutput(raw, fix);
    arms[arm] = makeArmLog(assembled[arm], raw, parsed, cfg);
  }
  const armParsed = {
    A: arms.A.parsed, B: arms.B.parsed, D: arms.D.parsed, N: arms.N.parsed,
  };
  return {
    id: fix.id,
    stratum: fix.stratum,
    family: fix.family,
    held_out: !!fix.held_out,
    gold: fix.gold,
    primary_block: primaryBlock,
    arms,
    eval: evaluateCase(fix, armParsed),
  };
}

async function runFixtures(fixtures, cfg) {
  const cases = [];
  for (const fix of fixtures || []) {
    cases.push(await runCase(fix, cfg));
  }
  const summary = summarize(cases.map((c) => c.eval));
  return {
    driver: {
      id: driverConfig(cfg).id,
      url: driverConfig(cfg).url,
      gen_params: genParams(driverConfig(cfg)),
    },
    cases,
    summary,
    decision: applyDecisionRule(summary),
  };
}

function replayFromLog(log, fixtures) {
  const byId = new Map((fixtures || []).map((f) => [f.id, f]));
  const cases = [];
  for (const c of (log.cases || [])) {
    const fix = byId.get(c.id);
    if (!fix) throw new Error("replay: no fixture for " + c.id);
    const assembled = assembleArms(fix);
    assertPrimaryIdentity(assembled, fix);
    const armParsed = {};
    const arms = {};
    for (const arm of ARMS) {
      const raw = c.arms && c.arms[arm] && c.arms[arm].raw;
      if (raw == null) throw new Error("replay: missing raw for " + c.id + " arm " + arm);
      const parsed = parseFixtureOutput(raw, fix);
      armParsed[arm] = parsed;
      arms[arm] = Object.assign({}, c.arms[arm], { parsed });
    }
    cases.push({
      id: fix.id,
      stratum: fix.stratum,
      family: fix.family,
      held_out: !!fix.held_out,
      gold: fix.gold,
      primary_block: assembled.A.primaryBlock,
      arms,
      eval: evaluateCase(fix, armParsed),
    });
  }
  const summary = summarize(cases.map((c) => c.eval));
  return {
    driver: log.driver || null,
    replay: true,
    cases,
    summary,
    decision: applyDecisionRule(summary),
  };
}

function printSummary(result) {
  const s = result.summary;
  const d = result.decision;
  const pct = (x) => x == null ? "n/a" : (100 * x).toFixed(1) + "%";
  console.log("H6 summary  driver=" + ((result.driver && result.driver.id) || "?")
    + (result.replay ? "  [replay]" : ""));
  console.log("  dropped N-pass: " + (s.n_pass_dropped.join(", ") || "(none)"));
  console.log("  dropped S1 B-succeeds: " + (s.b_succeeds_dropped.join(", ") || "(none)"));
  console.log("  S1 valid n=" + s.s1_valid_n + "  B→A " + s.s1_b_to_a + " (" + pct(s.s1_b_to_a_rate) + ")"
    + "  A→B " + s.s1_a_to_b + " (" + pct(s.s1_a_to_b_rate) + ")");
  console.log("  S1 acc(A)=" + pct(s.s1_acc_A) + "  acc(B)=" + pct(s.s1_acc_B)
    + "  Δ(A-B)=" + (s.s1_delta_A_minus_B == null ? "n/a" : s.s1_delta_A_minus_B.toFixed(3)));
  console.log("  S1 held-out B→A " + pct(s.s1_heldout_b_to_a_rate));
  console.log("  S2 valid n=" + s.s2_valid_n + "  A→D hijack " + s.s2_a_to_d + " (" + pct(s.s2_hijack_rate) + ")");
  console.log("  S2 acc(A)=" + pct(s.s2_acc_A) + "  acc(D)=" + pct(s.s2_acc_D)
    + "  Δ(A-D)=" + (s.s2_delta_A_minus_D == null ? "n/a" : s.s2_delta_A_minus_D.toFixed(3)));
  console.log("  N accuracy (pre-exclusion) " + pct(s.n_accuracy));
  console.log("  " + d.scoped_sentence);
}

function printAssemble(fixtures) {
  for (const fix of fixtures) {
    const assembled = assembleArms(fix);
    const block = assertPrimaryIdentity(assembled, fix);
    console.log("OK  " + fix.id + "  primary_ids=" + assembled.A.primaryIds.join(",")
      + "  primary_bytes=" + block.length
      + "  A/B/D primary identical");
  }
  console.log("Primary-identity assertion held on " + fixtures.length + " fixtures. No generation.");
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const live = args.includes("--live");
  const assembleOnly = args.includes("--assemble-only");
  const ri = args.indexOf("--replay");
  const replayPath = ri >= 0 ? args[ri + 1] : null;
  const outi = args.indexOf("--out");
  const outPath = outi >= 0 ? args[outi + 1] : null;

  const fixtures = loadAllFixtures();

  if (assembleOnly) {
    printAssemble(fixtures);
    return 0;
  }

  if (replayPath) {
    const log = JSON.parse(fs.readFileSync(replayPath, "utf8"));
    const result = replayFromLog(log, fixtures);
    printSummary(result);
    if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    return 0;
  }

  if (!live) {
    console.log("H6 harness checkpoint: live driver is gated until fixtures are GPT-audited.");
    console.log("  --assemble-only   build A/B/D/N prompts; assert primary identity; no generation");
    console.log("  --replay <log>    re-parse stored raw outputs; no generation");
    console.log("  --live            stock qwen3.6 via " + DEFAULT_DRIVER.url + " (fail-loud if down)");
    console.log("Loaded " + fixtures.length + " fixtures. Driver was not contacted.");
    return 0;
  }

  // --live is implemented so the next node can run without a harness rewrite.
  // This build's instructions are: do not invoke it.
  const result = await runFixtures(fixtures, {});
  printSummary(result);
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return 0;
}

module.exports = {
  ARMS, DEFAULT_DRIVER, SYSTEM,
  formatPrimary, formatRelated, formatRecallBlock,
  assembleArm, assembleArms, assertPrimaryIdentity,
  driverConfig, callDriver, evaluateCase, summarize, applyDecisionRule,
  runCase, runFixtures, replayFromLog, printSummary, main,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(String(e && e.stack || e));
    process.exit(2);
  });
}
