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
 * proxy.js — auto-recall for local models (`resonance-memory --proxy`).
 *
 * WHY: a model can't decide to recall what it can't see. Claude Code gets recall on every message through
 * its UserPromptSubmit hook; LM Studio's server, llama.cpp, Ollama and the apps on top of them (Hermes,
 * Open WebUI, SillyTavern, Continue, Cline...) have no such hook, so there the model only ever got memories
 * when it chose to call recall_memory. This closes that gap the same way the hook does: nothing waits on
 * the model.
 *
 * HOW: an OpenAI-compatible HTTP proxy on 127.0.0.1. Point the app at the proxy instead of the model
 * server. On each chat request whose last message is the user's, it runs the same two recalls Claude Code
 * gets and puts the result in front of that message:
 *   - the memory store (RM's own recall_memory, through a long-lived `--mcp` child: same ranking, gates and
 *     field as the tool), and
 *   - the memory system folder, if one is set up (the recall-hook.js preview: each hit's name, a one-line
 *     summary and the score; the model opens the file when one looks relevant).
 * Everything else (models list, completions, embeddings, the response stream) passes through untouched.
 *
 * Where the block goes: prepended to the LAST user message, not added as a system message. Many chat
 * templates reject a system message that isn't first, and editing the first system message would change
 * the cached prompt prefix on every turn. The client keeps its own history without the block, so blocks
 * never pile up across turns.
 *
 * DESIGN RULE: fail open. Recall slow, broken or empty = forward the request unchanged. The proxy must
 * never be the reason a message doesn't reach the model. Nothing is stored or changed by the proxy.
 *
 * Usage:
 *   resonance-memory --proxy [--port 1240] [--upstream http://127.0.0.1:1234] [--memory-dir <dir>] [--no-store]
 * Env: RM_PROXY_PORT, RM_PROXY_UPSTREAM, RM_PROXY_TIMEOUT_MS (default 8000), RM_PROXY_MAX_CHARS (default 3000),
 *      RM_PROXY_MIN_CHARS (default 12), MEMORY_FILE_PATH (the store, same as the MCP server), RECALL_MEMORY / RECALL_CACHE (the folder and its index).
 */

const http = require("http");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_PORT = 1240;
const DEFAULT_UPSTREAM = "http://127.0.0.1:1234";
const HEADER = "[resonance-memory] Auto-recalled for this message (use what is relevant, ignore the rest):";
const CHAT_PATHS = new Set(["/v1/chat/completions", "/chat/completions", "/api/chat"]);
// Same "nothing found" wording the Claude Code hook filters, so an empty store injects nothing.
const EMPTY_RE = /^(no (relevant )?memor|nothing (saved|found)|no matches)/i;

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------- the request edit

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  }
  return "";
}

// The user's words for this turn, or "" when there is nothing to recall for: the last message isn't the
// user's (an agent loop handing back a tool result), or it is a background notice, not the user speaking.
function lastUserPrompt(body) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : null;
  if (!msgs || !msgs.length) return "";
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "user") return "";
  const text = textOf(last.content);
  if (/<task-notification>/i.test(text)) return "";
  return text;
}

// Returns a new body with `block` in front of the last user message's text. Leaves `body` untouched.
function injectBlock(body, block) {
  const msgs = body.messages.slice();
  const last = Object.assign({}, msgs[msgs.length - 1]);
  if (typeof last.content === "string") {
    last.content = block + "\n\n" + last.content;
  } else if (Array.isArray(last.content)) {
    last.content = [{ type: "text", text: block + "\n" }].concat(last.content);
  } else {
    return body;
  }
  msgs[msgs.length - 1] = last;
  return Object.assign({}, body, { messages: msgs });
}

// ---------------------------------------------------------------- the store recall (long-lived --mcp child)

// The command that runs this same program as an MCP server: the exe itself, or node + entry.js from source.
function selfMcpCommand() {
  let sea = false;
  try { sea = require("node:sea").isSea(); } catch { /* not a SEA build */ }
  if (sea) return { command: process.execPath, args: ["--mcp"] };
  return { command: process.execPath, args: ["--experimental-sqlite", path.join(__dirname, "entry.js"), "--mcp"] };
}

// One MCP session kept open for the proxy's lifetime, so a recall doesn't pay the server's start-up (store
// open, field load) on every message. Restarts on the next call if the child dies.
class StoreRecall {
  constructor(opts) {
    this.launch = (opts && opts.launch) || selfMcpCommand();
    this.timeoutMs = (opts && opts.timeoutMs) || envNum("RM_PROXY_TIMEOUT_MS", 8000);
    this.env = (opts && opts.env) || process.env;
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 10;
  }

