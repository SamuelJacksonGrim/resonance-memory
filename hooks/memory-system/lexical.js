#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
"use strict";

/*
 * lexical.js — BM25 fallback for folder recall when the embedder is down.
 *
 * Semantic recall (cosine >= 0.70, top 3) is the product when an embedder
 * answers. This path exists so a fresh install still surfaces memories
 * instead of failing silent on every message. It is a fallback, not a
 * second ranker mixed into cosine — see NOTES-lexical.md.
 *
 * Gate (measured on Samuel's live folder + real prompts, 2026-10-17):
 *   1. At least two query terms match, except a one-term query which
 *      may fire only when that term is rare (df <= 2) AND sits in the
 *      filename/description. "How's the process going?" otherwise dumps
 *      three Ember files because "process" is a title word.
 *   2. Length-normalised BM25 (score / sum of query IDF) >= 0.50.
 *   3. A 2nd/3rd hit must also clear 55% of the top hit's raw score, so
 *      a dominant filename match is not padded with weak cousins.
 * Silence beats noise. A raw BM25 number is not comparable across
 * queries, so we never inject on magnitude alone. See NOTES-lexical.md.
 */

const fs = require("fs");
const path = require("path");

const sources = require("./sources.js");

const K1 = 1.2;
// Same 2200-unit window as recall.documentText. Lexical should see the
// same slice cosine saw; a longer body would just pad BM25 dl.
const B = 0.75;
// Title (basename + description) is repeated this many times into the
// bag. Filenames in this corpus are the labels humans actually query
// ("elden-ring-regulation-modding"); without the boost, a long body
// with a passing mention outranks the file that is about the thing.
const TITLE_REPEATS = 3;
const MAX_HITS = 3;
// Normalised BM25 floor. Tuned in eval-lexical.js against the semantic
// hook on the live folder. 0.32 injected on 31% of prompts the semantic
// hook left silent. 0.50 keeps the held keyword queries (norm 1.0–1.9)
// and leaves 1/56 semantic-silent prompts firing (a real "chrome" token
// match). 0.45 still let the nonce distractor through at 0.48.
const NORM_MIN = 0.50;
const MIN_MATCHED = 2;
// 2nd/3rd hit vs the top hit. WSL-git's true file scores 1.95; the next
// (pi-emu) is 0.82 — related-ish, not the answer. 0.55 keeps clustered
// true sets (image-gen / vtuber / video-gen) and drops the tail.
const RELATIVE_MIN = 0.55;
// One-term queries may fire only if the term appears in this many docs
// or fewer. "process" is in 6 titles; "soulreward" is in 1.
const RARE_DF_MAX = 2;

// Function words. Kept small on purpose: dropping "memory" or "samuel"
// would hide the exact queries this folder is built to answer.
const STOP = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when",
  "at", "from", "to", "of", "in", "on", "for", "with", "by", "as",
  "is", "was", "are", "were", "be", "been", "being", "am",
  "this", "that", "these", "those", "it", "its", "it's",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
  "them", "his", "her", "their", "im", "ive", "youre", "dont", "doesnt",
  "not", "no", "nor", "so", "than", "too", "very", "can", "will", "just",
  "about", "into", "over", "after", "before", "again", "further",
  "how", "what", "where", "which", "who", "whom", "why",
  "do", "does", "did", "done", "have", "has", "had",
  "get", "got", "make", "made", "use", "used", "using",
  "also", "only", "own", "same", "other", "some", "any", "all",
  "each", "few", "more", "most", "such", "both", "between",
  "up", "down", "out", "off", "here", "there", "once",
  "should", "would", "could", "might", "must", "shall",
  "please", "hey", "hi", "hello", "ok", "okay", "yeah", "yes",
  "need", "want", "like", "know", "think", "going", "gonna",
  "something", "anything", "everything", "nothing",
]);

function tokenize(text) {
  const original = String(text || "");
  // Camel-split first so tf is honest. Then add the unsplit form of
  // identifiers ("SoulReward" → soul, reward, plus soulreward) once,
  // without double-counting ordinary words.
  const camel = original
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const out = [];
  const fromCamel = new Set();
  const camelParts = camel.toLowerCase().split(/[^a-z0-9]+/);
  for (let i = 0; i < camelParts.length; i++) {
    const t = camelParts[i];
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
    fromCamel.add(t);
  }
  const rawParts = original.toLowerCase().split(/[^a-z0-9]+/);
  for (let i = 0; i < rawParts.length; i++) {
    const t = rawParts[i];
    if (t.length < 2 || STOP.has(t)) continue;
    if (fromCamel.has(t)) continue;
    out.push(t);
  }
  return out;
}

