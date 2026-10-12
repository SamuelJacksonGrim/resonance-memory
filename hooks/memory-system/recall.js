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
 * recall.js — semantic retrieval over a memory directory.
 * Port of tools/recall.ps1 (2026-10-11 incremental rebuild). Ranking is cosine
 * only. Milestones are listed, never ranked. Rebuild reuses a vector when the
 * SHA-256 of "model|embedded text" and the model name still match.
 *
 * Usage:
 *   node recall.js --rebuild [--full] [--history]
 *   node recall.js --query "..." [--top 5] [--history]
 *   node recall.js --plan
 *
 * The memory folder has no default: pass --memory-dir or set RECALL_MEMORY (the installer sets it).
 * Cache: --cache, else RECALL_CACHE, else ~/.resonance-memory/memory-embeddings.json.
 * Embedder: --endpoint / RECALL_ENDPOINT (else EMBED_ENDPOINT, RM's variable; a full .../v1/embeddings URL or a
 * base URL) and --model / RECALL_MODEL. The model deliberately does NOT follow RM's EMBED_MODEL: pointing RM at a
 * different embedder shouldn't silently change the vectors this cache was built with.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sources = require("./sources.js");

const DEFAULT_MEMORY = "";   // none: every install names its own folder (RECALL_MEMORY / --memory-dir)
const DEFAULT_CACHE = path.join(os.homedir(), ".resonance-memory", "memory-embeddings.json");
const DEFAULT_ENDPOINT = "http://localhost:1234";
const DEFAULT_MODEL = "text-embedding-nomic-embed-text-v1.5";
const EMBED_CHARS = 2200;
const LOCK_WAIT_MS = 300000;
const EMBED_TIMEOUT_MS = 120000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ioOf(opts) {
  const o = opts || {};
  return {
    host: o.host || ((m) => process.stderr.write(String(m) + "\n")),
    out: o.out || ((m) => process.stdout.write(String(m) + "\n")),
  };
}

function embeddingsUrl(endpoint) {
  const e = String(endpoint || "").trim().replace(/\/+$/, "");
  if (/\/v1\/embeddings$/i.test(e)) return e;
  return e + "/v1/embeddings";
}

function resolveConfig(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  let memoryDir = o.memoryDir || env.RECALL_MEMORY || DEFAULT_MEMORY;
  let cache = o.cache || env.RECALL_CACHE || DEFAULT_CACHE;
  const endpoint = o.endpoint || env.RECALL_ENDPOINT || env.EMBED_ENDPOINT || DEFAULT_ENDPOINT;
  const model = o.model || env.RECALL_MODEL || DEFAULT_MODEL;
  const history = !!o.history;
  if (history) {
    memoryDir = path.join(memoryDir, "history");
    cache = String(cache).replace(/\.json$/i, "-history.json");
  }
  const top = o.top == null ? 5 : o.top;
  return {
    memoryDir,
    cache,
    endpoint,
    model,
    history,
    full: !!o.full,
    query: o.query,
    top,
    resultPath: o.resultPath || "",
    lockTimeoutMs: o.lockTimeoutMs == null ? LOCK_WAIT_MS : o.lockTimeoutMs,
    timeoutMs: o.timeoutMs == null ? EMBED_TIMEOUT_MS : o.timeoutMs,
    embed: o.embed || null,
  };
}

function getField(text, key, fallback) {
  const re = new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*[\"']?(.+?)[\"']?\\s*$", "im");
  const m = re.exec(text == null ? "" : String(text));
  return m ? m[1] : fallback;
}

function parseWeight(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) throw new Error("Cannot convert weight '" + raw + "' to a number.");
  return n;
}

function documentText(baseName, raw, desc) {
  const description = desc == null ? getField(raw, "description", baseName) : desc;
  const window = raw.length <= EMBED_CHARS ? raw : raw.slice(0, EMBED_CHARS);
  return "search_document: " + baseName + ". " + description + ". " + window;
}

