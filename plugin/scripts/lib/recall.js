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
 * Port of tools/recall.ps1 (2026-10-11 incremental rebuild; chunked 2026-10-22).
 * Ranking is cosine only when the embedder answers. If it doesn't, --query
 * falls back to the BM25 path in lexical.js (a fallback, not a hybrid ranker).
 * Live files are split into ~1800-character chunks (frontmatter stripped);
 * a file scores by its best chunk. Milestones rank like any other file; the
 * printed list only names them. Rebuild reuses a vector when the SHA-256 of
 * "model|embedded text" and the model name still match (keyed by name#chunk).
 *
 * Usage:
 *   node recall.js --rebuild [--full] [--history]
 *   node recall.js --query "..." [--top 5] [--history]
 *   node recall.js --plan
 *
 * The memory folder has no default. Resolution order for memory, cache, endpoint, and model:
 * flag, then RECALL_* env (endpoint also accepts EMBED_ENDPOINT), then
 * ~/.resonance-memory/memory-system.json, then the defaults below.
 * The model deliberately does NOT follow RM's EMBED_MODEL. Cache default:
 * ~/.resonance-memory/memory-embeddings.json. Endpoint default: http://localhost:1234.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sources = require("./sources.js");
const lexical = require("./lexical.js");

const DEFAULT_MEMORY = "";   // none: every install names its own folder (RECALL_MEMORY / --memory-dir)
const DEFAULT_CACHE = path.join(os.homedir(), ".resonance-memory", "memory-embeddings.json");
const DEFAULT_ENDPOINT = "http://localhost:1234";
const DEFAULT_MODEL = "text-embedding-nomic-embed-text-v1.5";
const CHUNK_CHARS = 1800;
const MAX_BLOCK_CHARS = 6000;
const LOCK_WAIT_MS = 300000;
const EMBED_TIMEOUT_MS = 120000;
// Hook/query probe: any HTTP response from /v1/models means the process
// is alive. Connection-refused is fast; a hung endpoint would otherwise
// eat the hook's 6 s embed timeout on every message. After a miss we
// remember for FAIL_TTL_MS and skip the probe.
const PROBE_MS = 400;
const FAIL_TTL_MS = 30000;

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

function modelsUrl(endpoint) {
  const e = String(endpoint || "").trim().replace(/\/+$/, "");
  if (/\/v1\/embeddings$/i.test(e)) return e.replace(/\/embeddings$/i, "/models");
  if (/\/v1$/i.test(e)) return e + "/models";
  return e + "/v1/models";
}

function embedderDownPath(cachePath) {
  return String(cachePath || "") + ".embedder-down";
}

function embedderRecentlyDown(cachePath, now, ttlMs) {
  if (!cachePath) return false;
  try {
    const raw = fs.readFileSync(embedderDownPath(cachePath), "utf8");
    const data = JSON.parse(raw);
    const at = Number(data && data.at);
    const ttl = ttlMs == null ? FAIL_TTL_MS : ttlMs;
    return Number.isFinite(at) && ((now == null ? Date.now() : now) - at) < ttl;
  } catch {
    return false;
  }
}

function markEmbedderDown(cachePath, now) {
  if (!cachePath) return;
  try {
    const file = embedderDownPath(cachePath);
    const parent = path.dirname(file);
    if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: now == null ? Date.now() : now }), "utf8");
  } catch { /* a missed marker just means the next message probes again */ }
}

function clearEmbedderDown(cachePath) {
  if (!cachePath) return;
  try { fs.rmSync(embedderDownPath(cachePath), { force: true }); } catch { /* ignore */ }
}