function uniqueTerms(tokens) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function titleTokens(baseName, description) {
  const label = String(baseName || "").replace(/[-_]+/g, " ");
  const desc = description == null ? "" : String(description);
  return tokenize(label + " " + desc);
}

function getField(text, key, fallback) {
  // Byte-same regex as recall.getField — keep the two in lockstep.
  const re = new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*[\"']?(.+?)[\"']?\\s*$", "im");
  const m = re.exec(text == null ? "" : String(text));
  return m ? m[1].replace(/\\"/g, '"') : fallback;
}

function parseWeight(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : 0.5;
}

const EMBED_CHARS = 2200;

function stripFrontmatter(raw) {
  let t = String(raw || "");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  if (!t.startsWith("---")) return t;
  const lines = t.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return t;
}

function bodyTokens(raw) {
  // YAML keys (name, description, metadata, modified, ...) sit in every
  // file. Tokenising them collapses IDF and makes "process" / "type"
  // look rare. Description is already in the title field.
  const body = stripFrontmatter(raw);
  const window = body.length <= EMBED_CHARS ? body : body.slice(0, EMBED_CHARS);
  return tokenize(window);
}

function bagFor(baseName, description, raw, titleRepeats) {
  const title = titleTokens(baseName, description);
  const body = bodyTokens(raw);
  const repeats = titleRepeats == null ? TITLE_REPEATS : titleRepeats;
  const bag = [];
  for (let i = 0; i < repeats; i++) {
    for (let j = 0; j < title.length; j++) bag.push(title[j]);
  }
  for (let i = 0; i < body.length; i++) bag.push(body[i]);
  return { bag, title };
}

function tfMap(tokens) {
  const tf = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

function idf(index, term) {
  const n = index.df.get(term) || 0;
  // Lucene / BM25+ style: always positive, even for a term in every doc.
  return Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
}

function buildIndex(docs) {
  const df = new Map();
  let totalLen = 0;
  const rows = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const tokens = d.tokens || [];
    const tf = tfMap(tokens);
    const seen = tf.keys();
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    totalLen += tokens.length;
    const titleSet = new Set(d.titleTokens || []);
    rows.push({
      name: d.name,
      rel: d.rel || "",
      description: d.description == null ? "" : String(d.description),
      persistence: d.persistence || "standing",
      weight: d.weight,
      len: tokens.length,
      tf,
      titleSet,
    });
  }
  const N = rows.length;
  return {
    docs: rows,
    df,
    N,
    avgdl: N ? totalLen / N : 1,
  };
}

function bm25One(index, doc, term) {
  const f = doc.tf.get(term) || 0;
  if (!f) return 0;
  const denom = f + K1 * (1 - B + B * doc.len / index.avgdl);
  return idf(index, term) * (f * (K1 + 1)) / denom;
}

function scoreDoc(index, doc, queryTerms) {
  let s = 0;
  let matched = 0;
  let titleMatched = 0;
  let matchedMinDf = Infinity;
  for (let i = 0; i < queryTerms.length; i++) {
    const t = queryTerms[i];
    const part = bm25One(index, doc, t);
    if (part > 0) {
      matched++;
      const df = index.df.get(t) || 0;
      if (df < matchedMinDf) matchedMinDf = df;
    }
    if (doc.titleSet && doc.titleSet.has(t)) titleMatched++;
    s += part;
  }
  if (matchedMinDf === Infinity) matchedMinDf = 0;
  return { score: s, matched, titleMatched, matchedMinDf };
}

function queryMass(index, queryTerms) {
  let mass = 0;
  for (let i = 0; i < queryTerms.length; i++) mass += idf(index, queryTerms[i]);
  return mass;
}

function rank(index, query, opts) {
  const o = opts || {};
  const qTokens = tokenize(query);
  const qTerms = uniqueTerms(qTokens);
  if (!qTerms.length || !index || !index.docs || !index.docs.length) return [];
  const mass = queryMass(index, qTerms);
  const rows = [];
  for (let i = 0; i < index.docs.length; i++) {
    const d = index.docs[i];
    if (o.skipMilestones && String(d.persistence || "").toLowerCase() === "milestone") continue;
    const got = scoreDoc(index, d, qTerms);
    if (got.score <= 0) continue;
    let queryMinDf = Infinity;
    for (let q = 0; q < qTerms.length; q++) {
      const df = index.df.get(qTerms[q]) || 0;
      if (df < queryMinDf) queryMinDf = df;
    }
    rows.push({
      name: d.name,
      rel: d.rel,
      description: d.description,
      persistence: d.persistence,
      weight: d.weight,
      score: got.score,
      matched: got.matched,
      titleMatched: got.titleMatched,
      matchedMinDf: got.matchedMinDf,
      queryMinDf: queryMinDf === Infinity ? 0 : queryMinDf,
      qTerms: qTerms.length,
      coverage: qTerms.length ? got.matched / qTerms.length : 0,
      // score / sum(idf) ≈ 1 when every query term appears once in an
      // average-length doc (k1=1.2, b=0.75, dl=avgdl → saturation 1).
      // Title repeats can push it above 1; that is a real "this file
      // is named the thing you asked" signal, not a bug.
      norm: mass > 0 ? got.score / mass : 0,
    });
  }
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.norm !== a.norm) return b.norm - a.norm;
    return String(a.name).localeCompare(String(b.name));
  });
  return rows;
}

