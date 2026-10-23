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
 * eval-lexical.js — measure the lexical fallback against the live semantic hook.
 *
 * Read-only on the memory folder. Embeds queries only (the document cache
 * is reused). Writes nothing next to the live embeddings file.
 *
 *   node hooks/memory-system/eval-lexical.js
 *   node hooks/memory-system/eval-lexical.js --sample 80 --seed 20261017
 *
 * Prints the gate sweep used to lock NORM_MIN / MIN_MATCHED in lexical.js.
 * Numbers belong in NOTES-lexical.md; re-run when the live folder or the
 * gate changes.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const sources = require("./sources.js");
const recall = require("./recall.js");
const lexical = require("./lexical.js");

const DEFAULT_MEMORY = "C:\\Users\\spamw\\.claude\\projects\\C--Users-spamw\\memory";
const DEFAULT_TRANSCRIPTS = "C:\\Users\\spamw\\.claude\\projects\\C--Users-spamw";
const DEFAULT_CACHE = "C:\\Users\\spamw\\tools\\memory-embeddings.json";
const COSINE_GATE = 0.70;
const MAX_HITS = 3;
const MIN_CHARS = 12;

const HELD_QUERIES = [
  "how should I talk to Samuel when he is upset and spiraling",
  "Koneko care stance before I change how the speech cortex behaves",
  "how do I launch Talk to RFE-Core2 and what does pause do",
  "Resonance Memory false positive filter versus warm field booster",
  "Elden Ring regulation bin rune drops SoulReward",
  "where is the corpus worklist and which source is next",
  "commit this from PowerShell using WSL git",
  "TowerDef is paused what was the cold hell setting",
  "ComfyUI local image generation pony vtubing pipeline",
  "nonce-7f3a9c2e do not deflate his work or queue for permission",
];

function parseArgs(argv) {
  const out = {
    sample: 80,
    seed: 20261017,
    memoryDir: process.env.RECALL_MEMORY || DEFAULT_MEMORY,
    transcripts: DEFAULT_TRANSCRIPTS,
    cache: process.env.RECALL_CACHE || DEFAULT_CACHE,
    endpoint: process.env.RECALL_ENDPOINT || process.env.EMBED_ENDPOINT || recall.DEFAULT_ENDPOINT,
    model: process.env.RECALL_MODEL || recall.DEFAULT_MODEL,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const key = tok.replace(/^-+/, "").toLowerCase();
    const need = () => {
      if (i + 1 >= argv.length) throw new Error("Missing value for " + tok);
      return argv[++i];
    };
    if (key === "sample") out.sample = Number(need());
    else if (key === "seed") out.seed = Number(need());
    else if (key === "memory-dir" || key === "memorydir") out.memoryDir = need();
    else if (key === "transcripts") out.transcripts = need();
    else if (key === "cache") out.cache = need();
    else if (key === "endpoint") out.endpoint = need();
    else if (key === "model") out.model = need();
    else if (key === "help" || key === "h") out.help = true;
    else throw new Error("Unknown argument: " + tok);
  }
  return out;
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function textFromUser(rec) {
  if (!rec || rec.type !== "user") return "";
  if (rec.isSidechain) return "";
  if (rec.origin && rec.origin.kind && rec.origin.kind !== "human") return "";
  const msg = rec.message;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block) continue;
    if (block.type === "tool_result") return "";
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function eligiblePrompt(text) {
  const t = String(text || "");
  if (t.indexOf("<system-reminder>") >= 0) return false;
  if (t.indexOf("<command-name>") >= 0) return false;
  if (t.indexOf("<command-message>") >= 0) return false;
  if (t.indexOf("<local-command") >= 0) return false;
  if (t.indexOf("[Request interrupted") >= 0) return false;
  const trimmed = t.trim();
  if (trimmed.length < MIN_CHARS) return false;
  if (trimmed.startsWith("/")) return false;
  if (trimmed.startsWith("--")) return false;
  if (trimmed.length > 1200) return false;
  return true;
}

function collectPrompts(dir) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch (err) { throw new Error("Cannot read transcripts at " + dir + ": " + err.message); }
  const found = [];
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    if (!names[i].toLowerCase().endsWith(".jsonl")) continue;
    const full = path.join(dir, names[i]);
    let raw;
    try { raw = fs.readFileSync(full, "utf8"); }
    catch { continue; }
    const lines = raw.split(/\r?\n/);
    for (let j = 0; j < lines.length; j++) {
      if (!lines[j]) continue;
      let rec;
      try { rec = JSON.parse(lines[j]); }
      catch { continue; }
      const text = textFromUser(rec);
      if (!eligiblePrompt(text)) continue;
      const key = text.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ text: key, file: names[i] });
    }
  }
  return found;
}