async function probeEmbedder(cfg) {
  const o = cfg || {};
  if (typeof o.probe === "function") return !!(await o.probe());
  const url = modelsUrl(o.endpoint);
  const ms = o.probeMs == null ? PROBE_MS : o.probeMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // Any HTTP response (200, 404, 500) means the process is listening.
    // A hang or connection-refused is the case we must not wait 6 s for.
    await fetch(url, { method: "GET", signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// A partial env (unit tests pass one) must not fall through to this process's
// real home, or a live memory-system.json would change the test.
function homeFromEnv(env) {
  const e = env || process.env;
  if (process.platform === "win32") {
    if (e.USERPROFILE) return e.USERPROFILE;
    if (e.HOMEDRIVE && e.HOMEPATH) return e.HOMEDRIVE + e.HOMEPATH;
    if (e.HOME) return e.HOME;
  } else {
    if (e.HOME) return e.HOME;
    if (e.USERPROFILE) return e.USERPROFILE;
  }
  if (e !== process.env) return "";
  try { return os.homedir() || ""; } catch { return ""; }
}

function pickString() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (typeof v !== "string") continue;
    if (v.trim() === "") continue;
    return v;
  }
  return "";
}

function defaultConfigPath(env) {
  const e = env || process.env;
  if (Object.prototype.hasOwnProperty.call(e, "RECALL_CONFIG")) {
    return e.RECALL_CONFIG ? e.RECALL_CONFIG : "";
  }
  const home = homeFromEnv(e);
  if (!home) return "";
  return path.join(home, ".resonance-memory", "memory-system.json");
}

function readMemorySystemConfig(env, configPath) {
  const file = configPath != null ? (configPath || "") : defaultConfigPath(env || process.env);
  if (!file) return { path: "", config: {}, error: null };
  if (!fs.existsSync(file)) return { path: file, config: {}, error: null };
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (err) { return { path: file, config: {}, error: err }; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { path: file, config: {}, error: new Error("not a JSON object") };
    }
    return { path: file, config: data, error: null };
  } catch (err) {
    return { path: file, config: {}, error: err };
  }
}

function runtimeFrom(env, overrides) {
  const e = env || process.env;
  const over = overrides || {};
  const loaded = over.skipConfig ? { config: {}, error: null, path: "" } : readMemorySystemConfig(e, over.configPath);
  const file = loaded.error ? {} : (loaded.config || {});
  return {
    memoryDir: pickString(over.memoryDir, e.RECALL_MEMORY, file.memoryDir, DEFAULT_MEMORY),
    cache: pickString(over.cache, e.RECALL_CACHE, file.cache, DEFAULT_CACHE),
    endpoint: pickString(over.endpoint, e.RECALL_ENDPOINT, e.EMBED_ENDPOINT, file.endpoint, DEFAULT_ENDPOINT),
    model: pickString(over.model, e.RECALL_MODEL, file.model, DEFAULT_MODEL),
    configPath: loaded.path || "",
    configError: loaded.error || null,
  };
}

function resolveConfig(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const runtime = runtimeFrom(env, {
    memoryDir: o.memoryDir,
    cache: o.cache,
    endpoint: o.endpoint,
    model: o.model,
    skipConfig: !!o.skipConfig,
    configPath: o.configPath,
  });
  let memoryDir = runtime.memoryDir;
  let cache = runtime.cache;
  const history = !!o.history;
  if (history) {
    memoryDir = path.join(memoryDir, "history");
    cache = String(cache).replace(/\.json$/i, "-history.json");
  }
  const top = o.top == null ? 5 : o.top;
  return {
    memoryDir,
    cache,
    endpoint: runtime.endpoint,
    model: runtime.model,
    history,
    full: !!o.full,
    query: o.query,
    top,
    resultPath: o.resultPath || "",
    lockTimeoutMs: o.lockTimeoutMs == null ? LOCK_WAIT_MS : o.lockTimeoutMs,
    timeoutMs: o.timeoutMs == null ? EMBED_TIMEOUT_MS : o.timeoutMs,
    embed: o.embed || null,
    configPath: runtime.configPath,
    configError: runtime.configError,
  };
}

function getField(text, key, fallback) {
  const re = new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*[\"']?(.+?)[\"']?\\s*$", "im");
  const m = re.exec(text == null ? "" : String(text));
  return m ? m[1].replace(/\\"/g, '"') : fallback;   // unescape \" from quoted YAML (same as recall.ps1)
}

function parseWeight(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) throw new Error("Cannot convert weight '" + raw + "' to a number.");
  return n;
}