function contentHash(model, doc) {
  return crypto.createHash("sha256").update(String(model) + "|" + doc, "utf8").digest("hex");
}

function eqCi(a, b) {
  return String(a == null ? "" : a).toLowerCase() === String(b == null ? "" : b).toLowerCase();
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function formatFixed(n, digits) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return x.toLocaleString("en-US", {
    useGrouping: true,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function isMilestone(entry) {
  return eqCi(entry && entry.persistence, "milestone");
}

function writeUtf8(filePath, text) {
  const parent = path.dirname(filePath);
  if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(filePath, text, { encoding: "utf8" });
}

function readCacheEntries(cachePath) {
  let text = fs.readFileSync(cachePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

function ciMap() {
  const m = new Map();
  return {
    get(k) { return m.get(String(k).toLowerCase()); },
    set(k, v) { m.set(String(k).toLowerCase(), v); },
    has(k) { return m.has(String(k).toLowerCase()); },
    keys() { return m.keys(); },
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function stealStaleLock(lockDir) {
  const pidPath = path.join(lockDir, "pid");
  let pid = NaN;
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(lockDir).mtimeMs;
    pid = Number(String(fs.readFileSync(pidPath, "utf8")).trim());
  } catch { /* pid not written yet, or already removed */ }
  if (pidAlive(pid)) return false;
  if (!Number.isInteger(pid) && age < 2000) return false;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(cachePath, timeoutMs) {
  const lockDir = cachePath + ".lock";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (!stealStaleLock(lockDir)) {
        if (Date.now() >= deadline) return null;
        const left = deadline - Date.now();
        await sleep(Math.min(50, Math.max(1, left)));
        continue;
      }
      continue;
    }
    const pidPath = path.join(lockDir, "pid");
    let fd = null;
    try {
      fd = fs.openSync(pidPath, "wx");
      fs.writeSync(fd, String(process.pid));
    } catch (err) {
      try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw err;
    }
    return { lockDir, fd, pidPath };
  }
}

function releaseLock(lock) {
  if (!lock) return;
  try { if (lock.fd != null) fs.closeSync(lock.fd); } catch { /* ignore */ }
  try { fs.rmSync(lock.lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function recallFiles(cfg) {
  if (!fs.existsSync(cfg.memoryDir) || !fs.statSync(cfg.memoryDir).isDirectory()) {
    return { error: "No directory at " + cfg.memoryDir + ". Cache not touched." };
  }
  if (cfg.history) {
    // Memory dir is already .../history. Rel paths are from its parent,
    // so a file is history/<name>.md — the same string recall.ps1 stores.
    const folder = path.resolve(cfg.memoryDir);
    const parent = path.dirname(folder);
    const files = sources.listHistoryFlat(folder).map((f) => ({
      fullPath: f.fullPath,
      baseName: f.baseName,
      rel: sources.relOf(parent, f.fullPath) || ("history/" + f.name),
    }));
    return { files };
  }
  const files = sources.liveFiles(cfg.memoryDir).map((f) => ({
    fullPath: f.fullPath,
    baseName: f.baseName,
    rel: f.rel,
  }));
  return { files };
}

function duplicateMessage(files) {
  const seen = new Map();
  for (const f of files) {
    const key = f.baseName.toLowerCase();
    if (seen.has(key)) {
      return "Duplicate basename '" + f.baseName + "' (" + seen.get(key) + " and " + f.fullPath + "). Cache NOT modified.";
    }
    seen.set(key, f.fullPath);
  }
  return null;
}

function rowFromFile(f, model) {
  const raw = sources.readText(f.fullPath);
  const description = getField(raw, "description", f.baseName);
  const doc = documentText(f.baseName, raw, description);
  return {
    name: f.baseName,
    description,
    rel: f.rel,
    persistence: getField(raw, "persistence", "standing"),
    weight: parseWeight(getField(raw, "weight", "0.5")),
    doc,
    hash: contentHash(model, doc),
  };
}

async function embedText(text, cfg) {
  if (cfg.embed) return cfg.embed(text);
  const url = embeddingsUrl(cfg.endpoint);
  const body = JSON.stringify({ model: cfg.model, input: [text] });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    const why = err && err.name === "AbortError" ? "timeout" : (err && err.message) || String(err);
    throw new Error("endpoint unreachable at " + cfg.endpoint + " (" + why + ") - is LM Studio running?");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error("endpoint unreachable at " + cfg.endpoint + " (HTTP " + res.status + (detail ? " " + detail : "") + ") - is LM Studio running?");
  }
  let data;
  try { data = await res.json(); }
  catch {
    throw new Error("endpoint returned no vector - is the embedding model '" + cfg.model + "' loaded?");
  }
  const vec = data && data.data && data.data[0] && data.data[0].embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("endpoint returned no vector - is the embedding model '" + cfg.model + "' loaded?");
  }
  return vec;
}

function usableVector(vec) {
  return Array.isArray(vec) && vec.length > 0;
}

function writeCacheAtomic(cachePath, json) {
  const tmp = cachePath + ".tmp";
  const bak = cachePath + ".bak";
  fs.writeFileSync(tmp, json, { encoding: "utf8" });
  if (fs.existsSync(cachePath)) fs.copyFileSync(cachePath, bak);
  try {
    if (fs.existsSync(cachePath)) {
      try {
        fs.renameSync(tmp, cachePath);
        return;
      } catch (err) {
        if (err.code !== "EEXIST" && err.code !== "EPERM") throw err;
      }
      fs.rmSync(cachePath, { force: true });
    }
    fs.renameSync(tmp, cachePath);
  } catch (err) {
    if (!fs.existsSync(cachePath) && fs.existsSync(bak)) {
      try { fs.copyFileSync(bak, cachePath); } catch { /* leave .tmp in place */ }
    }
    throw err;
  }
}

async function plan(opts) {
  const cfg = resolveConfig(opts);
  const io = ioOf(opts);
  const listed = recallFiles(cfg);
  if (listed.error) {
    io.host(listed.error);
    return { exitCode: 1, cfg };
  }
  const dup = duplicateMessage(listed.files);
  if (dup) {
    io.host(dup);
    io.out(dup);
    return { exitCode: 1, cfg };
  }
  const rows = listed.files.map((f) => {
    const row = rowFromFile(f, cfg.model);
    return {
      name: row.name,
      rel: row.rel,
      hash: row.hash,
      description: row.description,
      persistence: row.persistence,
      weight: row.weight,
    };
  });
  const json = JSON.stringify(rows);
  if (cfg.resultPath) writeUtf8(cfg.resultPath, json);
  else io.out(json);
  return { exitCode: 0, cfg, rows };
}

async function rebuild(opts) {
  const cfg = resolveConfig(opts);
  const io = ioOf(opts);
  // Fail before the lock when the directory is already missing, so a bad path
  // never creates a cache folder. The file list itself is still taken inside
  // the lock, so a rebuild that waited sees the latest files.
  if (!fs.existsSync(cfg.memoryDir) || !fs.statSync(cfg.memoryDir).isDirectory()) {
    io.host("No directory at " + cfg.memoryDir + ". Cache not touched.");
    return { exitCode: 1, cfg };
  }
  fs.mkdirSync(path.dirname(cfg.cache), { recursive: true });
  const lock = await acquireLock(cfg.cache, cfg.lockTimeoutMs);
  if (!lock) {
    const msg = "Another rebuild held the lock for 5 min; giving up. Cache untouched.";
    io.host(msg);
    io.out(msg);
    return { exitCode: 1, cfg };
  }
  try {
    const old = ciMap();
    if (!cfg.full && fs.existsSync(cfg.cache)) {
      try {
        for (const e of readCacheEntries(cfg.cache)) {
          if (e && e.name) old.set(e.name, e);
        }
      } catch { /* unreadable cache: embed everything */ }
    }
    const listed = recallFiles(cfg);
    if (listed.error) {
      io.host(listed.error);
      return { exitCode: 1, cfg };
    }
    const dup = duplicateMessage(listed.files);
    if (dup) {
      io.host(dup);
      io.out(dup);
      return { exitCode: 1, cfg };
    }
    const rows = listed.files.map((f) => {
      const row = rowFromFile(f, cfg.model);
      const prev = old.get(f.baseName);
      const reuse = !!(prev && eqCi(prev.hash, row.hash) && eqCi(prev.model, cfg.model) && usableVector(prev.vector));
      row.reuse = reuse;
      row.prev = prev || null;
      return row;
    });
    const todo = rows.filter((r) => !r.reuse);
    if (todo.length > 0) {
      try {
        await embedText("search_query: healthcheck", cfg);
      } catch (err) {
        const msg = "Rebuild aborted: " + err.message + " Cache NOT modified.";
        io.host(msg);
        io.out(msg);
        return { exitCode: 1, cfg };
      }
    }
    const outRows = [];
    let embedded = 0;
    for (const p of rows) {
      let vec;
      if (p.reuse) vec = p.prev.vector;
      else {
        io.host("  embedding " + p.name + " ...");
        try {
          vec = await embedText(p.doc, cfg);
          embedded++;
        } catch (err) {
          io.host("  FAILED on " + p.name + ": " + err.message);
          const msg = "Rebuild aborted after a failed embedding. Cache NOT modified.";
          io.host(msg);
          io.out(msg);
          return { exitCode: 1, cfg };
        }
      }
      outRows.push({
        name: p.name,
        description: p.description,
        persistence: p.persistence,
        weight: p.weight,
        rel: p.rel,
        model: cfg.model,
        hash: p.hash,
        vector: vec,
      });
    }
    if (outRows.length === 0) {
      const msg = "No memory files found; cache NOT modified.";
      io.host(msg);
      io.out(msg);
      return { exitCode: 1, cfg };
    }
    writeCacheAtomic(cfg.cache, JSON.stringify(outRows));
    const names = ciMap();
    for (const p of rows) names.set(p.name, true);
    let dropped = 0;
    for (const k of old.keys()) if (!names.has(k)) dropped++;
    const summary = "Cached " + outRows.length + " memories -> " + cfg.cache
      + "  (embedded " + embedded + ", reused " + (outRows.length - embedded) + ", dropped " + dropped + ")";
    io.host(summary);
    io.out(summary);
    return { exitCode: 0, cfg, embedded, reused: outRows.length - embedded, dropped, count: outRows.length, summary };
  } finally {
    releaseLock(lock);
  }
}

async function search(opts) {
  const cfg = resolveConfig(opts);
  const io = ioOf(opts);
  if (!cfg.query) {
    io.host("Need -Query, -Rebuild, or -Plan.");
    return { exitCode: 0, cfg };
  }
  if (!fs.existsSync(cfg.cache)) {
    io.host("No cache. Run -Rebuild first.");
    return { exitCode: 0, cfg };
  }
  const mem = readCacheEntries(cfg.cache);
  let qv;
  try {
    qv = await embedText("search_query: " + cfg.query, cfg);
  } catch (err) {
    io.host("Cannot search: " + err.message);
    io.host("Load the embedding model '" + cfg.model + "' in LM Studio, then retry.");
    return { exitCode: 0, cfg };
  }
  const milestones = mem.filter((e) => isMilestone(e))
    .sort((a, b) => Number(b.weight) - Number(a.weight));
  io.host("");
  io.host("ALWAYS LOADED (milestone - not ranked, not optional)");
  for (const m of milestones) {
    io.host("  [" + formatFixed(m.weight, 2) + "] " + m.name + "  " + (m.rel || ""));
  }
  io.host("");
  io.host("RETRIEVED for: \"" + cfg.query + "\"");
  io.host("  " + pad("score", 8) + " " + pad("cosine", 8) + " " + pad("weight", 8) + " memory");
  const ranked = mem.filter((e) => !isMilestone(e)).map((e) => {
    const c = cosine(qv, e.vector);
    return { n: e.name, cos: c, w: e.weight, score: c, rel: e.rel || "" };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return 0;
  }).slice(0, cfg.top);
  for (const row of ranked) {
    io.host(
      "  " + pad(formatFixed(row.score, 4), 8) + " "
      + pad(formatFixed(row.cos, 4), 8) + " "
      + pad(formatFixed(row.w, 2), 8) + " "
      + row.n + "  " + row.rel
    );
  }
  io.host("");
  const hits = ranked.map((row) => ({
    name: row.n,
    rel: row.rel,
    score: row.score,
    cosine: row.cos,
    weight: row.w,
  }));
  if (cfg.resultPath) {
    writeUtf8(cfg.resultPath, JSON.stringify({ query: cfg.query, hits }));
  }
  return { exitCode: 0, cfg, hits, milestones };
}

function parseArgs(argv) {
  const out = {};
  const unknown = (tok) => { throw new Error("Unknown argument: " + tok); };
  for (let i = 0; i < argv.length; i++) {
    let tok = argv[i];
    let inline = null;
    const eq = tok.indexOf("=");
    if (tok.startsWith("-") && eq > 1) {
      inline = tok.slice(eq + 1);
      tok = tok.slice(0, eq);
    }
    const key = tok.replace(/^-+/, "").toLowerCase();
    const need = () => {
      if (inline != null) return inline;
      if (i + 1 >= argv.length) throw new Error("Missing value for " + argv[i]);
      return argv[++i];
    };
    switch (key) {
      case "query": out.query = need(); break;
      case "rebuild": out.rebuild = true; break;
      case "top": out.top = Number(need()); break;
      case "memorydir":
      case "memory-dir": out.memoryDir = need(); break;
      case "cache": out.cache = need(); break;
      case "endpoint": out.endpoint = need(); break;
      case "model": out.model = need(); break;
      case "history": out.history = true; break;
      case "full": out.full = true; break;
      case "plan": out.plan = true; break;
      case "resultpath":
      case "result":
      case "result-path": out.resultPath = need(); break;
      default: unknown(argv[i]);
    }
  }
  if (out.top != null && (!Number.isInteger(out.top) || out.top < 0)) {
    throw new Error("Top must be a non-negative integer.");
  }
  return out;
}

async function main(argv, opts) {
  const extra = opts || {};
  let args;
  try { args = parseArgs(argv || []); }
  catch (err) {
    ioOf(extra).host(err.message);
    return 1;
  }
  const merged = Object.assign({}, extra, args);
  if (args.plan && (args.rebuild || args.query)) {
    ioOf(extra).host("Use -Plan on its own.");
    return 1;
  }
  if (!fs.existsSync(path.join(__dirname, "sources.js"))) {
    ioOf(extra).host("Missing sources.js beside recall.js. Cache not touched.");
    return 1;
  }
  if (args.plan) return (await plan(merged)).exitCode;
  if (args.rebuild) return (await rebuild(merged)).exitCode;
  if (!args.query) {
    ioOf(extra).host("Need -Query, -Rebuild, or -Plan.");
    return 0;
  }
  return (await search(merged)).exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (err) => {
      process.stderr.write(String(err && err.stack || err) + "\n");
      process.exit(1);
    }
  );
}

module.exports = {
  DEFAULT_MEMORY,
  DEFAULT_CACHE,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  EMBED_CHARS,
  LOCK_WAIT_MS,
  embeddingsUrl,
  resolveConfig,
  getField,
  parseWeight,
  documentText,
  contentHash,
  cosine,
  formatFixed,
  readCacheEntries,
  acquireLock,
  releaseLock,
  plan,
  rebuild,
  search,
  parseArgs,
  main,
  embedText,
  writeCacheAtomic,
};
