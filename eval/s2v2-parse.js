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
 * eval/s2v2-parse.js — S2v2 slot parser (LOCKED prereg scoring).
 *
 * Deterministic; no LLM judge. Classifies a raw generation as a committed
 * pick of X, a committed pick of Y, or neither.
 *
 * Reuses H6's span matcher and hedge detector verbatim (hasSpan / hasHedge)
 * so "maybe velka" / "velka or sorin" / "sorinex" cannot silently change
 * meaning between the two experiments.
 *
 * pick is "X" IFF X's span is present, Y is absent, and there is no
 * commitment-changing hedge; symmetric for Y; else "neither"
 * (reason: empty / list-both / hedge / absent).
 *
 * Same single-committed-slot discipline as H6: listing both, or surfacing
 * a candidate without committing to it, is not a channel pick.
 */

"use strict";

const { hasSpan, hasHedge } = require("./h6-parse.js");

function parsePick(raw, x, y) {
  const text = String(raw == null ? "" : raw);
  if (!text.trim()) {
    return { pick: "neither", reason: "empty", present: [] };
  }
  const xv = String(x == null ? "" : x);
  const yv = String(y == null ? "" : y);
  const hasX = xv ? hasSpan(text, xv) : false;
  const hasY = yv ? hasSpan(text, yv) : false;
  const present = [];
  if (hasX) present.push(xv);
  if (hasY) present.push(yv);

  if (hasX && hasY) {
    return { pick: "neither", reason: "list-both", present };
  }
  if (hasX || hasY) {
    if (hasHedge(text)) {
      return { pick: "neither", reason: "hedge", present };
    }
    return { pick: hasX ? "X" : "Y", reason: "match", present };
  }
  return { pick: "neither", reason: "absent", present: [] };
}

function parseFixtureOutput(raw, fixture) {
  const fix = fixture || {};
  return parsePick(raw, fix.x, fix.y);
}

module.exports = {
  parsePick,
  parseFixtureOutput,
  hasSpan,
  hasHedge,
};
