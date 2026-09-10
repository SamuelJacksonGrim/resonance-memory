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
 * eval/s2v2-audit-check.js — static fixture checker for S2v2 (round 3).
 *
 * Makes the embedded audit object inspectable instead of trusted. Per case
 * it verifies what CAN be verified without a model, and it PRINTS the split
 * so a reviewer can see proven vs claimed:
 *
 *   MECHANICAL (this file):
 *     audit-object shape, template shared + single {value}, x/y distinct
 *     and absent from distractors/query/turns/N (C1 literal-span-absence),
 *     value_symmetry chars/tokens recomputed, distractors favor neither,
 *     parser well-formed, primary_ids match constructed order, answer_index
 *     in range, no expect/gate tripwire, derivation_audit SHAPE (not the
 *     marks — those are author-asserted)
 *
 *   COSINE (embedder if reachable; never a hard-fail, never a value repair):
 *     MEASURES cos(T(x), Q), cos(T(y), Q), |Δ| and WRITES them into the
 *     fixture jsonl (replace nulls). Cases with |Δ| > COSINE_DELTA_BOUND
 *     are quarantined (flagged, not repaired). Bound is FROZEN at 0.05.
 *
 *   VALUE-SYMMETRY expanded (GPT #6/#10): real BPE via /tokenize (skip if
 *     down), shared substrings/affixes/trigrams, reference-lexical flags.
 *     Hits are WARNs, never auto-fails. Do not swap values.
 *
 *   AUTHOR-ASSERTED, pending GPT:
 *     values_arbitrary justifications (why prior-free)
 *     derivation_audit path marks (C4 joint-derivation; first-pass author)
 *
 *   AUTHOR-ASSERTED, pending live driver:
 *     n_unguessable (both x and y must fail N)
 *
 * This checker CANNOT judge prior-freeness, N-unguessability, or
 * derivability. It will not pretend to.
 *
 *   node eval/s2v2-audit-check.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { normalize, hasSpan, tokenCount } = require("./h6-parse.js");
const { lookupLexical, NAMED_PRIORS } = require("./s2v2-lexicon.js");

const CORPUS = path.join(__dirname, "corpora", "s2v2.jsonl");

const PRIVILEGE_RE = /\b(unusual|unique|correct|true|actual|official|authentic|privileged|authoritative|stale|better|right answer|wrong answer)\b/i;

/*
 * COSINE_DELTA_BOUND = 0.05
 *
 * FROZEN (round 3; Ember's call). Construction rationale (prereg v2): the
 * two answer-sentences differ by exactly one meaningless pseudo-word;
 * query-alignment must come from the shared template, so swapping the
 * value may not shift query-cosine by more than ~0.05 or the value is
 * itself carrying query-alignment.
 *
 * Do NOT change this constant to keep or drop cases. Do NOT repair fixture
 * values to land under it. In-pool over the bound is quarantined (excluded
 * from analysis); held-out over the bound is reported only.
 */
const COSINE_DELTA_BOUND = 0.05;

const DERIVATION_PATHS = [
  "lexical_cue",
  "semantic_cue",
  "synonym_alias",
  "anaphora",
  "composition_of_memories",
  "world_knowledge",
  "numeric_pattern",
];
const DERIVATION_MARKS = new Set(["impossible", "possible", "derivable"]);

const GPT_NAMED_VALUES = ["sorin", "velka", "yulka", "porin"];
const CODE_FAMILY = "code";

const DEFAULT_TOKENIZE_URL = "http://localhost:8080/tokenize";

// BPE-count |Δ| >= this is "gross" asymmetry (WARN, not fail). Differing
// token IDs are expected and are never a fail.
const BPE_GROSS_COUNT_DELTA = 2;
const AFFIX_WARN_LEN = 3;
const SUBSTRING_WARN_LEN = 3;
const TRIGRAM_JACCARD_WARN = 0.25;

function readJsonl(file) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); }
    catch (e) {
      throw new Error(file + ":" + (i + 1) + " JSON parse failed: " + e.message);
    }
  });
  return out;
}

function loadAllFixtures(filePath) {
  const file = filePath || CORPUS;
  const out = [];
  for (const c of readJsonl(file)) {
    c._file = path.basename(file);
    out.push(c);
  }
  return out;
}

function asMem(x) {
  if (!x || typeof x !== "object") return null;
  if (x.id == null || x.text == null) return null;
  return { id: String(x.id), text: String(x.text) };
}

function queryContext(fix) {
  return [fix.turn_0, fix.turn_1, fix.query].filter(Boolean).join("\n");
}

function capsClass(s) {
  const t = String(s == null ? "" : s);
  if (!t) return "empty";
  if (t === t.toLowerCase()) return "lower";
  if (t === t.toUpperCase()) return "upper";
  if (t[0] === t[0].toUpperCase() && t.slice(1) === t.slice(1).toLowerCase()) return "title";
  return "mixed";
}

function templateHits(template) {
  const t = String(template == null ? "" : template);
  const m = t.match(/\{value\}/g);
  return m ? m.length : 0;
}

function renderTemplate(template, value) {
  return String(template).replace("{value}", String(value));
}

function pushMark(mechanical, errs, key, ok, detail) {
  mechanical[key] = { ok: !!ok, detail: detail || (ok ? "pass" : "fail") };
  if (!ok) errs.push(key + ": " + (detail || "fail"));
  return !!ok;
}