// PowerShell Get-FrontmatterBlock: (?s)^---\s*\r?\n(.*?)\r?\n---
function getFrontmatterBlock(raw) {
  const text = raw == null ? "" : String(raw);
  const m = /^---\s*\r?\n(.*?)\r?\n---/s.exec(text);
  return m ? m[1] : "";
}

// PowerShell body strip: (?s)^---\s*\r?\n.*?\r?\n---[ \t]*(\r?\n|$)
function stripFrontmatterBody(raw) {
  const text = raw == null ? "" : String(raw);
  return text.replace(/^---\s*\r?\n.*?\r?\n---[ \t]*(?:\r?\n|$)/s, "");
}

// Port of Split-MemoryChunks. Paragraph split, ~Max chars, a longer
// paragraph is cut at the last space before the limit (or hard at the
// limit if that space sits in the first half). Spec is PowerShell
// -split '\r?\n[ \t]*\r?\n', .Trim(), and LastIndexOf(' ', $Max).
function splitMemoryChunks(body, max) {
  const limit = max == null ? CHUNK_CHARS : max;
  const chunks = [];
  let cur = "";
  const parts = String(body == null ? "" : body).split(/\r?\n[ \t]*\r?\n/);
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i].trim();
    if (!p) continue;
    while (p.length > limit) {
      let cut = p.lastIndexOf(" ", limit);
      if (cut < limit / 2) cut = limit;
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      chunks.push(p.substring(0, cut).trim());
      p = p.substring(cut).trim();
    }
    if (cur && (cur.length + p.length + 2) > limit) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) chunks.push("");
  return chunks;
}

function chunkDocument(baseName, desc, surf, chunk, index) {
  const lead = (index === 0 && surf)
    ? desc + ". Comes up when: " + surf + "."
    : desc + ".";
  return "search_document: " + baseName + ". " + lead + "\n" + chunk;
}

function parseWeightLenient(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const n = Number(String(raw == null ? "" : raw).trim());
  return Number.isFinite(n) ? n : 0.5;
}

function splitHistoryLines(raw) {
  if (raw == null || raw === "") return [];
  return String(raw).split(/\r\n|\n|\r/);
}

function convertToAnchorSlug(text) {
  if (!text) return "";
  let t = String(text);
  let prev = null;
  while (t !== prev) {
    prev = t;
    t = t.replace(/\([^)]*\)/g, " ");
  }
  t = t.split(/\s+(?:\u2014|\u2013|--)\s+/)[0];
  t = t.replace(/^[^\p{L}\p{N}]+/u, "");
  t = t.toLowerCase();
  t = t.replace(/[^a-z0-9]+/g, "-");
  t = t.replace(/-{2,}/g, "-");
  t = t.replace(/^-+|-+$/g, "");
  if (t.length > 56) t = t.substring(0, 56).replace(/-+$/, "");
  return t;
}

function getExplicitAnchorId(line) {
  const m = /^\s*<a\s+id="([A-Za-z0-9][A-Za-z0-9-]*)"\s*>\s*<\/a>\s*$/i.exec(line);
  return m ? m[1].toLowerCase() : null;
}

function getAnchorSpec(line) {
  let m = /^\s*>\s*(Moved|Restored)(?:\s+whole)?\s+(\d{4}-\d{2}-\d{2})\b/i.exec(line);
  if (m) {
    const kind = m[1].toLowerCase();
    return { kind: kind, base: kind + "-" + m[2], title: String(line).trim() };
  }
  m = /^\s*##\s+(.+)$/i.exec(line);
  if (m) {
    const title = m[1].trim();
    let base = convertToAnchorSlug(title);
    if (!base) base = "section";
    return { kind: "section", base: base, title: title };
  }
  return null;
}

function uniqueSlug(used, base) {
  const b = base || "block";
  let slug = b;
  let i = 2;
  while (used.has(String(slug).toLowerCase())) {
    slug = b + "-" + i;
    i++;
  }
  used.add(String(slug).toLowerCase());
  return slug;
}

