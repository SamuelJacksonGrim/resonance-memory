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

function normFact(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function asText(item) {
  if (item == null) return "";
  if (typeof item === "string") return item;
  return item.text != null ? String(item.text) : "";
}

function asCaseList(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.cases)) return x.cases;
  if (Array.isArray(x.writes)) return x.writes;
  return [];
}

function isLabeledExtract(c) {
  return c && Array.isArray(c.gold_facts);
}

function storedList(c) {
  if (!c) return [];
  if (Array.isArray(c.stored)) return c.stored.map(asText);
  if (typeof c.text === "string" && c.gold_facts && !c.stored) return [];
  return [];
}

function joinExtractCases(results, corpus) {
  const resultCases = asCaseList(results);
  const corpusCases = asCaseList(corpus);
  const byId = new Map();
  for (const c of corpusCases) {
    if (c && c.id != null) byId.set(String(c.id), c);
  }
  const out = [];
  const n = Math.max(resultCases.length, corpusCases.length);
  for (let i = 0; i < n; i++) {
    const r = resultCases[i] || {};
    const c = (r.id != null && byId.has(String(r.id)))
      ? byId.get(String(r.id))
      : (corpusCases[i] || {});
    const merged = Object.assign({}, c, r);
    if (!isLabeledExtract(merged) && !isLabeledExtract(c) && !isLabeledExtract(r)) continue;
    const gold = Array.isArray(merged.gold_facts) ? merged.gold_facts
      : Array.isArray(c.gold_facts) ? c.gold_facts
      : Array.isArray(r.gold_facts) ? r.gold_facts
      : null;
    if (!Array.isArray(gold)) continue;          // unlabeled: not part of the metric
    out.push({
      id: merged.id || r.id || c.id || ("case-" + i),
      gold_facts: gold,
      noise: Array.isArray(merged.noise) ? merged.noise
        : Array.isArray(c.noise) ? c.noise
        : Array.isArray(r.noise) ? r.noise
        : [],
      expect_refusal: !!(merged.expect_refusal || c.expect_refusal || r.expect_refusal),
      refused: !!(r.refused || merged.refused),
      stored: storedList(r).length ? storedList(r) : storedList(merged),
      extract_match: merged.extract_match || c.extract_match || r.extract_match || null,
    });
  }
  return out;
}

/*
 * Cover-match (messy-hard / Tier 2). Exact equality is the right test for
 * deterministic Tier 0 (a blob that *contains* the gold is still noise).
 * An LLM will paraphrase, so messy-hard labels `extract_match: "cover"`:
 * a stored record matches iff it is short (atomic, not the narrative blob)
 * and covers the gold's content-bearing tokens (or contains / is contained
 * in the gold string). A long blob fails the word-count gate on purpose —
 * that is the Tier-0-on-messy-hard miss the A/B is supposed to show.
 */
const COVER_MAX_WORDS = 22;
const COVER_MIN = 0.55;
const COVER_STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
  "my", "i", "is", "am", "at", "by", "from", "that", "this", "it", "as",
  "be", "are", "was", "were", "me", "we", "our",
]);

function wordCount(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

function factTokens(s) {
  return new Set(normFact(s).split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !COVER_STOP.has(t)));
}

function coverScore(stored, gold) {
  const A = factTokens(stored);
  const B = factTokens(gold);
  if (!B.size) return 0;
  let inter = 0;
  for (const t of B) if (A.has(t)) inter++;
  return inter / B.size;
}

function isCorrectStored(text, goldFacts, noiseSpans, match) {
  const n = normFact(text);
  if (!n) return false;
  for (const span of noiseSpans || []) {
    const ns = normFact(span);
    if (ns && n.includes(ns)) return false;
  }
  if (match === "cover") {
    if (wordCount(n) > COVER_MAX_WORDS) return false;
    return (goldFacts || []).some((g) => {
      const ng = normFact(g);
      if (!ng) return false;
      if (n === ng) return true;
      if (n.includes(ng) || ng.includes(n)) return true;
      return coverScore(n, ng) >= COVER_MIN;
    });
  }
  return (goldFacts || []).some((g) => n === normFact(g));
}

function extractionPrecisionStats(results, corpus) {
  const cases = joinExtractCases(results, corpus);
  let nStored = 0;
  let nCorrect = 0;
  let nNoise = 0;
  const byCase = [];
  let nPii = 0;
  let nPiiRefused = 0;
  for (const c of cases) {
    const stored = c.stored || [];
    let correct = 0;
    let noisy = 0;
    const match = c.extract_match === "cover" ? "cover" : "exact";
    for (const text of stored) {
      nStored++;
      if (isCorrectStored(text, c.gold_facts, c.noise, match)) {
        nCorrect++;
        correct++;
      } else {
        nNoise++;
        noisy++;
      }
    }
    const pii = !!c.expect_refusal;
    const refusedOk = pii && c.refused && stored.length === 0;
    if (pii) {
      nPii++;
      if (refusedOk) nPiiRefused++;
    }
    byCase.push({
      id: c.id,
      n_stored: stored.length,
      n_correct: correct,
      n_noise: noisy,
      expect_refusal: pii,
      refused: !!c.refused,
      refused_ok: refusedOk,
    });
  }
  // Vacuous precision: labeled cases that stored nothing (all correctly
  // refused PII, or a runner that produced no records) have no false
  // positives. Unlabeled input (no gold_facts anywhere) is not a scored
  // extraction corpus — rate 0 so computeAll on a duplicates result
  // doesn't look like a perfect extraction run.
  let rate;
  if (!cases.length) rate = 0;
  else if (!nStored) rate = 1;
  else rate = nCorrect / nStored;
  return {
    n_labeled: cases.length,
    n_stored: nStored,
    n_correct: nCorrect,
    n_noise: nNoise,
    n_pii: nPii,
    n_pii_refused: nPiiRefused,
    pii_refusal_rate: nPii ? nPiiRefused / nPii : 1,
    rate,
    byCase,
  };
}