function checkShape(fix, errs, mechanical) {
  const mark = (key, ok, detail) => pushMark(mechanical, errs, key, ok, detail);

  mark("id", !!(fix && fix.id && /^s2v2-/.test(String(fix.id))),
    fix && fix.id ? String(fix.id) : "missing id (want s2v2-*)");
  mark("kind_s2v2", fix.kind === "s2v2",
    "kind=" + JSON.stringify(fix.kind) + " (must be s2v2 so RM-00 ignores it)");
  mark("no_expect", fix.expect == null,
    fix.expect == null ? "no expect" : "HAS expect — would threaten golden");
  mark("gate_false", fix.gate === false, "gate=" + JSON.stringify(fix.gate));
  mark("family", typeof fix.family === "string" && fix.family.length > 0,
    "family=" + JSON.stringify(fix.family));
  mark("held_out", typeof fix.held_out === "boolean",
    "held_out=" + JSON.stringify(fix.held_out));
  mark("query", typeof fix.query === "string" && fix.query.trim(), "query present");

  const hits = templateHits(fix.template);
  mark("template_shared",
    typeof fix.template === "string" && hits === 1,
    "template=" + JSON.stringify(fix.template) + " {value}_count=" + hits);

  const xOk = typeof fix.x === "string" && String(fix.x).trim();
  const yOk = typeof fix.y === "string" && String(fix.y).trim();
  mark("values_present", !!(xOk && yOk), "x=" + JSON.stringify(fix.x) + " y=" + JSON.stringify(fix.y));
  mark("values_distinct", xOk && yOk && normalize(fix.x) !== normalize(fix.y),
    "x=" + fix.x + " y=" + fix.y);
  if (xOk && yOk) {
    const sub = hasSpan(fix.x, fix.y) || hasSpan(fix.y, fix.x);
    mark("values_not_substrings", !sub,
      sub ? "one value is a span of the other" : "neither is a span of the other");
  }

  const dist = fix.primary_distractors;
  mark("primary_distractors",
    Array.isArray(dist) && dist.length >= 4 && dist.length <= 5
      && dist.every((m) => asMem(m)),
    "n=" + ((dist && dist.length) || 0) + " (want 4–5 id+text rows)");
  mark("answer_id", typeof fix.answer_id === "string" && String(fix.answer_id).trim(),
    "answer_id=" + JSON.stringify(fix.answer_id));
  mark("related_id", typeof fix.related_id === "string" && String(fix.related_id).trim(),
    "related_id=" + JSON.stringify(fix.related_id));

  const nDist = Array.isArray(dist) ? dist.length : 0;
  const idx = fix.answer_index;
  mark("answer_index",
    Number.isInteger(idx) && idx >= 0 && idx <= nDist,
    "answer_index=" + JSON.stringify(idx) + " distractors=" + nDist);

  mark("primary_ids_array",
    Array.isArray(fix.primary_ids) && fix.primary_ids.length === nDist + 1,
    "primary_ids n=" + ((fix.primary_ids || []).length) + " want " + (nDist + 1));
  mark("n_primary",
    Array.isArray(fix.n_primary) && fix.n_primary.length === nDist + 1
      && fix.n_primary.every((m) => asMem(m)),
    "n_primary=" + ((fix.n_primary || []).length) + " want " + (nDist + 1));
  mark("n_related", !!(asMem(fix.n_related)), "n_related id+text");

  const audit = fix.audit || {};
  mark("audit_values_arbitrary", audit.values_arbitrary === true,
    "values_arbitrary=" + JSON.stringify(audit.values_arbitrary));
  mark("audit_justification_x",
    typeof audit.values_arbitrary_x === "string" && audit.values_arbitrary_x.trim(),
    "justification x present");
  mark("audit_justification_y",
    typeof audit.values_arbitrary_y === "string" && audit.values_arbitrary_y.trim(),
    "justification y present");
  mark("audit_absent_distractors_field", audit.values_absent_from_distractors === true,
    "values_absent_from_distractors=" + JSON.stringify(audit.values_absent_from_distractors));
  mark("audit_absent_query_field", audit.values_absent_from_query === true,
    "values_absent_from_query=" + JSON.stringify(audit.values_absent_from_query));
  mark("audit_template_shared_field", audit.template_shared === true,
    "template_shared=" + JSON.stringify(audit.template_shared));
  mark("audit_n_unguessable_field", audit.n_unguessable === true,
    "n_unguessable=" + JSON.stringify(audit.n_unguessable));

  const vs = audit.value_symmetry || {};
  mark("audit_value_symmetry_shape",
    Number.isInteger(vs.x_chars) && Number.isInteger(vs.y_chars)
      && Number.isInteger(vs.x_tokens) && Number.isInteger(vs.y_tokens)
      && typeof vs.x_caps === "string" && typeof vs.y_caps === "string"
      && typeof vs.lexical_class === "string" && vs.lexical_class.trim(),
    "value_symmetry keys present");

  const cos = audit.cosine || {};
  const cosOk = (v) => v === null || v === undefined || (typeof v === "number" && Number.isFinite(v));
  mark("audit_cosine_shape",
    cos && typeof cos === "object" && cosOk(cos.cos_x_q) && cosOk(cos.cos_y_q) && cosOk(cos.abs_delta),
    "cosine fields number-or-null (measured when embedder up; never fabricate)");
  if (typeof cos.cos_x_q === "number" && typeof cos.cos_y_q === "number"
      && typeof cos.abs_delta === "number") {
    const expect = Math.abs(cos.cos_x_q - cos.cos_y_q);
    const close = Math.abs(expect - cos.abs_delta) <= 1e-5;
    mark("audit_cosine_delta_consistent", close,
      "abs_delta=" + cos.abs_delta + " |cos_x-cos_y|=" + expect);
  }

  checkDerivationShape(audit.derivation_audit, mark);
}

