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
 * eval/metrics.js - scoring a recall output against a case's expectations.
 *
 * Scoring is over the recall OUTPUT STRING (the same text the model sees), so it
 * covers both the primary cosine hits and the "Related:" neighborhood the field
 * appends. `excludes` matters as much as `contains`: most memory bugs are extra
 * WRONG stuff surfacing, not missing right stuff.
 */

function norm(s) { return String(s || "").toLowerCase(); }
function outputContains(output, term) { return norm(output).includes(norm(term)); }
function containsAll(output, terms) { return (terms || []).every((t) => outputContains(output, t)); }
function excludesAll(output, terms) { return (terms || []).every((t) => !outputContains(output, t)); }
function surfacedSuperseded(output) { return /no longer current/i.test(String(output || "")); }

// A single-shot case: one recall output.
function scoreSingle(c, output) {
  const e = c.expect || {};
  const reasons = [];
  let pass = true;
  if (e.contains && !containsAll(output, e.contains)) { pass = false; reasons.push("missing " + JSON.stringify(e.contains)); }
  if (e.excludes && !excludesAll(output, e.excludes)) { pass = false; reasons.push("surfaced excluded " + JSON.stringify(e.excludes)); }
  if (e.current_only && surfacedSuperseded(output)) { pass = false; reasons.push("drew on a superseded fact"); }
  return { pass, reasons, byTurn: null, first_hit_turn: containsAll(output, e.contains || []) ? 1 : null };
}

// A repeated case (constraint-learning): per-turn outputs against a single store,
// so the Hebbian loop can strengthen an edge across turns. "Missed at turn 1,
// landed by turn 4" is the success signal, not a failure.
function scoreRepeat(c, outputs) {
  const e = c.expect || {};
  const terms = e.contains || [];
  const byTurn = outputs.map((o) => containsAll(o, terms));
  const reasons = [];
  let pass = true;
  if (Array.isArray(e.contains_by_turn)) {
    e.contains_by_turn.forEach((want, i) => {
      if (want === null || want === undefined) return;   // "don't care" turn
      if (byTurn[i] !== want) { pass = false; reasons.push("turn " + (i + 1) + ": got " + byTurn[i] + ", wanted " + want); }
    });
  } else if (!byTurn[byTurn.length - 1]) {
    pass = false; reasons.push("never surfaced " + JSON.stringify(terms));
  }
  const idx = byTurn.findIndex(Boolean);
  return { pass, reasons, byTurn, first_hit_turn: idx >= 0 ? idx + 1 : null };
}

/*
 * ROC / TBR signals for a single recall output (RM-00 field metric split).
 *
 * A flat pass/fail scalar weights a fatal false negative ("forgot the user is diabetic")
 * the same as an annoying false positive ("also mentioned the mechanic"). For a memory
 * system those are not equal, so we track them apart:
 *   rescued  - did the constraint the field is supposed to surface actually appear? (ROC)
 *   bled     - how many forbidden/excluded terms leaked into the output? (TBR)
 *   appended - how many memories the field added (the "Related:" block) = tangent surface.
 */
function fieldSignals(c, output) {
  const e = c.expect || {};
  const lc = String(output || "").toLowerCase();
  const rescued = containsAll(output, e.contains || []);
  const bledTerms = (e.excludes || []).filter((t) => lc.includes(String(t).toLowerCase()));
  const rel = String(output || "").split(/related:/i)[1];
  const appended = rel ? rel.split("\n").filter((l) => /^\s*-\s*\[id/i.test(l)).length : 0;
  return { rescued, bled: bledTerms.length, bledTerms, appended };
}

module.exports = { scoreSingle, scoreRepeat, containsAll, fieldSignals };