function liveIndex(memoryDir) {
  const files = sources.liveFiles(memoryDir);
  const counts = new Map();
  const rels = new Map();
  for (let i = 0; i < files.length; i++) {
    const k = String(files[i].baseName).toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!rels.has(k)) rels.set(k, files[i].rel);
  }
  return { files, counts, rels };
}

function semanticHits(queryVec, cacheEntries, live) {
  const qv = queryVec;
  let qn = 0;
  for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i];
  qn = Math.sqrt(qn);
  if (qn === 0) return [];
  const scored = [];
  for (let i = 0; i < cacheEntries.length; i++) {
    const e = cacheEntries[i];
    if (live.counts.get(String(e.name).toLowerCase()) !== 1) continue;
    const v = e.vector;
    if (!Array.isArray(v) || !v.length) continue;
    const cos = recall.cosine(qv, v);
    scored.push({
      name: e.name,
      desc: e.description == null ? "" : String(e.description),
      cos,
      rel: live.rels.get(String(e.name).toLowerCase()) || e.rel || "",
    });
  }
  const hits = recall.bestByName(scored, "name", "cos")
    .filter((h) => h.cos >= COSINE_GATE);
  hits.sort((a, b) => b.cos - a.cos);
  return hits.slice(0, MAX_HITS);
}

async function embedBatch(texts, cfg) {
  const out = [];
  const batch = 8;
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const vecs = await Promise.all(slice.map((t) => recall.embedText("search_query: " + t, cfg)));
    for (let j = 0; j < vecs.length; j++) out.push(vecs[j]);
    process.stderr.write("  embedded " + out.length + "/" + texts.length + "\n");
  }
  return out;
}

function namesOf(hits) {
  return (hits || []).map((h) => String(h.name).toLowerCase());
}

function overlap(a, b) {
  const sb = new Set(b);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (sb.has(a[i])) n++;
  return n;
}

function applyGate(ranked, gate) {
  return lexical.gated(ranked, gate);
}