function checkDerivationShape(da, mark) {
  const present = da && typeof da === "object";
  mark("derivation_audit_present", present,
    present ? "object present" : "missing derivation_audit (C4 first-pass required)");
  if (!present) return;

  const just = typeof da.justification === "string" && da.justification.trim();
  mark("derivation_audit_justification", !!just,
    just ? "justification non-empty" : "justification missing/empty");

  for (const side of ["X", "Y"]) {
    const block = da[side];
    const okBlock = block && typeof block === "object";
    mark("derivation_audit_" + side + "_present", okBlock,
      okBlock ? side + " marks present" : "missing " + side + " path marks");
    if (!okBlock) continue;
    const missing = [];
    const bad = [];
    for (const p of DERIVATION_PATHS) {
      if (!Object.prototype.hasOwnProperty.call(block, p)) missing.push(p);
      else if (!DERIVATION_MARKS.has(block[p])) bad.push(p + "=" + JSON.stringify(block[p]));
    }
    mark("derivation_audit_" + side + "_paths", missing.length === 0 && bad.length === 0,
      missing.length || bad.length
        ? ("missing=[" + missing.join(",") + "] invalid=[" + bad.join(",") + "]")
        : "all 7 paths marked ∈ {impossible,possible,derivable}");
  }
}

function constructedPrimaryIds(fix) {
  const dist = fix.primary_distractors || [];
  const ids = dist.map((m) => String(m && m.id));
  const idx = Number(fix.answer_index);
  ids.splice(idx, 0, String(fix.answer_id));
  return ids;
}

function checkPrimaryIds(fix, errs, mechanical) {
  const got = constructedPrimaryIds(fix);
  const want = (fix.primary_ids || []).map(String);
  const ok = got.length === want.length && got.every((id, i) => id === want[i]);
  pushMark(mechanical, errs, "primary_ids_match", ok,
    ok ? got.join(",") : "constructed=[" + got.join(",") + "] primary_ids=[" + want.join(",") + "]");

  const relatedId = fix.related_id != null ? String(fix.related_id) : "";
  const clash = relatedId && got.includes(relatedId);
  pushMark(mechanical, errs, "related_id_not_in_primary", !clash,
    clash ? "related_id " + relatedId + " is also a primary id (Related excludes primary ids)" : "distinct");
}

function checkAbsenceAndSymmetry(fix, errs, mechanical) {
  const x = String(fix.x || "");
  const y = String(fix.y || "");
  const distTexts = (fix.primary_distractors || []).map((m) => String(m && m.text || ""));
  const distIds = (fix.primary_distractors || []).map((m) => String(m && m.id || ""));
  const qctx = queryContext(fix);
  const nPrimaries = (fix.n_primary || []).map((m) => String(m && m.text || ""));
  const nRelated = asMem(fix.n_related);
  const nAll = nPrimaries.concat(nRelated ? [nRelated.text] : []);

  const xInDist = distTexts.some((t) => hasSpan(t, x)) || distIds.some((id) => hasSpan(id, x));
  const yInDist = distTexts.some((t) => hasSpan(t, y)) || distIds.some((id) => hasSpan(id, y));
  pushMark(mechanical, errs, "values_absent_from_distractors", !xInDist && !yInDist,
    "x_in_dist=" + xInDist + " y_in_dist=" + yInDist);

  const xInQ = hasSpan(qctx, x);
  const yInQ = hasSpan(qctx, y);
  pushMark(mechanical, errs, "values_absent_from_query", !xInQ && !yInQ,
    "x_in_query_or_turns=" + xInQ + " y_in_query_or_turns=" + yInQ);

  // C1 reconfirm (GPT audit #7): literal span absence is the mechanical
  // half of joint-derivation. The checker does not judge C4 marks.
  pushMark(mechanical, errs, "c1_literal_span_absence",
    !xInDist && !yInDist && !xInQ && !yInQ,
    "C1 = values absent from distractors AND query/turns");

  const xInN = nAll.some((t) => hasSpan(t, x));
  const yInN = nAll.some((t) => hasSpan(t, y));
  pushMark(mechanical, errs, "n_surfaces_clean", !xInN && !yInN,
    "x_in_N=" + xInN + " y_in_N=" + yInN);

  const skipHit = distTexts.some((t) =>
    /\b(ignore this|irrelevant|unrelated to the (question|query)|nothing relevant|skip this|do not (read|use))\b/i.test(t)
  );
  pushMark(mechanical, errs, "distractors_not_skip_cue", !skipHit,
    skipHit ? "a distractor matches a skip-cue regex" : "no skip-cue strings");

  const privilegeHit = PRIVILEGE_RE.test(String(fix.template || ""));
  pushMark(mechanical, errs, "template_not_privileging", !privilegeHit,
    privilegeHit
      ? "template contains a privileging adjective (unusual/correct/true/…)"
      : "no privileging adjectives");

  const vs = (fix.audit && fix.audit.value_symmetry) || {};
  const xChars = x.length;
  const yChars = y.length;
  const xTok = tokenCount(x);
  const yTok = tokenCount(y);
  const xCaps = capsClass(x);
  const yCaps = capsClass(y);

  pushMark(mechanical, errs, "symmetry_chars",
    xChars === yChars && vs.x_chars === xChars && vs.y_chars === yChars,
    "x_chars=" + xChars + " y_chars=" + yChars
      + " recorded=(" + vs.x_chars + "," + vs.y_chars + ")");
  pushMark(mechanical, errs, "symmetry_tokens",
    xTok === yTok && vs.x_tokens === xTok && vs.y_tokens === yTok,
    "x_tokens=" + xTok + " y_tokens=" + yTok
      + " recorded=(" + vs.x_tokens + "," + vs.y_tokens + ")  (whitespace; BPE is author-asserted)");
  pushMark(mechanical, errs, "symmetry_caps",
    xCaps === yCaps && vs.x_caps === xCaps && vs.y_caps === yCaps,
    "x_caps=" + xCaps + " y_caps=" + yCaps
      + " recorded=(" + vs.x_caps + "," + vs.y_caps + ")");
  pushMark(mechanical, errs, "symmetry_lexical_class",
    typeof vs.lexical_class === "string" && !!vs.lexical_class.trim(),
    "lexical_class=" + JSON.stringify(vs.lexical_class) + " (author tag; not a semantic judge)");

  // Author-asserted false on a mechanical field rejects the fixture.
  const audit = fix.audit || {};
  if (audit.values_absent_from_distractors === false) {
    errs.push("author-asserted values_absent_from_distractors=false (drop or fix; no grandfathering)");
  }
  if (audit.values_absent_from_query === false) {
    errs.push("author-asserted values_absent_from_query=false (drop or fix; no grandfathering)");
  }
}

