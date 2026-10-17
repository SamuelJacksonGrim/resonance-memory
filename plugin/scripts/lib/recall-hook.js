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
 * recall-hook.js — Claude Code UserPromptSubmit hook.
 * Port of tools/recall-hook.ps1. Embeds the prompt, keeps the top 3 live
 * memories at cosine >= 0.70, skips milestones and short prompts.
 * Fails silent: exit 0 and no output on any problem.
 *
 * Memory, cache, endpoint, and model: RECALL_* env, else
 * ~/.resonance-memory/memory-system.json (the installer writes it; hook
 * commands cannot portably set env). EMBED_ENDPOINT is a fallback for the
 * URL only. The model follows RECALL_MODEL, then the config file, never
 * EMBED_MODEL.
 */

const fs = require("fs");
const path = require("path");

const sources = require("./sources.js");
const recall = require("./recall.js");

const THRESHOLD = 0.70;
const MAX_HITS = 3;
const MIN_CHARS = 12;
const TIMEOUT_MS = 6000;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function ciCount() {
  const counts = new Map();
  const rels = new Map();
  return {
    add(name, rel) {
      const k = String(name).toLowerCase();
      if (counts.has(k)) counts.set(k, counts.get(k) + 1);
      else {
        counts.set(k, 1);
        rels.set(k, rel);
      }
    },
    count(name) { return counts.get(String(name).toLowerCase()) || 0; },
    rel(name) { return rels.get(String(name).toLowerCase()); },
  };
}

async function runHook(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const write = opts.write || ((s) => process.stdout.write(s));
  try {
    const raw = opts.stdin != null ? String(opts.stdin) : await readStdin();
    if (!raw) return 0;
    let prompt = "";
    try {
      const parsed = JSON.parse(raw);
      prompt = parsed && parsed.prompt != null ? String(parsed.prompt) : "";
    } catch {
      return 0;
    }
    if (!prompt || prompt.trim().length < (opts.minChars == null ? MIN_CHARS : opts.minChars)) return 0;

    const runtime = recall.runtimeFrom(env);
    const cache = runtime.cache;
    const memoryDir = runtime.memoryDir;
    const endpoint = runtime.endpoint;
    const model = runtime.model;
    if (!fs.existsSync(cache)) return 0;
    if (!memoryDir || !fs.existsSync(memoryDir)) return 0;

    const index = ciCount();
    let files;
    try { files = sources.liveFiles(memoryDir); }
    catch { return 0; }
    for (const f of files) index.add(f.baseName, f.rel);

    const embedFn = opts.embed || ((text) => recall.embedText(text, {
      endpoint,
      model,
      timeoutMs: opts.timeoutMs == null ? TIMEOUT_MS : opts.timeoutMs,
    }));
    let qv;
    try { qv = await embedFn("search_query: " + prompt); }
    catch { return 0; }
    if (!qv || !qv.length) return 0;
    let qn = 0;
    for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i];
    qn = Math.sqrt(qn);
    if (qn === 0) return 0;

    let mem;
    try { mem = recall.readCacheEntries(cache); }
    catch { return 0; }

    const hits = [];
    for (const e of mem) {
      if (String(e && e.persistence || "").toLowerCase() === "milestone") continue;
      if (index.count(e.name) !== 1) continue;
      const v = e.vector;
      if (!Array.isArray(v) || v.length === 0) continue;
      let dot = 0;
      let vn = 0;
      for (let i = 0; i < v.length; i++) {
        const q = i < qv.length ? Number(qv[i]) : 0;
        const x = Number(v[i]);
        dot += q * x;
        vn += x * x;
      }
      const cos = vn === 0 ? 0 : dot / (qn * Math.sqrt(vn));
      if (!(cos >= (opts.threshold == null ? THRESHOLD : opts.threshold))) continue;
      hits.push({
        name: e.name,
        desc: e.description == null ? "" : String(e.description),
        cos,
        rel: index.rel(e.name) || "",
      });
    }
    hits.sort((a, b) => b.cos - a.cos);
    const top = hits.slice(0, opts.maxHits == null ? MAX_HITS : opts.maxHits);
    if (!top.length) return 0;
    const lines = ["[recall] Auto-surfaced memories that may bear on this message (read the file if relevant):"];
    for (const h of top) {
      lines.push("  - " + h.name + " (" + recall.formatFixed(h.cos, 2) + ") -- " + h.desc + "  [" + h.rel + "]");
    }
    write(lines.join("\n") + "\n");
    return 0;
  } catch {
    return 0;
  }
}

async function main() {
  return runHook();
}

if (require.main === module) {
  // exitCode, not exit(): on Windows, Node 24 aborts with a libuv assertion
  // (UV_HANDLE_CLOSING, async.c:94) when process.exit() runs right after two
  // fetches to the same server (measured 2026-10-17: exit() 15/15 crashes,
  // exitCode 0/15). A crashed hook exits 127 and its output is dropped.
  main().then(
    (code) => { process.exitCode = code || 0; },
    () => { process.exitCode = 0; }
  );
}

module.exports = {
  THRESHOLD,
  MAX_HITS,
  MIN_CHARS,
  TIMEOUT_MS,
  runHook,
  main,
};