function defaultGate(opts) {
  const o = opts || {};
  return {
    minMatched: o.minMatched == null ? MIN_MATCHED : o.minMatched,
    minNorm: o.minNorm == null ? NORM_MIN : o.minNorm,
    minCoverage: o.minCoverage == null ? 0 : o.minCoverage,
    minRelative: o.minRelative == null ? RELATIVE_MIN : o.minRelative,
    rareDfMax: o.rareDfMax == null ? RARE_DF_MAX : o.rareDfMax,
    maxHits: o.maxHits == null ? MAX_HITS : o.maxHits,
  };
}

function passesGate(hit, gate) {
  if (!hit || hit.score <= 0) return false;
  if (hit.qTerms <= 1) {
    // One content token is almost always a common word. Fire only when
    // it is rare in the corpus and actually in the filename/description.
    if (hit.titleMatched < 1) return false;
    if (hit.queryMinDf > gate.rareDfMax) return false;
    if (!(hit.norm >= gate.minNorm)) return false;
    return true;
  }
  const need = Math.min(gate.minMatched, hit.qTerms);
  if (hit.matched < need) return false;
  if (!(hit.norm >= gate.minNorm)) return false;
  if (gate.minCoverage && !(hit.coverage >= gate.minCoverage)) return false;
  return true;
}

function gated(ranked, opts) {
  const gate = defaultGate(opts);
  const kept = [];
  let topScore = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (!passesGate(ranked[i], gate)) continue;
    if (!kept.length) {
      topScore = ranked[i].score;
      kept.push(ranked[i]);
    } else {
      if (gate.minRelative && ranked[i].score < gate.minRelative * topScore) continue;
      kept.push(ranked[i]);
    }
    if (kept.length >= gate.maxHits) break;
  }
  return kept;
}

function filesFor(cfg) {
  if (!cfg || !cfg.memoryDir) return [];
  if (cfg.history) {
    const folder = path.resolve(cfg.memoryDir);
    const parent = path.dirname(folder);
    return sources.listHistoryFlat(folder).map((f) => ({
      fullPath: f.fullPath,
      baseName: f.baseName,
      rel: sources.relOf(parent, f.fullPath) || ("history/" + f.name),
    }));
  }
  return sources.liveFiles(cfg.memoryDir).map((f) => ({
    fullPath: f.fullPath,
    baseName: f.baseName,
    rel: f.rel,
  }));
}

function fileStamp(fullPath) {
  try {
    const st = fs.statSync(fullPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function indexPathFor(cachePath) {
  if (!cachePath) return "";
  return String(cachePath).replace(/\.json$/i, "") + ".lexical.json";
}

function readIndexCache(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !Array.isArray(data.files)) return null;
    return data;
  } catch {
    return null;
  }
}

function writeIndexCache(file, payload) {
  if (!file) return;
  const parent = path.dirname(file);
  if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf8" });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { fs.renameSync(tmp, file); } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw err;
    }
  }
}