function authorMap(fix) {
  const audit = fix.audit || {};
  const da = audit.derivation_audit || {};
  return {
    values_arbitrary: {
      asserted: audit.values_arbitrary,
      x: audit.values_arbitrary_x,
      y: audit.values_arbitrary_y,
      pending: "GPT semantic review",
      note: "invented / prior-free? a world-knowledge or name-class prior is contamination",
    },
    n_unguessable: {
      asserted: audit.n_unguessable,
      pending: "live N-arm (drop if N emits X or Y)",
      note: "both x and y must fail under N; N→X/Y/neither is recorded as a token-prior diagnostic",
    },
    derivation_audit: {
      pending: "GPT C4 mark (author first-pass; drop any path marked possible/derivable)",
      justification: da.justification || null,
      X: da.X || null,
      Y: da.Y || null,
      note: "checker validates SHAPE only; marks are author-asserted, not judged",
    },
  };
}

function checkFixture(fix) {
  const errs = [];
  const mechanical = {};
  if (!fix || typeof fix !== "object") {
    return {
      id: "(invalid)",
      ok: false,
      family: null,
      held_out: null,
      mechanical,
      asserted: {},
      errors: ["fixture is not an object"],
    };
  }
  checkShape(fix, errs, mechanical);
  checkPrimaryIds(fix, errs, mechanical);
  checkAbsenceAndSymmetry(fix, errs, mechanical);
  const asserted = authorMap(fix);
  return {
    id: fix.id || "(missing id)",
    ok: errs.length === 0,
    family: fix.family,
    held_out: !!fix.held_out,
    mechanical,
    asserted,
    errors: errs,
  };
}

function checkCorpusBalance(fixtures) {
  const flags = [];
  const n = (fixtures || []).length;
  const families = {};
  const held = { true: 0, false: 0 };
  const chars = {};
  let xLtY = 0;
  let xGtY = 0;
  let xEqY = 0;
  const answerIndex = {};
  const seenValues = new Map();
  const heldFamilies = [];

  for (const f of fixtures || []) {
    families[f.family] = (families[f.family] || 0) + 1;
    held[!!f.held_out] = (held[!!f.held_out] || 0) + 1;
    if (f.held_out) heldFamilies.push(f.family);
    const c = String(f.x || "").length;
    chars[c] = (chars[c] || 0) + 1;
    const cmp = String(f.x || "").localeCompare(String(f.y || ""));
    if (cmp < 0) xLtY += 1;
    else if (cmp > 0) xGtY += 1;
    else xEqY += 1;
    const idx = f.answer_index;
    answerIndex[idx] = (answerIndex[idx] || 0) + 1;
    for (const v of [f.x, f.y]) {
      const k = normalize(v);
      if (!k) continue;
      if (!seenValues.has(k)) seenValues.set(k, []);
      seenValues.get(k).push(f.id);
    }
  }

  if (n < 20) flags.push("corpus n=" + n + " < 20 (prereg floor)");
  if (n !== 29) flags.push("corpus n=" + n + " (round 3: 24 original + 5 in-pool headroom = 29)");
  if ((held.true || 0) < 5) flags.push("held_out=" + (held.true || 0) + " < 5");
  for (const [fam, c] of Object.entries(families)) {
    if (c > 8) flags.push("family " + fam + " has " + c + " cases (>8, gross skew)");
  }
  for (const [len, c] of Object.entries(chars)) {
    if (c > 14) flags.push("value length " + len + " chars covers " + c + "/" + n + " cases");
  }
  if (Math.abs(xLtY - xGtY) > 12) {
    flags.push("x<y vs x>y is " + xLtY + "/" + xGtY + " (gross assignment skew)");
  }
  const uniqueIdx = Object.keys(answerIndex);
  if (n >= 8 && uniqueIdx.length === 1) {
    flags.push("every case has answer_index=" + uniqueIdx[0] + " (held-out should vary structure)");
  }
  for (const [v, ids] of seenValues.entries()) {
    if (ids.length > 1) flags.push("value token " + JSON.stringify(v) + " reused in " + ids.join(","));
  }
  const inpoolFam = [...new Set((fixtures || []).filter((f) => !f.held_out).map((f) => f.family))];
  const heldFam = [...new Set(heldFamilies)];
  const overlap = heldFam.filter((h) => inpoolFam.includes(h));
  if (overlap.length) {
    flags.push("held-out family reuses in-pool family tag: " + overlap.join(","));
  }

  return {
    ok: flags.length === 0,
    flags,
    tallies: {
      n,
      families,
      held_out: held.true || 0,
      in_pool: held.false || 0,
      value_chars: chars,
      x_lt_y: xLtY,
      x_gt_y: xGtY,
      x_eq_y: xEqY,
      answer_index: answerIndex,
      held_out_families: heldFam,
      in_pool_families: inpoolFam,
    },
  };
}

function longestCommonPrefix(a, b) {
  const x = String(a == null ? "" : a).toLowerCase();
  const y = String(b == null ? "" : b).toLowerCase();
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return x.slice(0, i);
}

function longestCommonSuffix(a, b) {
  const x = String(a == null ? "" : a).toLowerCase();
  const y = String(b == null ? "" : b).toLowerCase();
  let i = 0;
  while (i < x.length && i < y.length && x[x.length - 1 - i] === y[y.length - 1 - i]) i++;
  return i ? x.slice(x.length - i) : "";
}