/*
 * extraction_precision — of the things save() actually persisted from a
 * messy input, the fraction that are legitimate atomic facts.
 *
 *     precision = n_correct / n_stored
 *
 *   n_stored   = records the system wrote (the caller hands the per-write
 *                delta of `store.current()`, not a wish). A restatement
 *                confirm that writes nothing contributes 0. A refusal
 *                that writes nothing contributes 0.
 *   n_correct  = those stored texts that (a) equal one of the case's
 *                gold atomic facts after whitespace-collapse + case-fold
 *                and (b) contain none of the case's noise spans.
 *
 * Exact equality, not containment: today's save() stores the raw blob,
 * which *contains* the gold fact plus filler/imperative/sibling-fact.
 * Counting that as correct would make the pre-extraction baseline look
 * healthy — the opposite of what RM-01 is for. A blob is noise.
 *
 * PII / secrets: gold_facts is [] and expect_refusal is true. Storing
 * the payload is a false positive (n_stored += 1, n_correct += 0).
 * Refusing (stored=[], refused=true) adds nothing to either count, so
 * it does not dilute precision; pii_refusal_rate in `explain` is the
 * dedicated readout (refused-and-wrote-nothing / PII cases).
 *
 * Vacuous: labeled cases + zero stored → 1.0 (no false positives).
 * That is the all-refuse cheat: precision aces, recall@5 and
 * extraction_recall are the backstop. Unlabeled input → 0.
 *
 * results shape: { cases: [{ id?, stored: [{text}|string], refused? }] }
 * corpus shape:  { cases: [{ id?, gold_facts: [string], noise: [string],
 *                            expect_refusal? }] }
 *            or  { writes: same } (assembled from the JSONL).
 * Zip by id when both sides have one, else by index. A case is labeled
 * iff `gold_facts` is an array (empty = "store nothing").
 */
register({
  name: "extraction_precision",
  description: "Fraction of stored records that match a gold atomic fact and contain no labeled noise.",
  compute(results, corpus) { return extractionPrecisionStats(results, corpus).rate; },
  explain: extractionPrecisionStats,
});

function extractionRecallStats(results, corpus) {
  const cases = joinExtractCases(results, corpus);
  let nGold = 0;
  let nHit = 0;
  const byCase = [];
  for (const c of cases) {
    const stored = c.stored || [];
    const match = c.extract_match === "cover" ? "cover" : "exact";
    let hit = 0;
    for (const g of c.gold_facts || []) {
      nGold++;
      if (stored.some((text) => isCorrectStored(text, [g], c.noise, match))) {
        nHit++;
        hit++;
      }
    }
    byCase.push({
      id: c.id,
      n_gold: (c.gold_facts || []).length,
      n_hit: hit,
    });
  }
  // Unlabeled (no gold_facts anywhere) → 0, same as precision, so computeAll
  // on a duplicates result does not look like a perfect extraction run.
  // Labeled PII-only (gold_facts all empty) → 1: nothing to recover.
  // The refuse-everything cheat on a gold-bearing corpus: precision 1.0
  // (vacuous) and recall 0 (every gold fact missed). That's the anti-cheat.
  let rate;
  if (!cases.length) rate = 0;
  else if (!nGold) rate = 1;
  else rate = nHit / nGold;
  return {
    n_labeled: cases.length,
    n_gold: nGold,
    n_hit: nHit,
    rate,
    byCase,
  };
}

/*
 * extraction_recall — of the gold atomic facts, the fraction for which
 * save() actually persisted a matching record.
 *
 *     recall = |gold facts with a matching stored record| / |gold facts|
 *
 * Matching is the same equality as extraction_precision (whitespace-
 * collapsed, case-folded, no noise span). Micro-averaged across labeled
 * writes so a split that stores both halves scores 2/2, and a dropped
 * write scores 0/N for that write's gold.
 *
 * PII writes have gold_facts: [] and do not enter the denominator.
 * Vacuous precision (refuse everything → 0 stored → 1.0) cannot hide
 * here: a gold-bearing corpus would report recall 0.
 *
 * results / corpus shapes: same as extraction_precision.
 */
register({
  name: "extraction_recall",
  description: "Fraction of gold atomic facts for which a matching record was stored.",
  compute(results, corpus) { return extractionRecallStats(results, corpus).rate; },
  explain: extractionRecallStats,
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

function isSaveRefusal(msg) {
  const s = String(msg || "");
  // "Nothing to save" is empty input, not a secret guard. The 0001
  // refusal is "Not saved — that looks like … Secrets don't belong in memory."
  if (/nothing to save/i.test(s)) return false;
  if (/not saved/i.test(s)) return true;
  if (/secrets don't belong/i.test(s)) return true;
  return false;
}

module.exports = {
  scoreSingle, scoreRepeat, containsAll, fieldSignals,
  register, getMetric, listMetrics, computeMetric, explainMetric, computeAll,
  makeRecallAtK, groupsFromWrites, parsePrimaryHits,
  normFact, isCorrectStored, isSaveRefusal,
  COVER_MAX_WORDS, coverScore,
};
