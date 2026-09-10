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
 * eval/s2v2-run.js — S2v2 consumption harness (injected recall block).
 *
 * Arms α/β/N. α and β are the counterbalanced value-swap; N is the
 * unguessability gate (same query, same block structure, filler content).
 *
 * Byte-identity inverts H6: α/β primary (and Related) MUST differ, but
 * only by the swapped value token. With X and Y masked to a sentinel the
 * two blocks are byte-identical. Throws — never generates — on any other
 * difference.
 *
 * Pair-class 2×2 + validity accounting are built in from the start
 * (LOCKED prereg). Default CLI does NOT contact the driver. --live is
 * implemented so the next node can run after GPT audits the fixtures;
 * this build must not invoke it.
 *
 *   node eval/s2v2-run.js                  # refuse live; print the checkpoint
 *   node eval/s2v2-run.js --assemble-only  # prompts + masked-identity assert
 *   node eval/s2v2-run.js --replay <log>   # re-parse stored raw outputs
 *   node eval/s2v2-run.js --audit          # static fixture checker
 *   node eval/s2v2-run.js --live           # stock qwen3.6; FAILS LOUD if down
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { parseFixtureOutput } = require("./s2v2-parse.js");
const { loadAllFixtures } = require("./s2v2-audit-check.js");

const ARMS = ["alpha", "beta", "N"];

/*
 * Default URL is the llama.cpp stack the H6 live run actually used (:8080),
 * not h6-run.js's leftover LM Studio :1234. Override with S2V2_DRIVER_URL.
 * This build does not contact it.
 */
const DEFAULT_DRIVER = {
  id: process.env.S2V2_DRIVER_MODEL || process.env.H6_DRIVER_MODEL || "qwen3.6-35B-A3B",
  url: process.env.S2V2_DRIVER_URL || process.env.H6_DRIVER_URL || "http://localhost:8080/v1/chat/completions",
  temperature: 0,
  seed: 7,
  max_tokens: 128,
  timeout_ms: Number(process.env.S2V2_DRIVER_TIMEOUT_MS) || 60000,
};

/*
 * Same system text as H6. Deliberately does NOT say Primary is
 * authoritative and does NOT say Related is associative/secondary/stale
 * — any such label turns the experiment into instruction-following.
 * The only channel distinction is the actual RM format (numbered primary,
 * then a Related: section).
 */
const SYSTEM = [
  "You are answering one factual question about a fictional person's notes.",
  "Use only the injected recall block below.",
  "Do not use world knowledge. Do not guess.",
  "Reply with a single slot value. Do not list alternatives.",
].join(" ");

const VALUE_SENTINEL = "\u0000VAL\u0000";

function renderTemplate(template, value) {
  const t = String(template == null ? "" : template);
  const hits = t.match(/\{value\}/g);
  if (!hits || hits.length !== 1) {
    throw new Error("template must contain exactly one {value} placeholder");
  }
  return t.replace("{value}", String(value));
}

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

function insertAnswer(distractors, answer, index) {
  const rows = (distractors || []).slice();
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx > rows.length) {
    throw new Error("answer_index out of range: " + JSON.stringify(index));
  }
  rows.splice(idx, 0, answer);
  return rows;
}

function primaryForArm(fix, arm) {
  if (arm === "N") return fix.n_primary;
  const value = arm === "alpha" ? fix.x : fix.y;
  const answer = { id: fix.answer_id, text: renderTemplate(fix.template, value) };
  return insertAnswer(fix.primary_distractors, answer, fix.answer_index);
}