function longestCommonSubstring(a, b) {
  const x = String(a == null ? "" : a).toLowerCase();
  const y = String(b == null ? "" : b).toLowerCase();
  let best = "";
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < y.length; j++) {
      let k = 0;
      while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
      if (k > best.length) best = x.slice(i, i + k);
    }
  }
  return best;
}

function charTrigrams(s) {
  const t = String(s == null ? "" : s).toLowerCase();
  const set = new Set();
  if (t.length < 3) return set;
  for (let i = 0; i <= t.length - 3; i++) set.add(t.slice(i, i + 3));
  return set;
}

function trigramJaccard(a, b) {
  const A = charTrigrams(a);
  const B = charTrigrams(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

function utf8Bytes(s) {
  return Buffer.byteLength(String(s == null ? "" : s), "utf8");
}

function cosineDeltaOf(fix) {
  const c = fix && fix.audit && fix.audit.cosine;
  if (!c || c.abs_delta == null) return null;
  const n = Number(c.abs_delta);
  return Number.isFinite(n) ? n : null;
}

function isCosineQuarantined(fix, bound) {
  const b = bound == null ? COSINE_DELTA_BOUND : bound;
  const d = cosineDeltaOf(fix);
  return d != null && d > b;
}

function round6(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return Number(Number(x).toFixed(6));
}

function tokenizeUrl() {
  return process.env.S2V2_TOKENIZE_URL || DEFAULT_TOKENIZE_URL;
}

function parseTokenIds(json) {
  if (!json) return null;
  const raw = json.tokens != null ? json.tokens
    : (json.token_ids != null ? json.token_ids : null);
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.map((t) => {
    if (typeof t === "number" && Number.isFinite(t)) return t;
    if (t && typeof t === "object") {
      if (typeof t.id === "number") return t.id;
      if (typeof t.token === "number") return t.token;
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  });
}

async function tryTokenize(text, timeoutMs) {
  const url = tokenizeUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: String(text), add_special: false }),
    signal: AbortSignal.timeout(timeoutMs || 2500),
  });
  if (!res || !res.ok) {
    throw new Error("HTTP " + (res ? res.status : "no-response") + " from " + url);
  }
  const json = await res.json();
  const ids = parseTokenIds(json);
  if (!ids) throw new Error("tokenize returned no token ids");
  return ids;
}

async function tokenizeAudit(fixtures) {
  const url = tokenizeUrl();
  let probe;
  try {
    probe = await tryTokenize("s2v2", 2500);
  } catch (e) {
    return {
      skipped: true,
      reason: "tokenizer unreachable at " + url + " (" + (e && e.message || e) + ")",
      url,
      rows: [],
    };
  }
  if (!probe) {
    return { skipped: true, reason: "tokenizer returned no tokens", url, rows: [] };
  }

  const rows = [];
  for (const fix of fixtures || []) {
    const row = { id: fix.id, x: fix.x, y: fix.y, x_ids: null, y_ids: null, error: null };
    try {
      row.x_ids = await tryTokenize(fix.x, 4000);
      row.y_ids = await tryTokenize(fix.y, 4000);
    } catch (e) {
      row.error = String(e && e.message || e);
    }
    rows.push(row);
  }
  return { skipped: false, reason: null, url, rows };
}

function valuePairAudit(fix, bpeRow) {
  const x = String(fix.x || "");
  const y = String(fix.y || "");
  const lcp = longestCommonPrefix(x, y);
  const lcsuf = longestCommonSuffix(x, y);
  const lcsub = longestCommonSubstring(x, y);
  const jac = trigramJaccard(x, y);
  const xLex = lookupLexical(x);
  const yLex = lookupLexical(y);
  const xBytes = utf8Bytes(x);
  const yBytes = utf8Bytes(y);
  const xBpe = bpeRow && bpeRow.x_ids ? bpeRow.x_ids.length : null;
  const yBpe = bpeRow && bpeRow.y_ids ? bpeRow.y_ids.length : null;
  const bpeDelta = (xBpe != null && yBpe != null) ? Math.abs(xBpe - yBpe) : null;

  const warns = [];
  if (lcp.length >= AFFIX_WARN_LEN) {
    warns.push("LCP=" + JSON.stringify(lcp) + " (len " + lcp.length + ")");
  }
  if (lcsuf.length >= AFFIX_WARN_LEN) {
    warns.push("LCsuffix=" + JSON.stringify(lcsuf) + " (len " + lcsuf.length + ")");
  }
  if (lcsub.length >= SUBSTRING_WARN_LEN) {
    warns.push("LCsubstring=" + JSON.stringify(lcsub) + " (len " + lcsub.length + ")");
  }
  if (jac >= TRIGRAM_JACCARD_WARN) {
    warns.push("trigram Jaccard=" + jac.toFixed(3) + " (>= " + TRIGRAM_JACCARD_WARN + ")");
  }
  if (xBytes !== yBytes) {
    warns.push("utf8-byte length x=" + xBytes + " y=" + yBytes);
  }
  if (bpeDelta != null && bpeDelta >= 1) {
    const gross = bpeDelta >= BPE_GROSS_COUNT_DELTA ? "GROSS " : "";
    warns.push(gross + "BPE-count asymmetry x=" + xBpe + " y=" + yBpe
      + " |Δ|=" + bpeDelta
      + (bpeDelta >= BPE_GROSS_COUNT_DELTA
        ? " (gross >= " + BPE_GROSS_COUNT_DELTA + ")"
        : " (any count Δ is a human look)"));
  }
  if (xLex.hit) warns.push("X=" + JSON.stringify(x) + " LEXICAL HIT (" + xLex.kind + "): " + xLex.detail);
  if (yLex.hit) warns.push("Y=" + JSON.stringify(y) + " LEXICAL HIT (" + yLex.kind + "): " + yLex.detail);
  if (fix.family === CODE_FAMILY) {
    warns.push("code-family: query asks for a 'code'; values are name-like (family-level format clash; intra-pair code-ness judged symmetric at freeze — not auto-fail)");
  }

  return {
    id: fix.id,
    family: fix.family,
    held_out: !!fix.held_out,
    x, y,
    x_chars: x.length, y_chars: y.length,
    x_bytes: xBytes, y_bytes: yBytes,
    x_caps: capsClass(x), y_caps: capsClass(y),
    lcp, lcsuf, lcsub, trigram_jaccard: jac,
    x_lexical: xLex, y_lexical: yLex,
    x_bpe_count: xBpe, y_bpe_count: yBpe,
    x_bpe_ids: bpeRow && bpeRow.x_ids || null,
    y_bpe_ids: bpeRow && bpeRow.y_ids || null,
    bpe_count_delta: bpeDelta,
    bpe_error: bpeRow && bpeRow.error || null,
    warns,
  };
}

