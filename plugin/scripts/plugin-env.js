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
 * plugin-env.js — where this session's memory lives, where its recall cache
 * goes, and which embedder (if any) answers.
 *
 * The exe install writes ~/.resonance-memory/memory-system.json once and every
 * hook reads it. A plugin has no install step and can be enabled in many
 * projects, so each hook works the answer out from what Claude Code hands it:
 *
 *   memory folder  userConfig memory_dir (CLAUDE_PLUGIN_OPTION_MEMORY_DIR), else
 *                  the project's own auto-memory folder: <dir of transcript_path>/memory.
 *                  That is the folder whose MEMORY.md Claude Code already loads, so the
 *                  plugin builds on it instead of inventing a second one.
 *   recall cache   ${CLAUDE_PLUGIN_DATA}/recall/<hash of memory folder>.json, so two
 *                  projects never share vectors and an update never wipes them.
 *   embedder       userConfig endpoint/model if set, else LM Studio (:1234), else
 *                  Ollama (:11434), probing /v1/models for a nomic embedding model.
 *                  None found = keyword mode, not an error.
 *
 * The result is handed to the RM scripts as RECALL_* env, with RECALL_CONFIG
 * blanked so a ~/.resonance-memory/memory-system.json from an exe install on
 * the same machine can't steer the plugin's hooks to a different folder.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Known nomic v1.5 ids per server. LM Studio names it after the GGUF; Ollama
// after its library tag. Both are the same weights, so either can serve the
// same memory folder (the cache records the model and re-embeds on a switch).
const CANDIDATES = [
  { name: "LM Studio", endpoint: "http://127.0.0.1:1234", match: /nomic-embed-text/i },
  { name: "Ollama", endpoint: "http://127.0.0.1:11434", match: /nomic-embed-text/i },
];
const PROBE_TIMEOUT_MS = 1500;
const STATE_TTL_MS = 10 * 60 * 1000;

function readStdinText() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function parsePayload(raw) {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function option(env, key) {
  const v = env["CLAUDE_PLUGIN_OPTION_" + key.toUpperCase()];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function dataDir(env) {
  const d = env.CLAUDE_PLUGIN_DATA;
  if (d && String(d).trim()) return String(d);
  // Outside Claude Code (tests, a hand run) there is no plugin data dir.
  return path.join(os.homedir(), ".resonance-memory", "plugin-data");
}

function memoryDirFrom(payload, env) {
  const pinned = option(env, "memory_dir");
  if (pinned) return path.resolve(pinned);
  const t = payload && payload.transcript_path;
  if (t && String(t).trim()) return path.join(path.dirname(String(t)), "memory");
  return "";
}

function cacheFor(memoryDir, env) {
  const key = crypto.createHash("sha256").update(path.resolve(memoryDir).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(dataDir(env), "recall", key + ".json");
}

function statePath(env) {
  return path.join(dataDir(env), "embedder.json");
}

function readState(env) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(env), "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

function writeState(env, state) {
  try {
    const p = statePath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state), "utf8");
  } catch { /* state is a convenience; recall still works without it */ }
}

async function listModels(endpoint, timeoutMs) {
  const url = String(endpoint).replace(/\/+$/, "").replace(/\/v1\/embeddings$/i, "") + "/v1/models";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = Array.isArray(data && data.data) ? data.data.map((m) => String(m && m.id || "")) : [];
    return ids;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns { mode: "semantic", name, endpoint, model } or { mode: "keyword" }.
async function detectEmbedder(env, opts) {
  const o = opts || {};
  const endpoint = option(env, "embed_endpoint");
  const model = option(env, "embed_model");
  if (endpoint) {
    // The user named one: trust it, and only check it answers.
    const ids = await listModels(endpoint, o.timeoutMs || PROBE_TIMEOUT_MS);
    if (ids == null) return { mode: "keyword", reason: "configured endpoint " + endpoint + " did not answer" };
    const found = model || ids.find((id) => /embed/i.test(id)) || "";
    if (!found) return { mode: "keyword", reason: "no embedding model listed at " + endpoint };
    return { mode: "semantic", name: "configured", endpoint, model: found };
  }
  // In parallel: on Windows a refused localhost connect takes about 2 s, so
  // probing one server after the other would double the wait at session start.
  const cands = o.candidates || CANDIDATES;
  const lists = await Promise.all(cands.map((c) => listModels(c.endpoint, o.timeoutMs || PROBE_TIMEOUT_MS)));
  for (let i = 0; i < cands.length; i++) {
    const ids = lists[i];
    if (ids == null) continue;
    const hit = ids.find((id) => cands[i].match.test(id));
    if (hit) return { mode: "semantic", name: cands[i].name, endpoint: cands[i].endpoint, model: model || hit };
  }
  return { mode: "keyword", reason: "no local embedder found (LM Studio or Ollama with nomic-embed-text)" };
}

// Fresh detection at session start; hooks within the session reuse it.
async function embedderFor(env, opts) {
  const o = opts || {};
  if (!o.fresh) {
    const s = readState(env);
    if (s && s.at && Date.now() - s.at < STATE_TTL_MS && s.result) return s.result;
  }
  const result = await detectEmbedder(env, o);
  writeState(env, { at: Date.now(), result });
  return result;
}

// The env the RM scripts read. Keyword mode still sets the folder and cache,
// so a rebuild that finds no embedder fails fast and quietly.
function recallEnv(baseEnv, memoryDir, embedder) {
  const env = Object.assign({}, baseEnv);
  env.RECALL_CONFIG = "";
  env.RECALL_MEMORY = memoryDir;
  env.RECALL_CACHE = cacheFor(memoryDir, baseEnv);
  if (embedder && embedder.mode === "semantic") {
    env.RECALL_ENDPOINT = embedder.endpoint;
    env.RECALL_MODEL = embedder.model;
  } else {
    // Nothing listens here; the scripts fail fast and fall back.
    env.RECALL_ENDPOINT = "http://127.0.0.1:9";
    env.RECALL_MODEL = "none";
  }
  return env;
}

module.exports = {
  CANDIDATES,
  readStdinText,
  parsePayload,
  option,
  dataDir,
  memoryDirFrom,
  cacheFor,
  detectEmbedder,
  embedderFor,
  recallEnv,
  listModels,
};
