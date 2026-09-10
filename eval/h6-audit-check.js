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
 * eval/h6-audit-check.js — static, offline fixture checker for H6.
 *
 * Makes the embedded audit object inspectable instead of trusted. Per case
 * it verifies what CAN be verified without a model or a semantic judge, and
 * it PRINTS the split so a reviewer can see proven vs claimed:
 *
 *   MECHANICAL (this file):
 *     audit shape, primary_ids vs primary block, C1 exact-lexical,
 *     query leakage (lexical), distractors ≠ gold, B-filler cleanliness,
 *     parser well-formedness, S2 gold-in-primary / D-alt contradictions
 *
 *   AUTHOR-ASSERTED, pending GPT review:
 *     C2 semantic_equivalent, C3 deductive
 *     C4 cross_memory  (joint graph — GPT; live B-fail is empirical only)
 *
 *   AUTHOR-ASSERTED, pending live driver:
 *     C5 no_recall     (N-arm must fail)
 *     C4 also confirmed empirically if B fails on this driver
 *
 * This checker CANNOT judge C2/C3/C4/C5. It will not pretend to.
 *
 *   node eval/h6-audit-check.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {
  normalize, hasSpan, acceptSet, competingCandidates, tokenCount,
} = require("./h6-parse.js");

const CHANNELS = [
  "exact_lexical",
  "semantic_equivalent",
  "deductive",
  "cross_memory",
  "no_recall",
];

const STRATUM1 = path.join(__dirname, "corpora", "h6-stratum1.jsonl");
const STRATUM2 = path.join(__dirname, "corpora", "h6-stratum2.jsonl");

const PASS_FAIL = new Set(["pass", "fail"]);

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