function splitHistoryBlocks(raw, baseName) {
  const lines = splitHistoryLines(raw);
  const blocks = [];
  const used = new Set();
  let pending = null;
  let current = null;
  const lead = [];
  let isFirst = true;
  let wholeId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i]);
    const explicitId = getExplicitAnchorId(line);
    if (explicitId) {
      pending = explicitId;
      if (current == null && lead.length === 0) wholeId = explicitId;
      continue;
    }
    const spec = getAnchorSpec(line);
    if (spec) {
      if (current != null) blocks.push(current);
      let requested = spec.base;
      let explicit = false;
      if (pending) {
        requested = pending;
        explicit = true;
        pending = null;
      }
      const anchor = uniqueSlug(used, requested);
      let blockLead = null;
      if (isFirst && lead.length > 0) {
        blockLead = lead.slice();
        isFirst = false;
      } else {
        isFirst = false;
      }
      current = {
        anchor: anchor,
        kind: spec.kind,
        title: spec.title,
        line: i + 1,
        explicit: explicit,
        lead: blockLead,
        lines: [line],
        cite: "history/" + baseName + ".md#" + anchor,
      };
    } else {
      if (line.trim().length > 0) pending = null;
      if (current != null) current.lines.push(line);
      else lead.push(line);
    }
  }
  if (current != null) blocks.push(current);

  if (blocks.length === 0) {
    const text = lines.join("\n").trim();
    if (text) {
      const explicitWhole = !!wholeId;
      const anchor = uniqueSlug(used, explicitWhole ? wholeId : "whole");
      const lineList = [];
      for (let i = 0; i < lines.length; i++) {
        if (!getExplicitAnchorId(lines[i])) lineList.push(lines[i]);
      }
      let first = "";
      for (let i = 0; i < lines.length; i++) {
        if (String(lines[i]).trim()) {
          first = String(lines[i]).trim();
          break;
        }
      }
      blocks.push({
        anchor: anchor,
        kind: "whole",
        title: first,
        line: 1,
        explicit: explicitWhole,
        lead: null,
        lines: lineList,
        cite: "history/" + baseName + ".md#" + anchor,
      });
    }
  }

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const parts = [];
    if (b.lead) {
      for (let j = 0; j < b.lead.length; j++) parts.push(String(b.lead[j]));
    }
    for (let j = 0; j < b.lines.length; j++) parts.push(String(b.lines[j]));
    out.push({
      anchor: String(b.anchor),
      kind: String(b.kind),
      title: String(b.title),
      line: b.line,
      explicit: !!b.explicit,
      bodyText: parts.join("\n").trim(),
      cite: String(b.cite),
    });
  }
  return out;
}

function cacheKeyOf(entry, history) {
  if (history) return entry && entry.cite ? entry.cite : (entry && entry.name);
  if (entry && entry.key) return entry.key;
  return entry && entry.name;
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

function rowsFromFile(f, model, history) {
  const raw = sources.readText(f.fullPath);
  if (history) {
    const fm = getFrontmatterBlock(raw);
    const w = parseWeightLenient(getField(fm, "weight", ""));
    const srcPer = getField(fm, "persistence", "unset");
    const rows = [];
    const blocks = splitHistoryBlocks(raw, f.baseName);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      let body = String(b.bodyText);
      if (body.length > MAX_BLOCK_CHARS) body = body.substring(0, MAX_BLOCK_CHARS);
      let heading = String(b.title);
      if (heading.length > 300) heading = heading.substring(0, 300);
      const doc = "search_document: " + heading + "\n" + body;
      rows.push({
        key: b.cite,
        name: f.baseName,
        description: heading,
        rel: b.cite,
        persistence: "history",
        weight: w,
        doc,
        hash: contentHash(model, doc),
        extra: {
          anchor: b.anchor,
          cite: b.cite,
          heading: heading,
          kind: b.kind,
          source_persistence: srcPer,
        },
      });
    }
    return rows;
  }
  let fm = getFrontmatterBlock(raw);
  if (!fm) fm = raw;
  const desc = getField(fm, "description", f.baseName);
  const surf = getField(fm, "surfaces-when", "");
  const per = getField(fm, "persistence", "standing");
  const w = parseWeight(getField(fm, "weight", "0.5"));
  const body = stripFrontmatterBody(raw);
  const parts = splitMemoryChunks(body, CHUNK_CHARS);
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const doc = chunkDocument(f.baseName, desc, surf, parts[i], i);
    const key = f.baseName + "#" + i;
    rows.push({
      key,
      name: f.baseName,
      description: desc,
      rel: f.rel,
      persistence: per,
      weight: w,
      doc,
      hash: contentHash(model, doc),
      extra: { key, chunk: i },
    });
  }
  return rows;
}

