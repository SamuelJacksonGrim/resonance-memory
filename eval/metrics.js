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

// ---------------------------------------------------------------------------
// Reporting metrics (A/B), distinct from the golden pass/fail scoring above.
//
// The golden gate (`eval/run.js` vs `golden.json`) stays a per-case contains/
// excludes check. These are named, registered numbers the measurement runner
// (`eval/measure.js`) emits so a later slice can A/B against a recorded
// baseline without rewriting the runner. Adding `mrr`, `staleness_rate`,
// `extraction_precision`, … is `register({ name, compute })`, not a new
// scoring path.
//
// Contract: `{ name, compute(results, corpus, opts) -> number, defaults?,
// description?, explain? }`. `explain` is optional and returns a breakdown
// object; `compute` is the number the A/B compares. `results` / `corpus`
// shapes are per-metric (documented on each builtin) so a new metric can
// introduce a new shape without breaking the others.
// ---------------------------------------------------------------------------

const REGISTRY = new Map();

function register(metric) {
  if (!metric || typeof metric.name !== "string" || !metric.name) {
    throw new Error("register: metric.name (non-empty string) is required");
  }
  if (typeof metric.compute !== "function") {
    throw new Error("register: metric.compute(results, corpus, opts) -> number is required");
  }
  if (REGISTRY.has(metric.name)) {
    throw new Error("register: duplicate name '" + metric.name + "'");
  }
  const entry = {
    name: metric.name,
    compute: metric.compute,
    defaults: metric.defaults && typeof metric.defaults === "object" ? metric.defaults : {},
    description: metric.description || "",
    explain: typeof metric.explain === "function" ? metric.explain : null,
  };
  REGISTRY.set(metric.name, entry);
  return entry;
}

function getMetric(name) { return REGISTRY.get(name) || null; }
function listMetrics() { return [...REGISTRY.values()]; }

function computeMetric(name, results, corpus, opts) {
  const m = REGISTRY.get(name);
  if (!m) throw new Error("unknown metric: " + name);
  return m.compute(results, corpus, Object.assign({}, m.defaults, opts || {}));
}

function explainMetric(name, results, corpus, opts) {
  const m = REGISTRY.get(name);
  if (!m) throw new Error("unknown metric: " + name);
  const merged = Object.assign({}, m.defaults, opts || {});
  if (m.explain) return m.explain(results, corpus, merged);
  return { value: m.compute(results, corpus, merged) };
}

function computeAll(results, corpus, opts) {
  const out = {};
  for (const m of REGISTRY.values()) {
    out[m.name] = m.compute(results, corpus, Object.assign({}, m.defaults, opts || {}));
  }
  return out;
}

function asQueryList(results) {
  if (!results) return [];
  if (Array.isArray(results)) return results;
  if (Array.isArray(results.queries)) return results.queries;
  return [];
}

function asIds(x) {
  if (!Array.isArray(x)) return [];
  return x.map((item) => String(item && typeof item === "object" ? item.id : item));
}

function recallAtKStats(results, corpus, opts) {
  const k = opts && opts.k != null ? Number(opts.k) : 5;
  const queries = asQueryList(results);
  const scored = [];
  for (const q of queries) {
    const relevant = asIds(q.relevant_ids || q.relevant);
    if (!relevant.length) continue;          // unlabeled: not part of the metric
    const ranked = asIds(q.ranked_ids || q.ranked).slice(0, k);
    const hit = relevant.some((id) => ranked.includes(id));
    scored.push({ id: q.id || q.query || null, hit, ranked, relevant });
  }
  const hits = scored.filter((s) => s.hit).length;
  const n = scored.length;
  return {
    k, n, hits,
    rate: n ? hits / n : 0,
    misses: scored.filter((s) => !s.hit).map((s) => s.id),
  };
}

/*
 * recall_at_k — binary-hit recall (success@k), not set-recall.
 *
 * Definition: among queries that declare at least one relevant id, the
 * fraction for which ANY relevant id appears in the top-k of `ranked_ids`.
 * k is an option (default 5). Unlabeled queries (empty relevant_ids) are
 * skipped, not scored as misses.
 *
 * Why success@k not |retrieved ∩ relevant|/|relevant|: a memory query
 * usually has one target fact; RM-02's acceptance names "recall@5" as
 * "did the fact still surface," not "did every restatement surface."
 * After a merge, one survivor should still hit.
 *
 * results shape: { queries: [{ ranked_ids, relevant_ids, id? }] }
 *   or an array of those query objects. `ranked` / `relevant` accepted
 *   as aliases; entries may be ids or `{id}`.
 * corpus is unused (the relevant set lives on the query). Kept in the
 * signature so every metric is `compute(results, corpus, opts)`.
 */
register({
  name: "recall_at_k",
  defaults: { k: 5 },
  description: "Fraction of labeled queries whose top-k ranked ids contain at least one relevant id (success@k).",
  compute(results, corpus, opts) { return recallAtKStats(results, corpus, opts).rate; },
  explain: recallAtKStats,
});

function groupsFromWrites(writes) {
  const groups = {};
  for (const w of writes || []) {
    const text = typeof w === "string" ? w : w && w.text;
    if (text == null) continue;
    const g = (typeof w === "object" && w.dup_group) ? w.dup_group : text;
    (groups[g] ||= []).push(text);
  }
  return groups;
}

