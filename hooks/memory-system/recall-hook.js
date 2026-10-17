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
 * If the embedder is down (or there is no vector cache yet), falls back
 * to lexical.js BM25 with the measured gate — same [recall] block, labelled
 * (keyword match) instead of a cosine. Fails silent: exit 0 and no output
 * on any problem.
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
const lexical = require("./lexical.js");

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
    if (!memoryDir || !fs.existsSync(memoryDir)) return 0;

    const index = ciCount();
    let files;
    try { files = sources.liveFiles(memoryDir); }
    catch { return 0; }
    for (const f of files) index.add(f.baseName, f.rel);

    const cacheOk = !!(cache && fs.existsSync(cache));
    const injected = typeof opts.embed === "function";
    const skipEmbed = !cacheOk
      || (!injected && recall.embedderRecentlyDown(cache, opts.now, opts.failTtlMs));

    async function cosineHits(qv) {
      if (!qv || !qv.length) return null;
      let qn = 0;
      for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i];
      qn = Math.sqrt(qn);
      if (qn === 0) return null;
      let mem;
      try { mem = recall.readCacheEntries(cache); }
      catch { return null; }
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
      return hits.slice(0, opts.maxHits == null ? MAX_HITS : opts.maxHits);
    }

    function writeCosine(top) {
      const lines = ["[recall] Auto-surfaced memories that may bear on this message (read the file if relevant):"];
      for (const h of top) {
        lines.push("  - " + h.name + " (" + recall.formatFixed(h.cos, 2) + ") -- " + h.desc + "  [" + h.rel + "]");
      }
      write(lines.join("\n") + "\n");
    }

    function writeLexical() {
      const found = lexical.search(prompt, {
        memoryDir,
        cache,
        skipMilestones: true,
        maxHits: opts.maxHits == null ? MAX_HITS : opts.maxHits,
      });
      const kept = [];
      for (let i = 0; i < found.hits.length; i++) {
        const h = found.hits[i];
        if (index.count(h.name) !== 1) continue;
        kept.push(h);
      }
      const block = lexical.formatHookBlock(kept);
      if (block) write(block);
    }

    if (!skipEmbed) {
      if (!injected) {
        let up = false;
        try {
          up = await recall.probeEmbedder({
            endpoint,
            probe: opts.probe,
            probeMs: opts.probeMs == null ? recall.PROBE_MS : opts.probeMs,
          });
        } catch { up = false; }
        if (!up) {
          recall.markEmbedderDown(cache, opts.now);
          writeLexical();
          return 0;
        }
      }
      const embedFn = opts.embed || ((text) => recall.embedText(text, {
        endpoint,
        model,
        timeoutMs: opts.timeoutMs == null ? TIMEOUT_MS : opts.timeoutMs,
      }));
      let qv;
      try { qv = await embedFn("search_query: " + prompt); }
      catch {
        if (!injected) recall.markEmbedderDown(cache, opts.now);
        writeLexical();
        return 0;
      }
      if (!injected) recall.clearEmbedderDown(cache);
      const top = await cosineHits(qv);
      if (top && top.length) {
        writeCosine(top);
        return 0;
      }
      if (top) return 0;
      writeLexical();
      return 0;
    }

    writeLexical();
    return 0;
  } catch {
    return 0;
  }
}

async function main() {
  return runHook();
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code || 0),
    () => process.exit(0)
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