function cacheStillValid(cached, files, memoryDir, history) {
  if (!cached) return false;
  if (!!cached.history !== !!history) return false;
  if (String(cached.memoryDir || "").toLowerCase() !== String(memoryDir || "").toLowerCase()) return false;
  if (cached.titleRepeats !== TITLE_REPEATS) return false;
  if (cached.v !== 2) return false;
  if (!Array.isArray(cached.files) || cached.files.length !== files.length) return false;
  const byRel = new Map();
  for (let i = 0; i < cached.files.length; i++) {
    const row = cached.files[i];
    if (!row || !row.rel) return false;
    byRel.set(String(row.rel).toLowerCase(), row);
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const row = byRel.get(String(f.rel).toLowerCase());
    if (!row) return false;
    const st = fileStamp(f.fullPath);
    if (!st) return false;
    if (row.size !== st.size) return false;
    if (Math.abs(row.mtimeMs - st.mtimeMs) > 1) return false;
  }
  return true;
}

function docsFromCache(cached) {
  return (cached.files || []).map((row) => ({
    name: row.name,
    rel: row.rel,
    description: row.description,
    persistence: row.persistence,
    weight: row.weight,
    tokens: row.tokens || [],
    titleTokens: row.titleTokens || [],
  }));
}

function buildDocs(files) {
  const docs = [];
  const serial = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let raw;
    try { raw = sources.readText(f.fullPath); }
    catch { continue; }
    const description = getField(raw, "description", f.baseName);
    const persistence = getField(raw, "persistence", "standing");
    const weight = parseWeight(getField(raw, "weight", "0.5"));
    const packed = bagFor(f.baseName, description, raw, TITLE_REPEATS);
    const st = fileStamp(f.fullPath) || { mtimeMs: 0, size: 0 };
    docs.push({
      name: f.baseName,
      rel: f.rel,
      description,
      persistence,
      weight,
      tokens: packed.bag,
      titleTokens: packed.title,
    });
    serial.push({
      name: f.baseName,
      rel: f.rel,
      description,
      persistence,
      weight,
      tokens: packed.bag,
      titleTokens: packed.title,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
  return { docs, serial };
}

function loadIndex(opts) {
  const o = opts || {};
  const memoryDir = o.memoryDir;
  if (!memoryDir || !fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) {
    return { index: buildIndex([]), files: [], fromCache: false };
  }
  const files = filesFor({ memoryDir, history: !!o.history });
  const cacheFile = o.indexPath != null ? o.indexPath : indexPathFor(o.cache);
  if (!o.rebuild && cacheFile) {
    const cached = readIndexCache(cacheFile);
    if (cacheStillValid(cached, files, memoryDir, !!o.history)) {
      return { index: buildIndex(docsFromCache(cached)), files, fromCache: true };
    }
  }
  const built = buildDocs(files);
  if (o.persist !== false && cacheFile) {
    try {
      writeIndexCache(cacheFile, {
        v: 2,
        memoryDir,
        history: !!o.history,
        titleRepeats: TITLE_REPEATS,
        files: built.serial,
      });
    } catch { /* a missed cache is still a correct live index */ }
  }
  return { index: buildIndex(built.docs), files, fromCache: false };
}

function search(query, opts) {
  const loaded = loadIndex(opts);
  const ranked = rank(loaded.index, query, { skipMilestones: !!(opts && opts.skipMilestones) });
  const hits = gated(ranked, opts);
  return { hits, ranked, fromCache: loaded.fromCache, index: loaded.index };
}

function formatHookLine(hit) {
  const desc = hit.description == null ? "" : String(hit.description);
  const rel = hit.rel || "";
  // Deliberately not a cosine. A BM25 number in that slot would be read
  // as "0.73 means pretty sure" the way 0.73 cosine does. It does not.
  return "  - " + hit.name + " (keyword match) -- " + desc + "  [" + rel + "]";
}

function formatHookBlock(hits) {
  if (!hits || !hits.length) return "";
  const lines = ["[recall] Auto-surfaced memories that may bear on this message (read the file if relevant):"];
  for (let i = 0; i < hits.length; i++) lines.push(formatHookLine(hits[i]));
  return lines.join("\n") + "\n";
}

module.exports = {
  EMBED_CHARS,
  K1,
  B,
  TITLE_REPEATS,
  MAX_HITS,
  NORM_MIN,
  MIN_MATCHED,
  RELATIVE_MIN,
  RARE_DF_MAX,
  stripFrontmatter,
  STOP,
  tokenize,
  uniqueTerms,
  titleTokens,
  bagFor,
  buildIndex,
  idf,
  rank,
  defaultGate,
  passesGate,
  gated,
  filesFor,
  indexPathFor,
  loadIndex,
  search,
  formatHookLine,
  formatHookBlock,
};