function emitFixtureLine(fix) {
  const copy = Object.assign({}, fix);
  delete copy._file;
  return JSON.stringify(copy);
}

function writeCorpus(fixtures, filePath) {
  const file = filePath || CORPUS;
  const body = (fixtures || []).map(emitFixtureLine).join("\n") + "\n";
  fs.writeFileSync(file, body);
  return file;
}

function applyMeasuredCosine(fixtures, cosineReport) {
  if (!cosineReport || cosineReport.skipped) return { wrote: false, n: 0 };
  const byId = new Map((cosineReport.rows || []).map((r) => [r.id, r]));
  let n = 0;
  for (const fix of fixtures || []) {
    const row = byId.get(fix.id);
    if (!row || row.error || row.cos_x_q == null || row.cos_y_q == null) continue;
    if (!fix.audit) fix.audit = {};
    fix.audit.cosine = {
      cos_x_q: round6(row.cos_x_q),
      cos_y_q: round6(row.cos_y_q),
      abs_delta: round6(row.abs_delta),
    };
    n += 1;
  }
  return { wrote: n > 0, n };
}

function quarantineList(fixtures, bound) {
  const b = bound == null ? COSINE_DELTA_BOUND : bound;
  const rows = [];
  for (const f of fixtures || []) {
    const d = cosineDeltaOf(f);
    if (d != null && d > b) {
      rows.push({
        id: f.id,
        held_out: !!f.held_out,
        abs_delta: d,
        cos_x_q: f.audit && f.audit.cosine && f.audit.cosine.cos_x_q,
        cos_y_q: f.audit && f.audit.cosine && f.audit.cosine.cos_y_q,
      });
    }
  }
  rows.sort((a, b2) => (b2.abs_delta || 0) - (a.abs_delta || 0));
  return rows;
}

function formatReport(result) {
  const lines = [];
  const flag = result.ok ? "OK  " : "FAIL";
  lines.push(flag + "  " + result.id
    + "  family=" + result.family
    + "  held_out=" + result.held_out);
  lines.push("  MECHANICAL (this checker):");
  for (const k of Object.keys(result.mechanical)) {
    const m = result.mechanical[k];
    const st = m.ok ? "PASS" : "FAIL";
    lines.push("    " + st.padEnd(4) + "  " + k + "  " + m.detail);
  }
  lines.push("  AUTHOR-ASSERTED, pending GPT semantic review:");
  {
    const a = result.asserted.values_arbitrary;
    lines.push("    asserted=" + a.asserted + "  values_arbitrary  pending=" + a.pending);
    lines.push("      x: " + a.x);
    lines.push("      y: " + a.y);
    lines.push("      " + a.note);
  }
  lines.push("  AUTHOR-ASSERTED, pending live driver:");
  {
    const a = result.asserted.n_unguessable;
    lines.push("    asserted=" + a.asserted + "  n_unguessable  pending=" + a.pending);
    lines.push("      " + a.note);
  }
  lines.push("  AUTHOR-ASSERTED, pending GPT C4 (shape checked; marks not judged):");
  {
    const a = result.asserted.derivation_audit;
    lines.push("    pending=" + a.pending);
    lines.push("    justification: " + (a.justification || "(missing)"));
    const fmt = (side) => {
      const b = a[side];
      if (!b) return "      " + side + ": (missing)";
      return "      " + side + ": " + DERIVATION_PATHS.map((p) => p + "=" + b[p]).join(" ");
    };
    lines.push(fmt("X"));
    lines.push(fmt("Y"));
    lines.push("      " + a.note);
  }
  if (result.errors.length) {
    lines.push("  ERRORS:");
    for (const e of result.errors) lines.push("    - " + e);
  }
  return lines.join("\n");
}

function checkAll(fixtures) {
  return (fixtures || []).map(checkFixture);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : null;
}

function embedUrl() {
  return process.env.EMBED_ENDPOINT || "http://localhost:1234/v1/embeddings";
}

function embedModel() {
  return process.env.EMBED_MODEL || "text-embedding-nomic-embed-text-v1.5";
}

async function tryEmbed(texts, timeoutMs) {
  const url = embedUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: embedModel(), input: texts }),
    signal: AbortSignal.timeout(timeoutMs || 2500),
  });
  if (!res || !res.ok) {
    throw new Error("HTTP " + (res ? res.status : "no-response") + " from " + url);
  }
  const json = await res.json();
  const data = (json && json.data) || [];
  return data.sort((a, b) => (a.index || 0) - (b.index || 0)).map((d) => d.embedding);
}