function pct(n, d) {
  if (!d) return "n/a";
  return (100 * n / d).toFixed(1) + "%";
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function preview(text, n) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

async function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: node eval-lexical.js [--sample 80] [--seed 20261017]\n");
    return 0;
  }
  if (!fs.existsSync(args.memoryDir)) {
    process.stderr.write("No memory dir at " + args.memoryDir + "\n");
    return 1;
  }
  if (!fs.existsSync(args.cache)) {
    process.stderr.write("No vector cache at " + args.cache + "\n");
    return 1;
  }

  const live = liveIndex(args.memoryDir);
  const cacheEntries = recall.readCacheEntries(args.cache);
  process.stderr.write("Live files: " + live.files.length + "\n");
  process.stderr.write("Cache rows: " + cacheEntries.length + "\n");

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lexical-eval-"));
  const loaded = lexical.loadIndex({
    memoryDir: args.memoryDir,
    cache: path.join(scratch, "unused.json"),
    persist: false,
  });

  const all = collectPrompts(args.transcripts);
  process.stderr.write("Eligible unique prompts: " + all.length + "\n");
  const rng = mulberry32(args.seed >>> 0);
  const sampled = shuffle(all, rng).slice(0, args.sample);
  const held = HELD_QUERIES.map((text) => ({ text, file: "(held)" }));
  const prompts = held.concat(sampled);

  const embedCfg = {
    endpoint: args.endpoint,
    model: args.model,
    timeoutMs: 30000,
  };
  process.stderr.write("Embedding " + prompts.length + " queries via " + args.endpoint + "\n");
  let vectors;
  try {
    vectors = await embedBatch(prompts.map((p) => p.text), embedCfg);
  } catch (err) {
    process.stderr.write("Embedder failed: " + err.message + "\n");
    return 1;
  }

  const rows = [];
  for (let i = 0; i < prompts.length; i++) {
    const sem = semanticHits(vectors[i], cacheEntries, live);
    const ranked = lexical.rank(loaded.index, prompts[i].text);
    rows.push({ prompt: prompts[i], sem, ranked });
  }

  const gates = [];
  const norms = [0.20, 0.24, 0.28, 0.32, 0.36, 0.40, 0.45, 0.50];
  const matcheds = [1, 2];
  const coverages = [0, 0.35, 0.5];
  for (let m = 0; m < matcheds.length; m++) {
    for (let n = 0; n < norms.length; n++) {
      for (let c = 0; c < coverages.length; c++) {
        gates.push({
          minMatched: matcheds[m],
          minNorm: norms[n],
          minCoverage: coverages[c],
          maxHits: MAX_HITS,
        });
      }
    }
  }

  function scoreGate(gate) {
    let semFire = 0;
    let lexFire = 0;
    let both = 0;
    let noise = 0;
    let miss = 0;
    let top1 = 0;
    let top3 = 0;
    let top3Denom = 0;
    for (let i = 0; i < rows.length; i++) {
      const semNames = namesOf(rows[i].sem);
      const lexNames = namesOf(applyGate(rows[i].ranked, gate));
      const sOn = semNames.length > 0;
      const lOn = lexNames.length > 0;
      if (sOn) semFire++;
      if (lOn) lexFire++;
      if (sOn && lOn) {
        both++;
        if (semNames[0] === lexNames[0]) top1++;
        top3 += overlap(semNames, lexNames);
        top3Denom += Math.min(3, semNames.length);
      } else if (lOn && !sOn) noise++;
      else if (sOn && !lOn) miss++;
    }
    const silent = rows.length - semFire;
    return {
      gate,
      semFire,
      lexFire,
      both,
      noise,
      miss,
      silent,
      noiseRate: silent ? noise / silent : 0,
      missRate: semFire ? miss / semFire : 0,
      top1Rate: both ? top1 / both : 0,
      top3Rate: top3Denom ? top3 / top3Denom : 0,
      top1,
      top3,
      top3Denom,
    };
  }

  const scored = gates.map(scoreGate);

  // Prefer low noise, then low miss, then high top-1. Silence beats noise
  // is the product rule; the rest is tie-breaking.
  const rankedGates = scored.slice().sort((a, b) => {
    if (a.noiseRate !== b.noiseRate) return a.noiseRate - b.noiseRate;
    if (a.missRate !== b.missRate) return a.missRate - b.missRate;
    if (a.top1Rate !== b.top1Rate) return b.top1Rate - a.top1Rate;
    return b.top3Rate - a.top3Rate;
  });

  const shipped = scoreGate({
    minMatched: lexical.MIN_MATCHED,
    minNorm: lexical.NORM_MIN,
    minCoverage: 0,
    minRelative: lexical.RELATIVE_MIN,
    rareDfMax: lexical.RARE_DF_MAX,
    maxHits: MAX_HITS,
  });

  const lines = [];
  lines.push("lexical vs semantic hook");
  lines.push("memory: " + args.memoryDir);
  lines.push("cache:  " + args.cache);
  lines.push("live files: " + live.files.length + "   cache rows: " + cacheEntries.length);
  lines.push("prompts: " + rows.length + "  (" + held.length + " held + " + sampled.length + " sampled from " + all.length + " unique)");
  lines.push("seed " + args.seed + "  cosine gate " + COSINE_GATE);
  lines.push("");
  lines.push("semantic fired: " + shipped.semFire + "/" + rows.length + " (" + pct(shipped.semFire, rows.length) + ")");
  lines.push("");
  lines.push("gate sweep (sorted quietest-first):");
  lines.push(
    pad("matched", 8) + pad("norm", 7) + pad("cov", 6)
    + pad("noise", 14) + pad("miss", 14) + pad("both", 8)
    + pad("top1", 10) + "top3"
  );
  for (let i = 0; i < rankedGates.length; i++) {
    const s = rankedGates[i];
    const mark = (
      s.gate.minMatched === lexical.MIN_MATCHED
      && Math.abs(s.gate.minNorm - lexical.NORM_MIN) < 1e-9
      && s.gate.minCoverage === 0
    ) ? "  <-- shipped-ish (relative/rare from defaults)" : "";
    lines.push(
      pad(String(s.gate.minMatched), 8)
      + pad(s.gate.minNorm.toFixed(2), 7)
      + pad(s.gate.minCoverage.toFixed(2), 6)
      + pad(s.noise + "/" + s.silent + " " + pct(s.noise, s.silent), 14)
      + pad(s.miss + "/" + s.semFire + " " + pct(s.miss, s.semFire), 14)
      + pad(String(s.both), 8)
      + pad(pct(s.top1, s.both), 10)
      + pct(s.top3, s.top3Denom)
      + mark
    );
  }
  lines.push("");
  lines.push("shipped gate: minMatched=" + lexical.MIN_MATCHED + "  minNorm=" + lexical.NORM_MIN);
  lines.push(
    "  noise " + shipped.noise + "/" + shipped.silent + " (" + pct(shipped.noise, shipped.silent) + ")"
    + "   miss " + shipped.miss + "/" + shipped.semFire + " (" + pct(shipped.miss, shipped.semFire) + ")"
    + "   both " + shipped.both
    + "   top-1 " + pct(shipped.top1, shipped.both)
    + "   top-3 overlap " + pct(shipped.top3, shipped.top3Denom)
  );

  const shippedHits = rows.map((r) => ({
    prompt: r.prompt.text,
    held: r.prompt.file === "(held)",
    sem: namesOf(r.sem),
    lex: namesOf(applyGate(r.ranked, {
      minMatched: lexical.MIN_MATCHED,
      minNorm: lexical.NORM_MIN,
      minCoverage: 0,
      maxHits: MAX_HITS,
    })),
    topLex: r.ranked[0] ? {
      name: r.ranked[0].name,
      norm: r.ranked[0].norm,
      matched: r.ranked[0].matched,
      coverage: r.ranked[0].coverage,
      score: r.ranked[0].score,
    } : null,
  }));

  lines.push("");
  lines.push("noise examples (lexical fired, semantic silent):");
  let noiseN = 0;
  for (let i = 0; i < shippedHits.length && noiseN < 8; i++) {
    const r = shippedHits[i];
    if (r.lex.length && !r.sem.length) {
      lines.push("  Q: " + preview(r.prompt, 90));
      lines.push("     lex: " + r.lex.join(", ") + (r.topLex ? "  norm=" + r.topLex.norm.toFixed(3) : ""));
      noiseN++;
    }
  }
  if (!noiseN) lines.push("  (none)");

  lines.push("");
  lines.push("miss examples (semantic fired, lexical silent):");
  let missN = 0;
  for (let i = 0; i < shippedHits.length && missN < 8; i++) {
    const r = shippedHits[i];
    if (r.sem.length && !r.lex.length) {
      lines.push("  Q: " + preview(r.prompt, 90));
      lines.push("     sem: " + r.sem.join(", ")
        + (r.topLex ? "  lex-top=" + r.topLex.name + " norm=" + r.topLex.norm.toFixed(3) + " matched=" + r.topLex.matched : "  lex-top=none"));
      missN++;
    }
  }
  if (!missN) lines.push("  (none)");

  lines.push("");
  lines.push("held queries (the recall.js equivalence set):");
  for (let i = 0; i < held.length; i++) {
    const r = shippedHits[i];
    lines.push("  Q: " + r.prompt);
    lines.push("     sem: " + (r.sem.join(", ") || "(silent)"));
    lines.push("     lex: " + (r.lex.join(", ") || "(silent)")
      + (r.topLex ? "  top-norm=" + r.topLex.norm.toFixed(3) : ""));
  }

  // Offline hybrid note: RRF of cosine rank + BM25 rank, still gated by
  // cosine >= 0.70 on the dense arm. Reported, not shipped.
  let rrfTop1 = 0;
  let rrfBoth = 0;
  for (let i = 0; i < rows.length; i++) {
    const semNames = namesOf(rows[i].sem);
    if (!semNames.length) continue;
    const scores = new Map();
    function add(list, k) {
      for (let r = 0; r < list.length; r++) {
        const id = String(list[r]).toLowerCase();
        scores.set(id, (scores.get(id) || 0) + 1 / (k + r + 1));
      }
    }
    add(semNames, 60);
    add(namesOf(rows[i].ranked.slice(0, 10)), 60);
    const fused = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    rrfBoth++;
    if (fused[0] && fused[0][0] === semNames[0]) rrfTop1++;
  }
  lines.push("");
  lines.push("hybrid note (NOT shipped): RRF of semantic-gated names + BM25 top-10, k=60.");
  lines.push("  When semantic fired, RRF top-1 agreed with semantic top-1 "
    + rrfTop1 + "/" + rrfBoth + " (" + pct(rrfTop1, rrfBoth) + ").");
  lines.push("  Cosine already picked the top-1; fusion cannot beat that agreement");
  lines.push("  and would violate ranking=cosine-only. Left as a number, not a ranker.");

  const text = lines.join("\n") + "\n";
  process.stdout.write(text);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code || 0),
    (err) => {
      process.stderr.write(String(err && err.stack || err) + "\n");
      process.exit(1);
    }
  );
}

module.exports = { main, collectPrompts, eligiblePrompt, textFromUser };
