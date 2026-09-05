#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/*
 * resonance-memory - an MCP memory server a small model cannot misuse.
 *
 * Four cognitive verbs, each dead simple:
 *   save_memory({ content })        -> embed once, store, confirm
 *   recall_memory({ query })        -> most relevant saved memories (with ids)
 *   edit_memory({ id, content })    -> replace text, regenerate embedding
 *   delete_memory({ id })           -> soft delete (deleted=true)
 *
 * The graph/store is the SUBSTRATE, never the interface. The model never sees
 * embeddings, importance, timestamps, or any storage internal - only the four verbs
 * and an opaque `id` it copies from a recall listing.
 *
 * Design invariants (see resonance-memory-stack ROADMAP):
 *   - Ranking is COSINE ONLY. importance/access_count govern RETENTION, never rank,
 *     until a labelled-set A/B proves blending helps (measured: weight-in-rank inverts).
 *   - Embed ONCE at save; recall embeds only the query, cosine vs stored vectors.
 *   - Server owns all metadata; the model assigns none of it.
 *   - A Store abstraction sits behind the verbs so the backend (JSONL now, Lantern
 *     later) can be swapped without changing the MCP API.
 *
 * Pure Node stdlib + built-in fetch (Node 18+). Speaks MCP over stdio as
 * line-delimited JSON-RPC 2.0.
 */

const fs = require("fs");
const path = require("path");
const { EdgeStore, hebbianDecayType } = require("./edges.js");
const { JsonlStore } = require("./store.js");
const { createCore, defaultGetEdges } = require("./memory-core.js");
const { WarmField } = require("./warm.js");
// Single source of truth for the version, so serverInfo can't drift from package.json.
// esbuild inlines this JSON into the bundle, so it resolves in the SEA build too.
const VERSION = require("./package.json").version;

// Associative field (Phase 2a/2b). Enabled by the RESONANCE_MEMORY_FIELD env var (default/
// fallback) OR, live, by a shared config.json that the control-panel dashboard writes.
// fieldEnabled() is read per recall, so the browser toggle takes effect without restarting
// the client. Primary cosine results are byte-identical whenever the field is off.
function baseDir() {
  // In a bundled single-executable, __dirname is virtual; resolve next to the exe.
  try { const sea = require("node:sea"); if (sea.isSea()) return path.dirname(process.execPath); } catch { }
  return __dirname;
}
const STORE_PATH = process.env.MEMORY_FILE_PATH ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".lmstudio", "resonance-memory.jsonl");
// Runtime state lives WITH the data (not next to the exe), matching panel.js so the
// panel toggle and the server read the same file.
const CONFIG_PATH = process.env.RESONANCE_MEMORY_CONFIG ||
  path.join(path.dirname(STORE_PATH), "resonance-memory.config.json");
const ENV_FIELD = ["1", "true", "yes"].includes(String(process.env.RESONANCE_MEMORY_FIELD || "").toLowerCase());
const ENV_WARM = ["1", "true", "yes"].includes(String(process.env.RESONANCE_WARM_FIELD || "").toLowerCase());
const ENV_WARM_RANK = String(process.env.RESONANCE_WARM_RANK || "off").toLowerCase() || "off";
const ENV_WARM_TRACE = ["1", "true", "yes"].includes(String(process.env.RESONANCE_WARM_TRACE || "").toLowerCase());
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const ENV_WARM_EDGE_CAP = envInt("RESONANCE_WARM_EDGE_CAP", 512);
function fieldEnabled() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (typeof c.field === "boolean") return c.field;
  } catch { /* no config yet -> fall back to env */ }
  return ENV_FIELD;
}
const EMBED_URL = process.env.EMBED_ENDPOINT || "http://localhost:1234/v1/embeddings";
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-nomic-embed-text-v1.5";

fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

// Unified edge sidecar (Phase 0 / Slice C). Constructed on first use (field-on
// recall, save-time bind, or the startup pruneSweep) so the live toggle needs
// no restart. Persists to <store>.edges.json — NEVER .assoc.json, so an old
// shipped Ledger cannot open the new format and misparse it. A leftover
// .assoc.json is migrated one-way on first load and left untouched
// (legacy / read-only-for-migration).
let _edges = null;
function getEdgeStore() {
  if (!_edges) _edges = new EdgeStore(STORE_PATH + ".edges.json");
  return _edges;
}

// Warm field (Phase 1). In-proc Map, never persisted (I7). Flags default off so
// the 27/31 golden is untouched. RESONANCE_WARM_RANK is read here so the MCP
// process actually ships the flag; ranking consumption is PR3 and ignored until then.
let _warm = null;
function getWarm() { if (!_warm) _warm = new WarmField(); return _warm; }
function warmEnabled() { return ENV_WARM; }
function warmTrace() { return ENV_WARM_TRACE; }
function warmEdgeCap() { return ENV_WARM_EDGE_CAP; }
// ENV_WARM_RANK is read (so the MCP process ships the flag) and ignored until PR3.