async function cosineAudit(fixtures) {
  const url = embedUrl();
  let probe;
  try {
    probe = await tryEmbed(["s2v2 cosine probe"], 2500);
  } catch (e) {
    return {
      skipped: true,
      reason: "embedder unreachable at " + url + " (" + (e && e.message || e) + ")",
      rows: [],
    };
  }
  if (!probe || !probe[0]) {
    return { skipped: true, reason: "embedder returned no embedding", rows: [] };
  }

  const rows = [];
  for (const fix of fixtures || []) {
    const tx = renderTemplate(fix.template, fix.x);
    const ty = renderTemplate(fix.template, fix.y);
    const q = String(fix.query || "");
    let vecs;
    try {
      vecs = await tryEmbed([tx, ty, q], 8000);
    } catch (e) {
      rows.push({
        id: fix.id,
        error: String(e && e.message || e),
        cos_x_q: null, cos_y_q: null, abs_delta: null,
      });
      continue;
    }
    const cx = cosine(vecs[0], vecs[2]);
    const cy = cosine(vecs[1], vecs[2]);
    const abs = (cx != null && cy != null) ? Math.abs(cx - cy) : null;
    rows.push({
      id: fix.id,
      cos_x_q: cx, cos_y_q: cy, abs_delta: abs,
      t_x: tx, t_y: ty, query: q,
    });
  }
  rows.sort((a, b) => (b.abs_delta || 0) - (a.abs_delta || 0));
  return { skipped: false, reason: null, url, model: embedModel(), rows };
}

function formatCosine(report, fixtures) {
  const lines = [];
  lines.push("  COSINE (MEASURED; bound FROZEN at 0.05):");
  lines.push("    COSINE_DELTA_BOUND=" + COSINE_DELTA_BOUND
    + "  (do not retune to keep/drop cases; in-pool over bound quarantined, held-out reported only)");
  if (!report) {
    lines.push("    (no cosine report)");
    return lines.join("\n");
  }
  if (report.skipped) {
    lines.push("    skipped  " + report.reason);
    lines.push("    existing fixture cosine values left untouched (never fabricate)");
  } else {
    lines.push("    embedder=" + report.url + "  model=" + report.model);
    if (report.wrote) {
      lines.push("    wrote measured cosine into " + path.basename(CORPUS)
        + " (" + report.wrote_n + " fixtures)");
    }
    lines.push("    sorted worst |Δ| first:");
    for (const r of report.rows) {
      if (r.error) {
        lines.push("    ERR   " + r.id + "  " + r.error);
        continue;
      }
      const n = (x) => x == null ? "n/a" : x.toFixed(4);
      const over = r.abs_delta != null && r.abs_delta > COSINE_DELTA_BOUND;
      const held = (fixtures || []).find((f) => f.id === r.id);
      const tag = over
        ? (held && held.held_out ? "  QUARANTINE (held-out, reported only)"
          : "  QUARANTINE (in-pool, excluded from analysis)")
        : "";
      lines.push("    " + n(r.abs_delta).padEnd(8) + "  " + r.id
        + "  cos(T(x),Q)=" + n(r.cos_x_q)
        + "  cos(T(y),Q)=" + n(r.cos_y_q)
        + tag);
    }
  }
  const q = quarantineList(fixtures);
  const qIn = q.filter((r) => !r.held_out);
  const qHeld = q.filter((r) => r.held_out);
  lines.push("    quarantined_by_cosine n=" + q.length
    + "  in-pool=" + qIn.length
    + "  held-out=" + qHeld.length);
  if (qIn.length) {
    lines.push("    in-pool excluded from analysis: "
      + qIn.map((r) => r.id + "(" + r.abs_delta.toFixed(4) + ")").join(", "));
  }
  if (qHeld.length) {
    lines.push("    held-out reported only: "
      + qHeld.map((r) => r.id + "(" + r.abs_delta.toFixed(4) + ")").join(", "));
  }
  return lines.join("\n");
}

function formatSymmetry(pairs, tokenizeReport) {
  const lines = [];
  lines.push("  VALUE-SYMMETRY EXPANDED (GPT #6/#10) — WARNs are flags, not auto-fails:");
  if (tokenizeReport && tokenizeReport.skipped) {
    lines.push("    BPE /tokenize skipped  " + tokenizeReport.reason);
  } else if (tokenizeReport) {
    lines.push("    BPE tokenizer=" + tokenizeReport.url
      + "  (differing token IDs are expected, not a fail)");
  }
  const warnRows = (pairs || []).filter((p) => p.warns.length);
  if (!warnRows.length) {
    lines.push("    no WARNs");
  }
  for (const p of pairs || []) {
    const bpe = (p.x_bpe_count == null)
      ? "bpe=n/a"
      : ("bpe x=" + p.x_bpe_count
        + " y=" + p.y_bpe_count
        + " ids_x=" + JSON.stringify(p.x_bpe_ids)
        + " ids_y=" + JSON.stringify(p.y_bpe_ids));
    lines.push("    " + p.id + "  x=" + p.x + " y=" + p.y
      + "  chars=" + p.x_chars + "/" + p.y_chars
      + "  bytes=" + p.x_bytes + "/" + p.y_bytes
      + "  LCP=" + JSON.stringify(p.lcp)
      + "  LCsuf=" + JSON.stringify(p.lcsuf)
      + "  LCsub=" + JSON.stringify(p.lcsub)
      + "  triJ=" + (p.trigram_jaccard == null ? "n/a" : p.trigram_jaccard.toFixed(3))
      + "  " + bpe);
    for (const w of p.warns) lines.push("      WARN  " + w);
  }
  return lines.join("\n");
}