function loadAllFixtures(paths) {
  const files = paths || [STRATUM1, STRATUM2];
  const out = [];
  for (const f of files) {
    for (const c of readJsonl(f)) {
      c._file = path.basename(f);
      out.push(c);
    }
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

function primaryTexts(fix) {
  return (fix.primary || []).map((m) => String(m && m.text || ""));
}

function tokenSlackOk(a, b) {
  const da = tokenCount(a);
  const db = tokenCount(b);
  const diff = Math.abs(da - db);
  const allow = Math.max(3, Math.round(0.25 * Math.max(da, db, 1)));
  return { ok: diff <= allow, a: da, b: db, diff, allow };
}

function push(errs, ok, msg) {
  if (!ok) errs.push(msg);
  return ok;
}

function checkShape(fix, errs, mechanical) {
  const mark = (key, ok, detail) => {
    mechanical[key] = { ok: !!ok, detail: detail || (ok ? "pass" : "fail") };
    if (!ok) errs.push(key + ": " + (detail || "fail"));
  };

  mark("id", !!(fix && fix.id), fix && fix.id ? String(fix.id) : "missing id");
  mark("kind_h6", fix.kind === "h6", "kind=" + JSON.stringify(fix.kind) + " (must be h6 so RM-00 ignores it)");
  mark("no_expect", fix.expect == null, fix.expect == null ? "no expect" : "HAS expect — would threaten golden");
  mark("gate_false", fix.gate === false, "gate=" + JSON.stringify(fix.gate));

  const stratum = fix.stratum;
  mark("stratum", stratum === "related-necessary" || stratum === "primary-sufficient",
    "stratum=" + JSON.stringify(stratum));
  mark("family", typeof fix.family === "string" && fix.family.length > 0, "family=" + JSON.stringify(fix.family));
  mark("held_out", typeof fix.held_out === "boolean", "held_out=" + JSON.stringify(fix.held_out));

  const gold = fix.gold || {};
  mark("gold", typeof gold.slot === "string" && gold.slot && typeof gold.value === "string" && String(gold.value).trim(),
    gold.slot + "=" + gold.value);

  const audit = fix.audit || {};
  const missing = CHANNELS.filter((k) => !PASS_FAIL.has(audit[k]));
  mark("audit_shape", missing.length === 0,
    missing.length ? "missing/invalid: " + missing.join(",") : "all five channels pass|fail");

  mark("query_leakage_field", PASS_FAIL.has(fix.query_leakage),
    "query_leakage=" + JSON.stringify(fix.query_leakage));

  const parser = fix.parser || {};
  const aliasesOk = Array.isArray(parser.aliases) && parser.aliases.every((a) => typeof a === "string");
  mark("parser_well_formed",
    parser.type === "exact_slot"
      && typeof parser.canonical === "string"
      && String(parser.canonical).trim()
      && aliasesOk,
    parser.type + " canonical=" + JSON.stringify(parser.canonical) + " aliases=" + JSON.stringify(parser.aliases));

  if (parser.canonical && gold.value && normalize(parser.canonical) !== normalize(gold.value)) {
    mark("parser_canonical_matches_gold", false,
      "parser.canonical " + JSON.stringify(parser.canonical) + " ≠ gold.value " + JSON.stringify(gold.value));
  } else {
    mark("parser_canonical_matches_gold", true, "aligned");
  }

  mark("query", typeof fix.query === "string" && fix.query.trim(), "query present");
  mark("primary_array", Array.isArray(fix.primary) && fix.primary.length > 0, "n=" + ((fix.primary || []).length));
  mark("primary_ids_array", Array.isArray(fix.primary_ids) && fix.primary_ids.length > 0, "n=" + ((fix.primary_ids || []).length));
  mark("related", !!(asMem(fix.related)), "related id+text");
  mark("filler", !!(asMem(fix.filler)), "filler id+text");
  mark("related_d", !!(asMem(fix.related_d)), "related_d id+text");
  mark("candidates_array", Array.isArray(fix.candidates) && fix.candidates.length >= 2, "n=" + ((fix.candidates || []).length));
  mark("distractors_array", Array.isArray(fix.distractors), "n=" + ((fix.distractors || []).length));
  mark("n_primary", Array.isArray(fix.n_primary) && fix.n_primary.length === (fix.primary || []).length,
    "n_primary=" + ((fix.n_primary || []).length) + " primary=" + ((fix.primary || []).length));
  mark("n_related", !!(asMem(fix.n_related)), "n_related id+text");
}

function checkPrimaryIds(fix, errs, mechanical) {
  const ids = (fix.primary || []).map((m) => String(m && m.id));
  const want = (fix.primary_ids || []).map(String);
  const ok = ids.length === want.length && ids.every((id, i) => id === want[i]);
  mechanical.primary_ids_match = {
    ok,
    detail: ok ? ids.join(",") : "primary=[" + ids.join(",") + "] primary_ids=[" + want.join(",") + "]",
  };
  if (!ok) errs.push("primary_ids do not match constructed primary block order");
  const related = asMem(fix.related);
  const src = (fix.related_source || []).map(String);
  const srcOk = related && src.includes(related.id);
  mechanical.related_source_match = {
    ok: !!srcOk,
    detail: related ? "related.id=" + related.id + " related_source=" + JSON.stringify(src) : "no related",
  };
  if (!srcOk) errs.push("related.id not in related_source");
}

function spansAny(texts, value) {
  return texts.some((t) => hasSpan(t, value));
}

function checkC1AndLeakage(fix, errs, mechanical) {
  const goldVals = acceptSet(fix.parser);
  const related = asMem(fix.related);
  const filler = asMem(fix.filler);
  const relatedD = asMem(fix.related_d);
  const primaries = primaryTexts(fix);
  const qctx = queryContext(fix);
  const nPrimaries = (fix.n_primary || []).map((m) => String(m && m.text || ""));
  const nRelated = asMem(fix.n_related);
  const stratum = fix.stratum;
  const alt = fix.alt && fix.alt.value != null ? String(fix.alt.value) : null;

  const goldInRelated = related && goldVals.every((v, i) => {
    // Canonical (index 0) MUST appear in Related. Aliases are output
    // accept-set members and are not required to be in the memory text.
    if (i === 0) return hasSpan(related.text, v);
    return true;
  }) && related && hasSpan(related.text, goldVals[0]);

  const goldInPrimary = goldVals.some((v) => spansAny(primaries, v));
  const goldInQuery = goldVals.some((v) => hasSpan(qctx, v));
  const goldInFiller = filler && goldVals.some((v) => hasSpan(filler.text, v));
  const others = competingCandidates(fix.parser, fix.candidates);
  const otherInFiller = filler && others.some((v) => hasSpan(filler.text, v));
  const goldInN = goldVals.some((v) => spansAny(nPrimaries, v) || (nRelated && hasSpan(nRelated.text, v)));
  const otherInN = others.some((v) => spansAny(nPrimaries, v) || (nRelated && hasSpan(nRelated.text, v)));

  if (stratum === "related-necessary") {
    mechanical.C1_exact_lexical = {
      ok: !!(goldInRelated && !goldInPrimary && !goldInQuery),
      detail: "gold_in_related=" + !!goldInRelated
        + " gold_in_primary=" + goldInPrimary
        + " gold_in_query_or_turns=" + goldInQuery
        + " (S1 requires Related-only)",
    };
    if (!goldInRelated) errs.push("C1: canonical gold not in Related text");
    if (goldInPrimary) errs.push("C1: gold/alias lexically present in a primary row");
    if (goldInQuery) errs.push("C1: gold/alias lexically present in query or turns");
  } else if (stratum === "primary-sufficient") {
    // S1 C1 (absent from primary) CANNOT apply here — that is the S2
    // construction. Mechanical S2 C1: gold IN primary, absent from query.
    const goldInA = goldInRelated;
    const altInD = alt ? hasSpan(relatedD && relatedD.text || "", alt) : false;
    const goldInD = relatedD && goldVals.some((v) => hasSpan(relatedD.text, v));
    const altInPrimary = alt ? spansAny(primaries, alt) : false;
    const altInQuery = alt ? hasSpan(qctx, alt) : false;
    mechanical.C1_exact_lexical = {
      ok: !!(goldInPrimary && !goldInQuery && goldInA && altInD && !goldInD && !altInPrimary && !altInQuery),
      detail: "S2 gold_in_primary=" + goldInPrimary
        + " gold_in_query=" + goldInQuery
        + " A_related_has_gold=" + !!goldInA
        + " D_related_has_alt=" + altInD
        + " D_related_has_gold=" + !!goldInD
        + " alt_in_primary=" + altInPrimary,
    };
    if (!goldInPrimary) errs.push("S2: gold must be lexically present in primary");
    if (goldInQuery) errs.push("S2: gold lexically present in query or turns");
    if (!goldInA) errs.push("S2: A Related must contain gold (correct Related)");
    if (alt && !altInD) errs.push("S2: D Related must contain the mutually-exclusive alt");
    if (goldInD) errs.push("S2: D Related still contains gold (not a clean contradiction)");
    if (altInPrimary) errs.push("S2: alt lexically present in primary (hijack test contaminated)");
    if (altInQuery) errs.push("S2: alt lexically present in query or turns");
  } else {
    mechanical.C1_exact_lexical = { ok: false, detail: "unknown stratum" };
    errs.push("unknown stratum for C1");
  }

  const qLeakOk = !goldInQuery;
  mechanical.query_leakage = {
    ok: qLeakOk && fix.query_leakage === "pass",
    detail: qLeakOk
      ? (fix.query_leakage === "pass" ? "lexical absent from query+turns" : "lexical clean but field is " + fix.query_leakage)
      : "gold/alias in query or turns",
  };
  if (!qLeakOk) errs.push("query_leakage: gold/alias in query or turns");
  if (qLeakOk && fix.query_leakage !== "pass") {
    errs.push("query_leakage field is " + JSON.stringify(fix.query_leakage) + " but lexical check passed — do not hide a fail");
  }

  // S1 D-related should be the alt, not gold (contradictory Related still
  // assembled for the harness even though S1 metrics ignore D).
  if (stratum === "related-necessary" && relatedD && alt) {
    const altInD = hasSpan(relatedD.text, alt);
    const goldInD = goldVals.some((v) => hasSpan(relatedD.text, v));
    mechanical.s1_related_d = {
      ok: altInD && !goldInD,
      detail: "alt_in_D=" + altInD + " gold_in_D=" + goldInD,
    };
    if (!altInD || goldInD) errs.push("S1 related_d must be a clean alt contradiction");
  }

  const dist = Array.isArray(fix.distractors) ? fix.distractors : [];
  const distHit = dist.filter((d) => goldVals.some((g) => normalize(d) === normalize(g)));
  mechanical.distractors_neq_gold = {
    ok: distHit.length === 0,
    detail: distHit.length ? "distractor equals gold: " + distHit.join(",") : "none equal gold",
  };
  if (distHit.length) errs.push("enumerated distractor equals gold");

  const cand = Array.isArray(fix.candidates) ? fix.candidates : [];
  const candHasGold = goldVals[0] && cand.some((c) => normalize(c) === normalize(goldVals[0]));
  const candHasAlt = !alt || cand.some((c) => normalize(c) === normalize(alt));
  mechanical.candidates_include_gold_and_alt = {
    ok: !!(candHasGold && candHasAlt),
    detail: "gold=" + candHasGold + " alt=" + candHasAlt,
  };
  if (!candHasGold || !candHasAlt) errs.push("candidates must enumerate gold and alt (single-answer set)");

  mechanical.filler_clean = {
    ok: !!(filler && !goldInFiller && !otherInFiller),
    detail: filler
      ? "gold_in_filler=" + !!goldInFiller + " competing_in_filler=" + !!otherInFiller
      : "no filler",
  };
  if (goldInFiller) errs.push("B filler contains gold");
  if (otherInFiller) errs.push("B filler contains a competing candidate");

  if (filler && related) {
    const slack = tokenSlackOk(related.text, filler.text);
    mechanical.filler_token_count = {
      ok: slack.ok,
      detail: "related=" + slack.a + " filler=" + slack.b + " diff=" + slack.diff + " allow=" + slack.allow,
    };
    if (!slack.ok) errs.push("B filler token count not ~equal to Related (" + slack.a + " vs " + slack.b + ")");
  }

  // Skip-cue lexical tripwire (not a semantic judge — just the obvious
  // strings the contract forbids).
  const skipRe = /\b(ignore this|irrelevant|unrelated to the (question|query)|nothing relevant|skip this|do not (read|use))\b/i;
  const skipHit = filler && skipRe.test(filler.text);
  mechanical.filler_not_skip_cue = {
    ok: !skipHit,
    detail: skipHit ? "filler matches a skip-cue regex" : "no skip-cue strings",
  };
  if (skipHit) errs.push("B filler looks like a skip-cue");

  mechanical.n_surfaces_clean = {
    ok: !goldInN && !otherInN,
    detail: "gold_in_N=" + goldInN + " competing_in_N=" + otherInN,
  };
  if (goldInN || otherInN) errs.push("N filler surfaces contain gold or a competing candidate");

  // Author-asserted fail on any channel rejects the fixture (no grandfathering).
  const audit = fix.audit || {};
  for (const ch of CHANNELS) {
    if (audit[ch] === "fail") {
      errs.push("author-asserted " + ch + "=fail (drop or fix the case; no grandfathering)");
    }
  }
}

function authorMap(fix) {
  const audit = fix.audit || {};
  const s2 = fix.stratum === "primary-sufficient";
  return {
    C2_semantic_equivalent: {
      asserted: audit.semantic_equivalent,
      pending: "GPT semantic review",
      note: s2
        ? "N/A as a prohibition on S2 (primary is intended to contain the answer); field kept for shape"
        : "synonym / hypernym / description / paraphrase of gold in primary",
    },
    C3_deductive: {
      asserted: audit.deductive,
      pending: "GPT semantic review",
      note: s2
        ? "N/A as a prohibition on S2"
        : "arithmetic / ordering / set subtraction / categorical exclusion in primary",
    },
    C4_cross_memory: {
      asserted: audit.cross_memory,
      pending: "GPT joint-graph review AND live B-fail (S1 only)",
      note: s2
        ? "N/A as a prohibition on S2 (primary jointly MAY determine gold)"
        : "WHOLE primary set as one knowledge graph; 2+ rows must not reconstruct gold",
    },
    C5_no_recall: {
      asserted: audit.no_recall,
      pending: "live N-arm (drop if N succeeds)",
      note: "parametric / guess contamination; asserted at authoring",
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
      stratum: null,
      family: null,
      held_out: null,
      mechanical,
      asserted: {},
      errors: ["fixture is not an object"],
    };
  }
  checkShape(fix, errs, mechanical);
  checkPrimaryIds(fix, errs, mechanical);
  checkC1AndLeakage(fix, errs, mechanical);
  const asserted = authorMap(fix);
  const ok = errs.length === 0;
  return {
    id: fix.id || "(missing id)",
    ok,
    stratum: fix.stratum,
    family: fix.family,
    held_out: !!fix.held_out,
    mechanical,
    asserted,
    errors: errs,
  };
}

function formatReport(result) {
  const lines = [];
  const flag = result.ok ? "OK  " : "FAIL";
  lines.push(flag + "  " + result.id
    + "  stratum=" + result.stratum
    + "  family=" + result.family
    + "  held_out=" + result.held_out);
  lines.push("  MECHANICAL (this checker):");
  const keys = Object.keys(result.mechanical);
  for (const k of keys) {
    const m = result.mechanical[k];
    const st = m.ok ? "PASS" : "FAIL";
    lines.push("    " + st.padEnd(4) + "  " + k + "  " + m.detail);
  }
  lines.push("  AUTHOR-ASSERTED, pending GPT semantic review:");
  for (const k of ["C2_semantic_equivalent", "C3_deductive", "C4_cross_memory"]) {
    const a = result.asserted[k];
    lines.push("    asserted=" + a.asserted + "  " + k + "  pending=" + a.pending);
    lines.push("      " + a.note);
  }
  lines.push("  AUTHOR-ASSERTED, pending live driver:");
  {
    const a = result.asserted.C5_no_recall;
    lines.push("    asserted=" + a.asserted + "  C5_no_recall  pending=" + a.pending);
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

function main(argv) {
  const args = argv || process.argv.slice(2);
  const fixtures = loadAllFixtures();
  const results = checkAll(fixtures);
  for (const r of results) {
    console.log(formatReport(r));
    console.log("");
  }
  const fail = results.filter((r) => !r.ok);
  const s1 = fixtures.filter((f) => f.stratum === "related-necessary");
  const s2 = fixtures.filter((f) => f.stratum === "primary-sufficient");
  const families = [...new Set(s1.filter((f) => !f.held_out).map((f) => f.family))];
  const held = s1.filter((f) => f.held_out);
  console.log("-".repeat(72));
  console.log("H6 audit-check: " + results.length + " fixtures  "
    + "S1=" + s1.length + " S2=" + s2.length
    + "  in-pool families=[" + families.join(",") + "]"
    + "  held-out=" + held.length
    + "  mechanical_fail=" + fail.length);
  if (args.includes("--json")) {
    console.log(JSON.stringify(results.map((r) => ({
      id: r.id, ok: r.ok, errors: r.errors,
      mechanical: r.mechanical, asserted: r.asserted,
    })), null, 2));
  }
  if (fail.length) {
    console.error("FAIL " + fail.length + " fixture(s): " + fail.map((r) => r.id).join(", "));
    return 1;
  }
  console.log("All fixtures passed mechanical checks. C2/C3/C4/C5 remain author-asserted.");
  return 0;
}

module.exports = {
  CHANNELS, STRATUM1, STRATUM2,
  readJsonl, loadAllFixtures, checkFixture, checkAll, formatReport, main,
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(String(e && e.message || e));
    process.exit(2);
  }
}