// --------------------------------------------------------------- embedding
async function embed(texts) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("embed HTTP " + res.status);
  const body = await res.json();
  return body.data.map((d) => d.embedding);
}

const store = new JsonlStore(STORE_PATH);

// The four verbs live in the shared engine (memory-core.js); server.js only wires
// the environment into it - network embed, the live field toggle, the lazy EdgeStore.
// eval/pipeline.js wires the SAME core to a cached embedder, so there is exactly one
// implementation of save/recall and the RM-00 golden guards that they never diverge.
const core = createCore({
  store, embed, fieldEnabled, getEdgeStore,
  warmEnabled, getWarm, getEdges: defaultGetEdges,
  saveSeed: () => true,          // production: a just-saved fact is warm without a recall
  warmTrace, warmEdgeCap,
});

// -------------------------------------------------------------------- tools
const TOOLS = [
  {
    name: "save_memory",
    description: "Store something worth remembering in future conversations. Call this PROACTIVELY, without being asked, whenever the user tells you something durable: a preference, a decision and its reason, a correction, a personal fact or relationship, a constraint, or a commitment. Do NOT save passing small talk, one-off details that won't matter next time, or passwords/secrets. Prefer editing an existing memory over saving a near-duplicate. Pass the full statement as `content`. Example: save_memory({\"content\":\"Samuel prefers I act and report rather than ask permission.\"})",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "The text to remember." } },
      required: ["content"],
    },
  },
  {
    name: "recall_memory",
    description: "Check what you already know before you answer. Call this at the START of a conversation, and any time the user refers to earlier context, their preferences, past decisions, or anything you may have been told before — including cues like 'remember', 'as I said', or 'my ...'. When unsure whether you know something relevant, recall first: it is read-only and cheap, and the memories are the user's own. Returns the most relevant memories, each prefixed with an `[id N]` you can pass to edit_memory or delete_memory. Example: recall_memory({\"query\":\"how does Samuel want me to handle permission\"})",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What you are trying to remember." } },
      required: ["query"],
    },
  },
  {
    name: "edit_memory",
    description: "Update a memory when a fact changes or the user corrects something — prefer this over saving a near-duplicate. Recall first to get the `id`, then pass `id` and the new `content`. Example: edit_memory({\"id\":\"1737400000000\",\"content\":\"corrected fact\"})",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: ["string", "number"], description: "The id shown as [id N] in a recall listing." },
        content: { type: "string", description: "The new text to store." },
      },
      required: ["id", "content"],
    },
  },
  {
    name: "delete_memory",
    description: "Remove a memory when it is wrong, obsolete, or the user asks you to forget it. Recall first to get the `id`. Example: delete_memory({\"id\":\"1737400000000\"})",
    inputSchema: {
      type: "object",
      properties: { id: { type: ["string", "number"], description: "The id shown as [id N] in a recall listing." } },
      required: ["id"],
    },
  },
];

async function callTool(name, args, requestId) {
  args = args || {};
  // JSON-RPC request id, extracted at this boundary (Phase 0.3). Threaded
  // into every verb; EdgeStore only *uses* it on mutating ops (save-time
  // bind, reinforceRecall). Missing/null id → no dedup (eval, panel, tests).
  const opts = { requestId };
  if (name === "save_memory") return await core.save(args.content, opts);
  if (name === "recall_memory") return await core.recall(args.query, 5, opts);
  if (name === "edit_memory") return await core.edit(args.id, args.content, opts);
  if (name === "delete_memory") return core.remove(args.id, opts);
  throw new Error("unknown tool: " + name);
}

// --------------------------------------------------------- MCP stdio plumbing
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "resonance-memory", version: VERSION },
    } };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (method === "tools/call") {
    try {
      const text = await callTool(params.name, params.arguments || {}, id);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (e) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } };
    }
  }
  if (method && method.startsWith("notifications/")) return null;
  if (id !== undefined) return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } };
  return null;
}

// Compact soft-deleted rows once at startup (keeps the file bounded; embeddings kept).
try { if (store.hasDeleted()) store.vacuum(); } catch { /* non-fatal */ }
// Soft-prune faded+weak edges (Phase 0.4 / I8). Explicit maintenance, same
// class as vacuum() — startup or on demand, NEVER recall/save. That is the
// golden guardrail: eval never starts the MCP server, so this sweep cannot
// move RM-00. Hard drop of pruned edges is EdgeStore.vacuum(), on demand.
try {
  const E = getEdgeStore();
  const byId = new Map(store.all().map((r) => [String(r.id), r]));
  E.pruneSweep({
    typeFn: (a, b) => hebbianDecayType(byId.get(String(a)), byId.get(String(b))),
  });
} catch { /* non-fatal: maintenance must never break startup */ }

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const res = await handle(req);
    if (res) send(res);
  }
});

process.stderr.write("resonance-memory MCP server (v2) running on stdio (store: " + STORE_PATH + ")\n");