function recallRows(files, model, history) {
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const got = rowsFromFile(files[i], model, history);
    for (let j = 0; j < got.length; j++) rows.push(got[j]);
  }
  return rows;
}

function bestByName(rows, nameKey, scoreKey) {
  const nk = nameKey || "n";
  const sk = scoreKey || "cos";
  const best = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const k = String(row[nk]).toLowerCase();
    const prev = best.get(k);
    if (!prev || row[sk] > prev[sk]) best.set(k, row);
  }
  return Array.from(best.values());
}

function milestoneNames(entries) {
  const seen = new Set();
  const names = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isMilestone(e)) continue;
    const k = String(e.name).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    names.push(e.name);
  }
  return names;
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
  const rows = recallRows(listed.files, cfg.model, cfg.history).map((row) => ({
    name: row.name,
    rel: row.rel,
    hash: row.hash,
    description: row.description,
    persistence: row.persistence,
    weight: row.weight,
  }));
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
    return { exitCode: 1, cfg, reason: "missing" };
  }
  fs.mkdirSync(path.dirname(cfg.cache), { recursive: true });
  const lock = await acquireLock(cfg.cache, cfg.lockTimeoutMs);
  if (!lock) {
    const msg = "Another rebuild held the lock for 5 min; giving up. Cache untouched.";
    io.host(msg);
    io.out(msg);
    return { exitCode: 1, cfg, reason: "lock" };
  }
  try {
    const old = ciMap();
    if (!cfg.full && fs.existsSync(cfg.cache)) {
      try {
        for (const e of readCacheEntries(cfg.cache)) {
          const k = cacheKeyOf(e, cfg.history);
          if (k) old.set(k, e);
        }
      } catch { /* unreadable cache: embed everything */ }
    }
    const listed = recallFiles(cfg);
    if (listed.error) {
      io.host(listed.error);
      return { exitCode: 1, cfg, reason: "list" };
    }
    const dup = duplicateMessage(listed.files);
    if (dup) {
      io.host(dup);
      io.out(dup);
      return { exitCode: 1, cfg, reason: "duplicate" };
    }
    const rows = recallRows(listed.files, cfg.model, cfg.history).map((row) => {
      const prev = old.get(row.key);
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
        return { exitCode: 1, cfg, reason: "embedder" };
      }
    }
    const outRows = [];
    let embedded = 0;
    for (const p of rows) {
      let vec;
      if (p.reuse) vec = p.prev.vector;
      else {
        io.host("  embedding " + p.key + " ...");
        try {
          vec = await embedText(p.doc, cfg);
          embedded++;
        } catch (err) {
          io.host("  FAILED on " + p.key + ": " + err.message);
          const msg = "Rebuild aborted after a failed embedding. Cache NOT modified.";
          io.host(msg);
          io.out(msg);
          return { exitCode: 1, cfg, reason: "embedder" };
        }
      }
      const entry = {
        name: p.name,
        description: p.description,
        persistence: p.persistence,
        weight: p.weight,
        rel: p.rel,
        model: cfg.model,
        hash: p.hash,
      };
      if (p.extra) {
        const keys = Object.keys(p.extra);
        for (let i = 0; i < keys.length; i++) entry[keys[i]] = p.extra[keys[i]];
      }
      entry.vector = vec;
      outRows.push(entry);
    }
    if (outRows.length === 0) {
      const msg = "No memory files found; cache NOT modified.";
      io.host(msg);
      io.out(msg);
      return { exitCode: 1, cfg, reason: "empty" };
    }
    writeCacheAtomic(cfg.cache, JSON.stringify(outRows));
    const names = ciMap();
    for (const p of rows) names.set(p.key, true);
    let dropped = 0;
    for (const k of old.keys()) if (!names.has(k)) dropped++;
    const what = cfg.history
      ? "history blocks from " + listed.files.length + " files"
      : "chunks from " + listed.files.length + " memories";
    const summary = "Cached " + outRows.length + " " + what + " -> " + cfg.cache
      + "  (embedded " + embedded + ", reused " + (outRows.length - embedded) + ", dropped " + dropped + ")";
    io.host(summary);
    io.out(summary);
    return { exitCode: 0, cfg, embedded, reused: outRows.length - embedded, dropped, count: outRows.length, summary };
  } finally {
    releaseLock(lock);
  }
}