function normalizeGroups(corpus) {
  if (!corpus) return {};
  if (corpus.groups && !Array.isArray(corpus.groups) && typeof corpus.groups === "object") {
    return corpus.groups;
  }
  if (Array.isArray(corpus.groups)) {
    const o = {};
    for (const g of corpus.groups) {
      const id = g.id || g.dup_group;
      o[id] = g.texts || g.members || [];
    }
    return o;
  }
  if (Array.isArray(corpus.writes)) return groupsFromWrites(corpus.writes);
  return {};
}

function normalizeRecords(results) {
  if (!results) return [];
  const raw = Array.isArray(results) ? results
    : Array.isArray(results.records) ? results.records
    : [];
  return raw.map((r) => (typeof r === "string" ? { text: r } : r));
}

function duplicateRateStats(results, corpus) {
  const records = normalizeRecords(results);
  const groups = normalizeGroups(corpus);
  const textToGroup = new Map();
  for (const [gid, texts] of Object.entries(groups)) {
    for (const t of texts || []) {
      if (!textToGroup.has(t)) textToGroup.set(t, gid);
    }
  }
  const represented = new Set();
  const storedByGroup = {};
  let unmatched = 0;
  for (const rec of records) {
    const text = rec && rec.text;
    const gid = textToGroup.get(text);
    if (gid != null) {
      represented.add(gid);
      storedByGroup[gid] = (storedByGroup[gid] || 0) + 1;
    } else {
      unmatched++;
    }
  }
  const n = records.length;
  // Unmatched records (text not in any labeled write) each count as their
  // own singleton so they don't inflate the rate — they aren't labeled
  // redundant. See the metric comment for why we match on text.
  const gStar = represented.size + unmatched;
  const extras = Math.max(0, n - gStar);
  const byGroup = {};
  for (const [gid, texts] of Object.entries(groups)) {
    const labeled = (texts || []).length;
    const stored = storedByGroup[gid] || 0;
    byGroup[gid] = { labeled, stored, extras: Math.max(0, stored - (stored ? 1 : 0)) };
  }
  return {
    n, gStar, extras, unmatched,
    rate: n ? extras / n : 0,
    byGroup,
  };
}

/*
 * duplicate_rate — fraction of CURRENT stored records that are redundant
 * given ground-truth duplicate-group labels.
 *
 *     rate = max(0, N − G*) / N
 *
 *   N   = number of current stored records passed in (the caller is
 *         responsible for handing `store.current()`, not `active()`:
 *         a mid-band merge that retires the loser with superseded_by
 *         should drop the loser from this count. Counting active()
 *         would hide the merge RM-02 is supposed to perform).
 *   G*  = distinct labeled groups represented among those records,
 *         plus one singleton per unmatched record (stored text that
 *         matches no labeled write). Unmatched records do not inflate
 *         the rate.
 *
 * A record represents a group iff its `text` equals one of that group's
 * labeled write texts. RM-02.b MUST keep one of the original texts on
 * merge (the spec: "keep the longer/more specific text") or this
 * mapping breaks. Exact restatement (byte-identical confirm, already
 * shipping) leaves the original text, so it already scores correctly.
 *
 * Controls are singleton groups: they add 1 to N and 1 to G*, diluting
 * the rate. The metric is "what fraction of the store is redundant,"
 * not "extras among dup-labeled rows only." That matches RM-02's
 * acceptance ("duplicate_rate on eval/duplicates").
 *
 * This is NOT "pairs with cosine > 0.95." Measuring cosine-dedup by
 * cosine would be circular; the labels are the ground truth, and the
 * band (hi/mid/control) lives on the corpus so a later slice can
 * report per-band extras without changing this formula.
 *
 * results shape: { records: [{ text, ... }] } or an array of records/texts.
 * corpus shape:  { groups: { groupId: [text, ...] } }
 *            or  { writes: [{ text, dup_group }] } (assembled from the JSONL).
 */
register({
  name: "duplicate_rate",
  description: "Fraction of current stored records beyond one-per-ground-truth-duplicate-group.",
  compute(results, corpus) { return duplicateRateStats(results, corpus).rate; },
  explain: duplicateRateStats,
});

/*
 * Factory for a frozen-k alias (`recall@5`, `recall@10`, …). Registering
 * `makeRecallAtK(10)` is how a later slice adds recall@10 without
 * touching the runner: one more `register(...)` call.
 */
function makeRecallAtK(k) {
  const n = Number(k);
  return {
    name: "recall@" + n,
    defaults: { k: n },
    description: "recall_at_k with k=" + n + " frozen (success@" + n + ").",
    compute(results, corpus, opts) {
      return computeMetric("recall_at_k", results, corpus, Object.assign({}, opts, { k: n }));
    },
    explain(results, corpus, opts) {
      return explainMetric("recall_at_k", results, corpus, Object.assign({}, opts, { k: n }));
    },
  };
}

/*
 * Primary cosine hits from a recall OUTPUT STRING (the same text the model
 * sees). Stops before a "Related:" block so I9 (discovery does not reorder
 * the primary result) is respected: reporting metrics score the cosine
 * list, not the field appendix. Format is `N. [id ID] text`.
 */
function parsePrimaryHits(output) {
  const primary = String(output || "").split(/related:/i)[0];
  const hits = [];
  const re = /\[id\s+(\S+)\]\s*(.*)$/gm;
  let m;
  while ((m = re.exec(primary))) hits.push({ id: m[1], text: m[2].trim() });
  return hits;
}

module.exports = {
  scoreSingle, scoreRepeat, containsAll, fieldSignals,
  register, getMetric, listMetrics, computeMetric, explainMetric, computeAll,
  makeRecallAtK, groupsFromWrites, parsePrimaryHits,
};