function relatedForArm(fix, arm) {
  if (arm === "N") return fix.n_related;
  // Related carries the OTHER value — that's the matched contradiction.
  const value = arm === "alpha" ? fix.y : fix.x;
  return { id: fix.related_id, text: renderTemplate(fix.template, value) };
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
  return {
    arm,
    system: SYSTEM,
    user,
    prompt: SYSTEM + "\n\n" + user,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    primaryBlock: formatPrimary(primary),
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
 * Mask both value tokens to a sentinel. Longer token first so a pathological
 * substring pair cannot partially-mask (fixtures forbid substring pairs
 * anyway; this is belt-and-suspenders).
 */
function maskValues(text, x, y) {
  let out = String(text == null ? "" : text);
  const a = String(x == null ? "" : x);
  const b = String(y == null ? "" : y);
  const order = a.length >= b.length ? [a, b] : [b, a];
  for (const v of order) {
    if (!v) continue;
    out = out.split(v).join(VALUE_SENTINEL);
  }
  return out;
}

function stillHasValue(text, x, y) {
  const s = String(text || "");
  const a = String(x || "");
  const b = String(y || "");
  return (a && s.indexOf(a) >= 0) || (b && s.indexOf(b) >= 0);
}

/*
 * Load-bearing control. α and β primary (and Related) differ ONLY by the
 * swapped value token. With values masked they are byte-identical.
 * Throws — never continues into generation on a mismatch.
 *
 * A value-independent positional preference is channel preference by
 * design (the channel IS the format-plus-position); we preserve position
 * rather than randomizing it within a pair.
 */
function assertMaskedIdentity(assembled, fix) {
  const id = (fix && fix.id) || "(unknown)";
  const a = assembled.alpha;
  const b = assembled.beta;
  const n = assembled.N;
  if (!a || !b || !n) throw new Error(id + ": missing alpha/beta/N assembly");

  const x = fix.x;
  const y = fix.y;
  if (!x || !y || x === y) {
    throw new Error(id + ": x and y must be distinct non-empty values");
  }

  if (a.primaryBlock === b.primaryBlock) {
    throw new Error(id + ": α/β primary are identical — values did not swap");
  }
  if (a.relatedBlock === b.relatedBlock) {
    throw new Error(id + ": α/β Related are identical — values did not swap");
  }

  const aP = maskValues(a.primaryBlock, x, y);
  const bP = maskValues(b.primaryBlock, x, y);
  if (aP !== bP) {
    throw new Error(id + ": α/β primary differ by more than the value token");
  }
  const aR = maskValues(a.relatedBlock, x, y);
  const bR = maskValues(b.relatedBlock, x, y);
  if (aR !== bR) {
    throw new Error(id + ": α/β Related differ by more than the value token");
  }
  if (stillHasValue(aP, x, y) || stillHasValue(bP, x, y) ||
      stillHasValue(aR, x, y) || stillHasValue(bR, x, y)) {
    throw new Error(id + ": value token survived masking (substring leak in id/text)");
  }

  // IDs/order are identical (the answer row keeps the same id; only text swaps).
  const idsA = a.primaryIds.join("\0");
  if (idsA !== b.primaryIds.join("\0")) {
    throw new Error(id + ": α/β primary IDs/order are not identical");
  }
  if (fix && Array.isArray(fix.primary_ids)) {
    const want = fix.primary_ids.map(String).join("\0");
    if (idsA !== want) {
      throw new Error(id + ": assembled primary IDs do not match fixture.primary_ids");
    }
  }

  // N is a different block (filler), same row count.
  if (n.primaryIds.length !== a.primaryIds.length) {
    throw new Error(id + ": N primary row count " + n.primaryIds.length
      + " !== α row count " + a.primaryIds.length);
  }
  if (n.primaryBlock === a.primaryBlock || n.primaryBlock === b.primaryBlock) {
    throw new Error(id + ": N primary must be filler, not a copy of α/β");
  }
  return { primaryMasked: aP, relatedMasked: aR };
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
  const e = new Error("S2V2 DRIVER DOWN: " + msg + " — refusing to score (not a 0)");
  e.code = "S2V2_DRIVER_DOWN";
  e.cause = err;
  return e;
}

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

function isValuePick(pick) {
  return pick === "X" || pick === "Y";
}

/*
 * Channel reading of one arm. α Primary = X, β Primary = Y.
 * Returns "primary" | "related" | null (neither / invalid).
 */
function channelOf(arm, pick) {
  if (!isValuePick(pick)) return null;
  if (arm === "alpha") return pick === "X" ? "primary" : "related";
  if (arm === "beta") return pick === "Y" ? "primary" : "related";
  return null;
}

/*
 * The 2×2. Because values swap, these four cells are exhaustive for
 * pair-complete cases; PR≡XX and RP≡YY (a fixed-value answer is
 * channel-inconsistent by definition).
 */
function classifyPair(alphaPick, betaPick) {
  if (!isValuePick(alphaPick) || !isValuePick(betaPick)) return "invalid";
  if (alphaPick === "X" && betaPick === "Y") return "PP";
  if (alphaPick === "Y" && betaPick === "X") return "RR";
  if (alphaPick === "X" && betaPick === "X") return "XX";
  if (alphaPick === "Y" && betaPick === "Y") return "YY";
  return "invalid";
}

function nOutcome(nPick) {
  if (nPick === "X") return "X";
  if (nPick === "Y") return "Y";
  return "neither";
}

function evaluateCase(fix, armParsed) {
  const alpha = armParsed.alpha || {};
  const beta = armParsed.beta || {};
  const n = armParsed.N || {};
  const alphaPick = alpha.pick;
  const betaPick = beta.pick;
  const nPick = n.pick;
  const pair_class = classifyPair(alphaPick, betaPick);
  const pair_complete = pair_class !== "invalid";
  const n_outcome = nOutcome(nPick);
  const n_prior = n_outcome !== "neither";
  // Admissible for the pair-class analysis population: both channel arms
  // produced a value AND N guessed neither (N-prior is contamination).
  const analysis_admissible = pair_complete && !n_prior;
  return {
    id: fix.id,
    family: fix.family,
    held_out: !!fix.held_out,
    alpha_pick: alphaPick,
    beta_pick: betaPick,
    n_pick: nPick,
    alpha_reason: alpha.reason,
    beta_reason: beta.reason,
    n_reason: n.reason,
    alpha_channel: channelOf("alpha", alphaPick),
    beta_channel: channelOf("beta", betaPick),
    pair_class,
    pair_complete,
    n_outcome,
    n_prior,
    analysis_admissible,
  };
}

function emptyPairCounts() {
  return { PP: 0, RR: 0, XX: 0, YY: 0, invalid: 0 };
}

function summarize(caseRows) {
  const rows = caseRows || [];
  const pair_class = emptyPairCounts();
  const pair_class_n_clean = emptyPairCounts();
  let valid_channel_arms = 0;
  let primary_channel_picks = 0;
  let related_channel_picks = 0;
  const n_to_x = [];
  const n_to_y = [];
  const n_prior_ids = [];
  const invalid_pair_ids = [];
  const analysis_ids = [];

  for (const r of rows) {
    pair_class[r.pair_class] = (pair_class[r.pair_class] || 0) + 1;
    if (r.n_prior) {
      n_prior_ids.push(r.id);
      if (r.n_outcome === "X") n_to_x.push(r.id);
      if (r.n_outcome === "Y") n_to_y.push(r.id);
    }
    if (r.pair_class === "invalid") invalid_pair_ids.push(r.id);
    if (r.analysis_admissible) {
      analysis_ids.push(r.id);
      pair_class_n_clean[r.pair_class] += 1;
    }
    for (const ch of [r.alpha_channel, r.beta_channel]) {
      if (ch === "primary") {
        valid_channel_arms += 1;
        primary_channel_picks += 1;
      } else if (ch === "related") {
        valid_channel_arms += 1;
        related_channel_picks += 1;
      }
    }
  }

  const n_cases = rows.length;
  // Validity floor is over α/β only. N is not supposed to emit X/Y —
  // counting N as an "invalid arm" would make a working N-gate look like
  // a 33% validity miss. See s2v2-build-notes.md.
  const total_channel_arms = n_cases * 2;
  const invalid_channel_arms = total_channel_arms - valid_channel_arms;
  const rate = (n, d) => (d ? n / d : null);
  const pp = pair_class_n_clean.PP;
  const rr = pair_class_n_clean.RR;
  const xx = pair_class_n_clean.XX;
  const yy = pair_class_n_clean.YY;
  const analysis_n = pp + rr + xx + yy;

  return {
    n_cases,
    total_arms: total_channel_arms,
    valid_arms: valid_channel_arms,
    invalid_arms: invalid_channel_arms,
    validity_rate: rate(valid_channel_arms, total_channel_arms),
    pair_complete_cases: pair_class.PP + pair_class.RR + pair_class.XX + pair_class.YY,
    pair_class,
    pair_class_n_clean,
    analysis_n,
    analysis_ids,
    invalid_pair_ids,
    n_to_x,
    n_to_y,
    n_to_neither: n_cases - n_prior_ids.length,
    n_prior_ids,
    primary_channel_pick_rate: rate(primary_channel_picks, valid_channel_arms),
    related_channel_pick_rate: rate(related_channel_picks, valid_channel_arms),
    value_bias: {
      XX: xx,
      YY: yy,
      share: rate(xx + yy, analysis_n),
      lean: xx === yy ? "none" : (xx > yy ? "X" : "Y"),
    },
  };
}

const VALIDITY_FLOOR = 0.80;

function applyDecisionRule(summary) {
  const s = summary || {};
  const p = s.primary_channel_pick_rate;
  const counts = s.pair_class_n_clean || emptyPairCounts();
  const pp = counts.PP || 0;
  const rr = counts.RR || 0;
  const xx = counts.XX || 0;
  const yy = counts.YY || 0;
  const vb = xx + yy;
  const topChannel = Math.max(pp, rr);
  const pp_dominant = pp > rr && pp > 0;
  const rr_dominant = rr > pp && rr > 0;
  // Conservative: a tie between pooled value-bias and the leading channel
  // class is NOT a clean channel result.
  const value_bias_dominates = vb > 0 && vb >= topChannel;
  const validity_rate = s.validity_rate;
  const floor_ok = validity_rate != null && validity_rate >= VALIDITY_FLOOR;

  let verdict = "inconclusive";
  let reason = "intermediate/underpowered (a band condition unmet)";

  if (p != null && p >= 0.80 && pp_dominant && !value_bias_dominates) {
    verdict = "honored";
    reason = "p>=0.80, PP dominant, value-bias does not dominate";
  } else if (p != null && p <= 0.20 && rr_dominant && !value_bias_dominates) {
    verdict = "inverted";
    reason = "p<=0.20, RR dominant, value-bias does not dominate";
  } else if (p != null && p >= 0.40 && p <= 0.60 && !pp_dominant && !rr_dominant) {
    if (value_bias_dominates) {
      verdict = "value-biased";
      reason = "near-.50 p driven by XX/YY, not a channel split";
    } else {
      verdict = "peer";
      reason = "0.40<=p<=0.60 and neither PP nor RR dominant";
    }
  } else if (value_bias_dominates && p != null && p >= 0.40 && p <= 0.60) {
    verdict = "value-biased";
    reason = "value-bias dominates a mid-band p";
  } else {
    verdict = "inconclusive";
    reason = "intermediate/underpowered (a band condition unmet)";
  }

  const admissible = !!floor_ok;
  const reported = admissible ? verdict : "inconclusive";
  const pct = (x) => x == null ? "n/a" : x.toFixed(3);
  const scoped = "S2v2 for qwen3.6 (stock), s2v2 corpus, injected-recall: "
    + reported
    + (admissible ? "" : " (validity floor " + pct(validity_rate) + " < 0.80; would-be " + verdict + ")")
    + " (p=" + pct(p)
    + ", PP=" + pp
    + ", RR=" + rr
    + ", XX=" + xx
    + ", YY=" + yy
    + ", valid=" + (s.valid_arms || 0) + "/" + (s.total_arms || 0)
    + ").";

  return {
    verdict: reported,
    band_verdict: verdict,
    admissible,
    reason: admissible ? reason : "validity floor unmet; " + reason,
    pp_dominant,
    rr_dominant,
    value_bias_dominates,
    validity_floor: VALIDITY_FLOOR,
    scoped_sentence: scoped,
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
  assertMaskedIdentity(assembled, fix);
  const arms = {};
  for (const arm of ARMS) {
    const raw = await callDriver(assembled[arm], cfg);
    const parsed = parseFixtureOutput(raw, fix);
    arms[arm] = makeArmLog(assembled[arm], raw, parsed, cfg);
  }
  const armParsed = {
    alpha: arms.alpha.parsed,
    beta: arms.beta.parsed,
    N: arms.N.parsed,
  };
  return {
    id: fix.id,
    family: fix.family,
    held_out: !!fix.held_out,
    x: fix.x,
    y: fix.y,
    template: fix.template,
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
    assertMaskedIdentity(assembled, fix);
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
      family: fix.family,
      held_out: !!fix.held_out,
      x: fix.x,
      y: fix.y,
      template: fix.template,
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
  const pc = s.pair_class_n_clean;
  console.log("S2v2 summary  driver=" + ((result.driver && result.driver.id) || "?")
    + (result.replay ? "  [replay]" : ""));
  console.log("  validity  valid_arms=" + s.valid_arms + "/" + s.total_arms
    + " (" + pct(s.validity_rate) + ")"
    + "  pair_complete=" + s.pair_complete_cases
    + "  analysis_n (pair-complete ∩ N-clean)=" + s.analysis_n);
  console.log("  pair-class (N-clean): PP=" + pc.PP + " RR=" + pc.RR
    + " XX=" + pc.XX + " YY=" + pc.YY);
  console.log("  pair-class (raw, incl. invalid): PP=" + s.pair_class.PP
    + " RR=" + s.pair_class.RR
    + " XX=" + s.pair_class.XX
    + " YY=" + s.pair_class.YY
    + " invalid=" + s.pair_class.invalid);
  console.log("  p(primary-channel)=" + pct(s.primary_channel_pick_rate)
    + "  p(related-channel)=" + pct(s.related_channel_pick_rate)
    + "  value_bias share=" + pct(s.value_bias.share)
    + " lean=" + s.value_bias.lean);
  console.log("  N→X: " + (s.n_to_x.join(", ") || "(none)")
    + "  N→Y: " + (s.n_to_y.join(", ") || "(none)")
    + "  N→neither=" + s.n_to_neither);
  if (s.n_prior_ids.length) {
    console.log("  N-prior dropped from analysis: " + s.n_prior_ids.join(", "));
  }
  console.log("  " + d.scoped_sentence);
}

function printAssemble(fixtures) {
  for (const fix of fixtures) {
    const assembled = assembleArms(fix);
    assertMaskedIdentity(assembled, fix);
    const tX = renderTemplate(fix.template, fix.x);
    const tY = renderTemplate(fix.template, fix.y);
    console.log("OK  " + fix.id
      + "  family=" + fix.family
      + "  held_out=" + !!fix.held_out
      + "  x=" + fix.x + " y=" + fix.y
      + "  answer_index=" + fix.answer_index
      + "  primary_ids=" + assembled.alpha.primaryIds.join(",")
      + "  T(x)=" + JSON.stringify(tX)
      + "  T(y)=" + JSON.stringify(tY)
      + "  α/β masked-identical");
  }
  console.log("Masked-identity assertion held on " + fixtures.length
    + " fixtures (α/β differ only by the swapped value). No generation.");
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const live = args.includes("--live");
  const assembleOnly = args.includes("--assemble-only");
  const audit = args.includes("--audit");
  const ri = args.indexOf("--replay");
  const replayPath = ri >= 0 ? args[ri + 1] : null;
  const outi = args.indexOf("--out");
  const outPath = outi >= 0 ? args[outi + 1] : null;

  if (audit) {
    const checker = require("./s2v2-audit-check.js");
    return checker.main(args.filter((a) => a !== "--audit"));
  }

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
    console.log("S2v2 harness checkpoint: live driver is gated until fixtures are GPT-audited.");
    console.log("  --assemble-only   build α/β/N prompts; assert masked identity; no generation");
    console.log("  --replay <log>    re-parse stored raw outputs; no generation");
    console.log("  --audit           static fixture checker (mechanical vs author-asserted)");
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
  ARMS, DEFAULT_DRIVER, SYSTEM, VALIDITY_FLOOR, VALUE_SENTINEL,
  renderTemplate, formatPrimary, formatRelated, formatRecallBlock,
  primaryForArm, relatedForArm, insertAnswer,
  assembleArm, assembleArms, maskValues, assertMaskedIdentity,
  driverConfig, callDriver,
  classifyPair, channelOf, evaluateCase, summarize, applyDecisionRule,
  runCase, runFixtures, replayFromLog, printSummary, main,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(String(e && e.stack || e));
    process.exit(2);
  });
}