function printMilestones(io, names) {
  io.host("");
  io.host("MILESTONES (never fade; index line loaded each session, file only when it ranks)");
  io.host("  " + (names || []).join(", "));
}

function lexicalQuery(cfg, io, reason) {
  if (!cfg.memoryDir || !fs.existsSync(cfg.memoryDir) || !fs.statSync(cfg.memoryDir).isDirectory()) {
    io.host("No cache. Run -Rebuild first.");
    return { exitCode: 0, cfg, hits: [], mode: "lexical" };
  }
  const found = lexical.search(cfg.query, {
    memoryDir: cfg.memoryDir,
    cache: cfg.cache,
    history: cfg.history,
    maxHits: cfg.top,
  });
  const milestones = milestoneNames(found.index.docs || []);
  printMilestones(io, milestones);
  io.host("");
  io.host("RETRIEVED for: \"" + cfg.query + "\"");
  io.host("  (keyword match" + (reason ? " — " + reason : "") + ")");
  // An on-purpose search lists the top ranked rows like the cosine table
  // does, not only the ones strong enough for the per-message hook's gate
  // (that gate exists to keep unasked-for injections quiet). "match" is the
  // normalised BM25: about 1.0 when the file holds all of the query's
  // keyword weight; * marks a row the hook itself would surface.
  const top = found.ranked.slice(0, cfg.top);
  const strong = new Set(found.hits.map((h) => String(h.name).toLowerCase()));
  if (!top.length) {
    io.host("  (no memory shares a keyword with this query)");
  } else {
    io.host("  " + pad("match", 8) + " memory");
    for (const row of top) {
      const mark = strong.has(String(row.name).toLowerCase()) ? "*" : " ";
      io.host("  " + pad(formatFixed(row.norm, 2) + mark, 8) + " " + row.name + "  " + (row.rel || ""));
    }
  }
  io.host("");
  const hits = top.map((row) => ({
    name: row.name,
    rel: row.rel,
    mode: "lexical",
    norm: row.norm,
    strong: strong.has(String(row.name).toLowerCase()),
    weight: row.weight,
  }));
  if (cfg.resultPath) {
    writeUtf8(cfg.resultPath, JSON.stringify({ query: cfg.query, hits, mode: "lexical" }));
  }
  return { exitCode: 0, cfg, hits, milestones, mode: "lexical" };
}

