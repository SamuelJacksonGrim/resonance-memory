#!/usr/bin/env node
// Resonance Memory — auto-recall hook for Claude Code
// Copyright (C) 2026 Samuel Jackson Grim
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Claude Code UserPromptSubmit hook. On every message the user sends, it asks Resonance Memory what it
// already knows (the same recall_memory call the model can make, with all of RM's tuning: entity/polarity
// gates, the field, normalized readout) and injects the result into the model's context. The model no
// longer has to remember to recall: recall happens on every turn.
//
// How it talks to RM: it starts the RM server (`<bin> --mcp`), does the MCP handshake over stdio, calls
// recall_memory with the user's message, prints the answer, and exits. Nothing is stored or changed by the
// hook itself.
//
// DESIGN RULE: fail silent. Any problem (RM not found, slow, empty store, bad input) = exit 0 with no
// output, so a broken hook can never block a message.
//
// Usage (in Claude Code settings.json, see AUTO-RECALL.md):
//   node /path/to/hooks/auto-recall.js "/path/to/resonance-memory(.exe)"
//   node /path/to/hooks/auto-recall.js "/path/to/resonance-memory/entry.js"   (running RM from source)
//   Optional 2nd argument: the store path, ONLY if your MCP config sets MEMORY_FILE_PATH (the hook must read
//   the same store the server writes): node auto-recall.js "<bin>" "/path/to/store.jsonl"
// Optional env: RM_RECALL_TIMEOUT_MS (default 8000), RM_RECALL_MIN_CHARS (default 12),
//               RM_RECALL_MAX_CHARS (default 2000, caps what gets injected).
"use strict";
const { spawn } = require("child_process");

const TIMEOUT_MS = Number(process.env.RM_RECALL_TIMEOUT_MS) || 8000;
const MIN_CHARS = Number(process.env.RM_RECALL_MIN_CHARS) || 12;
const MAX_CHARS = Number(process.env.RM_RECALL_MAX_CHARS) || 2000;
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.RM_RECALL_DEBUG || "");
// Silent by design; RM_RECALL_DEBUG=1 prints the reason for silence to stderr (setup troubleshooting only).
const quit = (why) => { if (DEBUG && why) process.stderr.write("[rm-auto-recall] " + why + "\n"); process.exit(0); };

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function recall(bin, query, store) {
  return new Promise((resolve) => {
    const isScript = /\.(c|m)?js$/i.test(bin);
    let child;
    try {
      child = spawn(isScript ? process.execPath : bin,
                    isScript ? ["--experimental-sqlite", bin, "--mcp"] : ["--mcp"],
                    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
                      env: store ? Object.assign({}, process.env, { MEMORY_FILE_PATH: store }) : process.env });
    } catch { return resolve(null); }
    let buf = "";
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(text);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
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
        if (msg.id === 2) {
          const r = msg.result;
          if (!r || r.isError || !Array.isArray(r.content)) return finish(null);
          finish(r.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n").trim());
        }
      }
    });
    const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch { finish(null); } };
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
           params: { protocolVersion: "2024-11-05", capabilities: {},
                     clientInfo: { name: "rm-auto-recall-hook", version: "1.0.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call",
           params: { name: "recall_memory", arguments: { query } } });
  });
}

(async () => {
  try {
    const bin = process.argv[2];
    if (!bin) return quit("no RM path given as the first argument");
    const raw = await readStdin();
    if (!raw) return quit("empty stdin");
    let prompt = "";
    try { prompt = String(JSON.parse(raw.replace(/^\uFEFF/, "")).prompt || ""); } catch (e) { return quit("stdin is not JSON: " + e.message); }
    if (prompt.trim().length < MIN_CHARS) return quit("prompt shorter than " + MIN_CHARS + " chars");
    let text = await recall(bin, prompt.slice(0, 4000), process.argv[3]);
    if (!text) return quit("RM gave no answer (not found, error, or timeout after " + TIMEOUT_MS + " ms)");
    // An empty store or no match: RM says so in plain words; inject nothing rather than noise.
    if (/^(no (relevant )?memor|nothing (saved|found)|no matches)/i.test(text)) return quit("RM: " + text);
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n…";
    process.stdout.write(
      "[resonance-memory] Auto-recalled for this message (RM's own ranking; use what is relevant, " +
      "ignore the rest):\n" + text + "\n");
    quit();
  } catch (e) { quit("unexpected: " + (e && e.message)); }
})();