function formatNamedValues(fixtures, pairs) {
  const lines = [];
  lines.push("  GPT-NAMED VALUES (always surfaced):");
  const byVal = new Map();
  for (const f of fixtures || []) {
    for (const side of ["x", "y"]) {
      const v = String(f[side] || "").toLowerCase();
      if (!byVal.has(v)) byVal.set(v, []);
      byVal.get(v).push(f.id + "." + side);
    }
  }
  for (const name of GPT_NAMED_VALUES) {
    const uses = byVal.get(name) || [];
    const prior = NAMED_PRIORS[name];
    const pair = (pairs || []).find((p) => p.x.toLowerCase() === name || p.y.toLowerCase() === name);
    const hit = pair
      ? (pair.x.toLowerCase() === name ? pair.x_lexical : pair.y_lexical)
      : lookupLexical(name);
    lines.push("    " + name
      + "  used=" + (uses.join(",") || "(not in corpus)")
      + "  " + (hit.hit ? ("LEXICAL HIT (" + hit.kind + "): " + hit.detail) : "no lexicon hit")
      + (prior && !hit.hit ? "  [named_prior: " + prior + "]" : ""));
  }
  const code = (fixtures || []).filter((f) => f.family === CODE_FAMILY);
  lines.push("    code-family pairs: "
    + (code.length
      ? code.map((f) => f.id + " x=" + f.x + " y=" + f.y).join("; ")
      : "(none)"));
  return lines.join("\n");
}

function formatBalance(bal) {
  const t = bal.tallies;
  const lines = [];
  lines.push("  RANDOMIZATION BALANCE:");
  lines.push("    n=" + t.n + "  in_pool=" + t.in_pool + "  held_out=" + t.held_out);
  lines.push("    in-pool families=" + JSON.stringify(t.in_pool_families)
    + "  counts=" + JSON.stringify(t.families));
  lines.push("    held-out families=" + JSON.stringify(t.held_out_families));
  lines.push("    value_chars=" + JSON.stringify(t.value_chars)
    + "  x<y=" + t.x_lt_y + "  x>y=" + t.x_gt_y + "  x=y=" + t.x_eq_y);
  lines.push("    answer_index=" + JSON.stringify(t.answer_index));
  if (bal.ok) {
    lines.push("    PASS  no gross skew");
  } else {
    lines.push("    FAIL  " + bal.flags.join("; "));
  }
  return lines.join("\n");
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const fixtures = loadAllFixtures();
  const results = checkAll(fixtures);
  for (const r of results) {
    console.log(formatReport(r));
    console.log("");
  }
  const fail = results.filter((r) => !r.ok);
  const bal = checkCorpusBalance(fixtures);
  console.log("-".repeat(72));
  console.log("S2v2 audit-check: " + results.length + " fixtures"
    + "  held_out=" + fixtures.filter((f) => f.held_out).length
    + "  mechanical_fail=" + fail.length
    + "  balance_fail=" + (bal.ok ? 0 : bal.flags.length));
  console.log(formatBalance(bal));

  let tokenizeReport = null;
  if (!args.includes("--no-tokenize")) {
    tokenizeReport = await tokenizeAudit(fixtures);
  } else {
    tokenizeReport = { skipped: true, reason: "--no-tokenize", rows: [] };
  }
  const bpeById = new Map((tokenizeReport.rows || []).map((r) => [r.id, r]));
  const pairs = fixtures.map((f) => valuePairAudit(f, bpeById.get(f.id)));
  console.log(formatSymmetry(pairs, tokenizeReport));
  console.log(formatNamedValues(fixtures, pairs));

  let cosineReport = null;
  if (!args.includes("--no-cosine")) {
    cosineReport = await cosineAudit(fixtures);
    if (!cosineReport.skipped && !args.includes("--no-write-cosine")) {
      const applied = applyMeasuredCosine(fixtures, cosineReport);
      if (applied.wrote) {
        writeCorpus(fixtures);
        cosineReport.wrote = true;
        cosineReport.wrote_n = applied.n;
      }
    }
    console.log(formatCosine(cosineReport, fixtures));
  } else {
    console.log("  COSINE: skipped (--no-cosine)");
    console.log(formatCosine({ skipped: true, reason: "--no-cosine", rows: [] }, fixtures));
  }

  const nWarn = pairs.reduce((n, p) => n + p.warns.length, 0);
  console.log("  WARNs: " + nWarn + " flag(s) across "
    + pairs.filter((p) => p.warns.length).length + " case(s) (not mechanical fails).");

  if (args.includes("--json")) {
    console.log(JSON.stringify({
      results: results.map((r) => ({
        id: r.id, ok: r.ok, errors: r.errors,
        mechanical: r.mechanical, asserted: r.asserted,
      })),
      balance: bal,
      cosine: cosineReport,
      tokenize: tokenizeReport && { skipped: tokenizeReport.skipped, reason: tokenizeReport.reason, url: tokenizeReport.url },
      symmetry: pairs,
      cosine_delta_bound: COSINE_DELTA_BOUND,
      quarantined_by_cosine: quarantineList(fixtures),
    }, null, 2));
  }

  if (fail.length || !bal.ok) {
    const ids = fail.map((r) => r.id);
    if (fail.length) console.error("FAIL " + fail.length + " fixture(s): " + ids.join(", "));
    if (!bal.ok) console.error("FAIL corpus balance: " + bal.flags.join("; "));
    return 1;
  }
  console.log("All fixtures passed mechanical checks. values_arbitrary + n_unguessable + derivation_audit marks remain author-asserted.");
  return 0;
}

module.exports = {
  CORPUS, COSINE_DELTA_BOUND, DERIVATION_PATHS, DERIVATION_MARKS,
  GPT_NAMED_VALUES, BPE_GROSS_COUNT_DELTA,
  readJsonl, loadAllFixtures, checkFixture, checkAll, checkCorpusBalance,
  formatReport, formatBalance, formatCosine, formatSymmetry, formatNamedValues,
  cosineAudit, tokenizeAudit, valuePairAudit, capsClass,
  longestCommonPrefix, longestCommonSuffix, longestCommonSubstring, trigramJaccard,
  cosineDeltaOf, isCosineQuarantined, quarantineList,
  applyMeasuredCosine, writeCorpus, round6, lookupLexical: lookupLexical,
  renderTemplate, main,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(String(e && e && e.stack || e));
    process.exit(2);
  });
}