async function search(opts) {
  const cfg = resolveConfig(opts);
  const io = ioOf(opts);
  if (!cfg.query) {
    io.host("Need -Query, -Rebuild, or -Plan.");
    return { exitCode: 0, cfg };
  }
  const cacheOk = cfg.cache && fs.existsSync(cfg.cache);
  const injected = typeof cfg.embed === "function";
  const skipEmbed = !cacheOk
    || (!injected && embedderRecentlyDown(cfg.cache, opts && opts.now, opts && opts.failTtlMs));
  if (skipEmbed) {
    const reason = cacheOk ? "embedder unreachable" : "no vector cache";
    return lexicalQuery(cfg, io, reason);
  }
  if (!injected) {
    let up = true;
    try { up = await probeEmbedder(Object.assign({}, cfg, { probe: opts && opts.probe, probeMs: opts && opts.probeMs })); }
    catch { up = false; }
    if (!up) {
      markEmbedderDown(cfg.cache, opts && opts.now);
      return lexicalQuery(cfg, io, "embedder unreachable");
    }
  }
  const mem = readCacheEntries(cfg.cache);
  let qv;
  try {
    qv = await embedText("search_query: " + cfg.query, cfg);
  } catch (err) {
    markEmbedderDown(cfg.cache, opts && opts.now);
    return lexicalQuery(cfg, io, "embedder unreachable");
  }
  clearEmbedderDown(cfg.cache);
  const milestones = milestoneNames(mem);
  printMilestones(io, milestones);
  io.host("");
  io.host("RETRIEVED for: \"" + cfg.query + "\"");
  io.host("  " + pad("score", 8) + " " + pad("cosine", 8) + " " + pad("weight", 8) + " memory");
  const scored = mem.map((e) => {
    const c = cosine(qv, e.vector);
    return { n: e.name, cos: c, w: e.weight, score: c, rel: e.rel || "" };
  });
  const ranked = bestByName(scored, "n", "cos").sort((a, b) => {
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
  return { exitCode: 0, cfg, hits, milestones, mode: "cosine" };
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
      case "help":
      case "h": out.help = true; break;
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
  if (args.help) {
    ioOf(extra).out(recallUsage());
    return 0;
  }
  if (args.plan && (args.rebuild || args.query)) {
    ioOf(extra).host("Use -Plan on its own.");
    return 1;
  }
  // sources.js is required at load. A filesystem check here fails inside the
  // SEA bundle, where the module is inlined and there is no sibling file.
  if (args.plan) return (await plan(merged)).exitCode;
  if (args.rebuild) return (await rebuild(merged)).exitCode;
  if (!args.query) {
    ioOf(extra).host("Need -Query, -Rebuild, or -Plan.");
    return 0;
  }
  return (await search(merged)).exitCode;
}

if (require.main === module) {
  // exitCode, not exit(): on Windows, Node 24 aborts with a libuv assertion
  // (UV_HANDLE_CLOSING, async.c:94) when process.exit() runs right after two
  // fetches to the same server (measured 2026-10-17: exit() 15/15 crashes,
  // exitCode 0/15). A crashed hook exits 127 and its output is dropped.
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code || 0; },
    (err) => {
      process.stderr.write(String(err && err.stack || err) + "\n");
      process.exitCode = 1;
    }
  );
}

function recallUsage() {
  return [
    "Usage: --recall --query \"...\" [--top 5] [--history]",
    "       --recall --rebuild [--full] [--history]",
    "       --recall --plan",
    "",
    "  --query uses cosine when the embedder answers, keyword match otherwise.",
    "",
    "  --memory-dir <dir>   Memory folder (else RECALL_MEMORY, else memory-system.json)",
    "  --cache <file>       Recall cache",
    "  --endpoint <url>     Embedder (else RECALL_ENDPOINT, else EMBED_ENDPOINT)",
    "  --model <name>       Embed model (else RECALL_MODEL; never EMBED_MODEL)",
    "  --full               Rebuild every vector",
    "  --history            Search memory/history only",
    "  --result <file>      Write the plan or the hits as JSON",
  ].join("\n");
}

module.exports = {
  DEFAULT_MEMORY,
  DEFAULT_CACHE,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  CHUNK_CHARS,
  MAX_BLOCK_CHARS,
  LOCK_WAIT_MS,
  embeddingsUrl,
  modelsUrl,
  PROBE_MS,
  FAIL_TTL_MS,
  embedderDownPath,
  embedderRecentlyDown,
  markEmbedderDown,
  clearEmbedderDown,
  probeEmbedder,
  homeFromEnv,
  defaultConfigPath,
  readMemorySystemConfig,
  runtimeFrom,
  resolveConfig,
  recallUsage,
  getField,
  parseWeight,
  getFrontmatterBlock,
  stripFrontmatterBody,
  splitMemoryChunks,
  splitHistoryBlocks,
  chunkDocument,
  rowsFromFile,
  recallRows,
  bestByName,
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