  _start() {
    const child = spawn(this.launch.command, this.launch.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: this.env });
    this.child = child;
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const p of this.pending.values()) p(null);
      this.pending.clear();
    };
    child.on("exit", gone);
    child.on("error", gone);
    this.ready = this._call("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "rm-proxy", version: "1.0.0" },
    }).then((r) => {
      if (!r) return false;
      this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return true;
    });
  }

  _send(obj) {
    try { this.child.stdin.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
  }

  _call(method, params) {
    return new Promise((resolve) => {
      if (!this.child) return resolve(null);
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, this.timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg && !msg.error ? msg.result : null); });
      if (!this._send({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  async recall(query) {
    try {
      if (!this.child) this._start();
      if (!(await this.ready)) return null;
      const r = await this._call("tools/call", { name: "recall_memory", arguments: { query } });
      if (!r || r.isError || !Array.isArray(r.content)) return null;
      const text = r.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n").trim();
      return text && !EMPTY_RE.test(text) ? text : null;
    } catch { return null; }
  }

  close() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill(); } catch { /* already gone */ } }
  }
}

// ---------------------------------------------------------------- the memory-system folder recall

// The recall-hook.js block (name + one-line summary + score per hit), produced by the hook's own code so
// the two can't drift. Silent ("" ) when no memory system is set up or nothing clears the gate.
async function folderRecall(prompt, memoryDir) {
  const hook = require("./hooks/memory-system/recall-hook.js");
  let out = "";
  const env = memoryDir ? Object.assign({}, process.env, { RECALL_MEMORY: memoryDir }) : process.env;
  await hook.runHook({ stdin: JSON.stringify({ prompt }), write: (s) => { out += s; }, env });
  return out.trim();
}

// Both recalls, run side by side; whatever comes back is joined under one header. null = inject nothing.
function makeRecall(opts) {
  const o = opts || {};
  const store = o.store === false ? null : new StoreRecall({ timeoutMs: o.timeoutMs });
  const maxChars = o.maxChars || envNum("RM_PROXY_MAX_CHARS", 3000);
  const timeoutMs = o.timeoutMs || envNum("RM_PROXY_TIMEOUT_MS", 8000);
  const withTimeout = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
  async function recall(prompt) {
    const q = prompt.slice(0, 4000);
    const [folder, mem] = await Promise.all([
      o.folder === false ? null : withTimeout(folderRecall(q, o.memoryDir).catch(() => null)),
      store ? store.recall(q) : null,
    ]);
    const parts = [];
    if (folder) parts.push(folder);
    if (mem) parts.push(mem);
    if (!parts.length) return null;
    let block = HEADER + "\n" + parts.join("\n\n");
    if (block.length > maxChars) block = block.slice(0, maxChars) + "\n...";
    return block;
  }
  recall.close = () => { if (store) store.close(); };
  return recall;
}

// ---------------------------------------------------------------- the proxy

function forward(req, res, upstream, bodyBuf) {
  const target = new URL(req.url, upstream);
  const lib = target.protocol === "https:" ? https : http;
  const headers = Object.assign({}, req.headers);
  headers.host = target.host;
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  if (bodyBuf) headers["content-length"] = String(bodyBuf.length);
  const up = lib.request(target, { method: req.method, headers }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Resonance Memory proxy: model server unreachable at " + upstream + " (" + e.message + ")" } }));
    } else { res.destroy(); }
  });
  req.on("aborted", () => up.destroy());
  if (bodyBuf) up.end(bodyBuf); else req.pipe(up);
}

// createProxy({ upstream, recall, minChars, log }) -> http.Server (not listening yet).
// `recall(prompt)` resolves to the block to inject, or null.
function createProxy(opts) {
  const upstream = (opts && opts.upstream) || DEFAULT_UPSTREAM;
  const recall = opts && opts.recall;
  const minChars = (opts && opts.minChars) || envNum("RM_PROXY_MIN_CHARS", 12);
  const log = (opts && opts.log) || (() => {});
  return http.createServer((req, res) => {
    const pathname = (req.url || "").split("?")[0];
    if (req.method !== "POST" || !CHAT_PATHS.has(pathname) || !recall) return forward(req, res, upstream, null);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      let out = raw;
      try {
        const body = JSON.parse(raw.toString("utf8"));
        const prompt = lastUserPrompt(body);
        if (prompt.trim().length >= minChars) {
          const block = await recall(prompt);
          if (block) {
            out = Buffer.from(JSON.stringify(injectBlock(body, block)), "utf8");
            log("recalled " + block.length + " chars for: " + prompt.slice(0, 60).replace(/\s+/g, " "));
          }
        }
      } catch { out = raw; }
      forward(req, res, upstream, out);
    });
  });
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function main(args) {
  const a = args || [];
  const port = Number(argValue(a, "--port")) || envNum("RM_PROXY_PORT", DEFAULT_PORT);
  const upstream = (argValue(a, "--upstream") || process.env.RM_PROXY_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const recall = makeRecall({ memoryDir: argValue(a, "--memory-dir"), store: !a.includes("--no-store") });
  const log = (s) => process.stderr.write("[rm-proxy] " + s + "\n");
  const server = createProxy({ upstream, recall, log });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  log("auto-recall proxy on http://127.0.0.1:" + port + "/v1  ->  " + upstream);
  log("point your app's OpenAI base URL at http://127.0.0.1:" + port + "/v1 instead of the model server");
  const stop = () => { recall.close(); server.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise(() => {}); // runs until stopped
}

module.exports = {
  DEFAULT_PORT, DEFAULT_UPSTREAM, HEADER,
  lastUserPrompt, injectBlock, createProxy, makeRecall, StoreRecall, selfMcpCommand, main,
};
