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
 * eval/h6-parse.js — H6 slot parser (LOCKED prereg scoring).
 *
 * Deterministic; no LLM judge. Normalize (case / punctuation / articles), then
 * credit IFF the canonical value or an accept-set alias is present as a span
 * AND no other enumerated same-slot candidate is also present.
 *
 * That is the single-answer discipline the D hijack test needs: a model that
 * lists gold+alt, or hedges without producing the slot, does not score.
 *
 * "No uncertainty credit" is operationalized as: an output that does not
 * contain the slot value is incorrect (including "I don't know"). An output
 * that contains the gold span and no other enumerated candidate IS credited
 * even if it also contains hedge words — the prereg's credit-iff sentence is
 * span-presence + uniqueness, not a hedge-regex. See h6-build-notes.md.
 */

"use strict";

function normalize(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * Span, not substring: "614" must not hit "2614"; "wren" must not hit "wrench".
 * Haystack and needle are both normalized first. Multi-word needles must
 * appear as contiguous tokens.
 */
function hasSpan(haystack, needle) {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!n || !h) return false;
  const pattern = n.split(" ").map(escapeRe).join("\\s+");
  return new RegExp("(^|\\s)" + pattern + "(\\s|$)", "u").test(h);
}

function acceptSet(parser) {
  const p = parser || {};
  const out = [];
  if (p.canonical != null && String(p.canonical).trim()) out.push(String(p.canonical));
  const aliases = Array.isArray(p.aliases) ? p.aliases : [];
  for (const a of aliases) {
    if (a != null && String(a).trim()) out.push(String(a));
  }
  return out;
}

function normalizeKey(s) {
  return normalize(s);
}

function competingCandidates(parser, candidates) {
  const accept = new Set(acceptSet(parser).map(normalizeKey));
  const list = Array.isArray(candidates) ? candidates : [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (c == null || !String(c).trim()) continue;
    const k = normalizeKey(c);
    if (!k || accept.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(String(c));
  }
  return out;
}

function tokenCount(s) {
  const n = String(s || "").trim();
  if (!n) return 0;
  return n.split(/\s+/).length;
}

/*
 * Parse one raw generation against a fixture's parser + enumerated candidates.
 * Returns { ok, matched, reason, present }.
 *   ok=true  only for unique gold/alias span
 *   reason: "match" | "absent" | "wrong" | "list-everything" | "empty"
 */
function parseSlot(raw, parser, candidates) {
  const text = String(raw == null ? "" : raw);
  if (!text.trim()) {
    return { ok: false, matched: null, reason: "empty", present: [] };
  }
  const accept = acceptSet(parser);
  if (!accept.length) {
    return { ok: false, matched: null, reason: "absent", present: [] };
  }
  const presentAccept = accept.filter((v) => hasSpan(text, v));
  const others = competingCandidates(parser, candidates);
  const presentOthers = others.filter((v) => hasSpan(text, v));
  const present = presentAccept.concat(presentOthers);

  if (presentAccept.length && presentOthers.length) {
    return { ok: false, matched: null, reason: "list-everything", present };
  }
  if (presentAccept.length) {
    return {
      ok: true,
      matched: normalize(parser.canonical),
      reason: "match",
      present: presentAccept,
    };
  }
  if (presentOthers.length) {
    return { ok: false, matched: null, reason: "wrong", present: presentOthers };
  }
  return { ok: false, matched: null, reason: "absent", present: [] };
}

function parseFixtureOutput(raw, fixture) {
  const fix = fixture || {};
  return parseSlot(raw, fix.parser, fix.candidates);
}

module.exports = {
  normalize,
  hasSpan,
  acceptSet,
  competingCandidates,
  tokenCount,
  parseSlot,
  parseFixtureOutput,
};
