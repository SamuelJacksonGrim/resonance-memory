#!/usr/bin/env node
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
const field = require("./field.js");
const { Ledger } = require("./ledger.js");

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

// Hebbian sidecar (Phase 2b), constructed lazily on first field use so the live
// toggle can turn it on without a restart.
let _ledger = null;
function getLedger() { if (!_ledger) _ledger = new Ledger(STORE_PATH + ".assoc.json"); return _ledger; }

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

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function keywordScore(query, text) {
  const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of q) if (t.includes(w)) hits++;
  return q.size ? hits / q.size : 0;
}

// ------------------------------------------------------------------- Store
// Swappable backend. This one is flat JSONL; a Lantern-backed Store can replace
// it later with the same method surface, leaving the MCP verbs untouched.
class JsonlStore {
  constructor(file) { this.file = file; }

  _normalize(r) {
    const created = r.created || r.ts || new Date().toISOString();
    return {
      id: r.id,
      created,
      modified: r.modified || created,
      text: r.text,
      embedding: Array.isArray(r.embedding) ? r.embedding : null,
      importance: typeof r.importance === "number" ? r.importance : 0,
      access_count: typeof r.access_count === "number" ? r.access_count : 0,
      last_access: r.last_access || null,
      deleted: !!r.deleted,
    };
  }

  all() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return this._normalize(JSON.parse(l)); } catch { return null; } })
      .filter(Boolean);
  }

  active() { return this.all().filter((r) => !r.deleted); }

  _writeAll(recs) {
    const data = recs.map((r) => JSON.stringify(r)).join("\n") + (recs.length ? "\n" : "");
    fs.writeFileSync(this.file, data, "utf8");
  }

  add(rec) { fs.appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf8"); }

  // patch matched by id (string-compared so a number or string id both work)
  update(id, patch) {
    const key = String(id);
    const recs = this.all();
    let found = false;
    for (const r of recs) { if (String(r.id) === key) { Object.assign(r, patch); found = true; } }
    if (found) this._writeAll(recs);
    return found;
  }

  // backfill freshly-computed vectors + bump access metadata in a single rewrite
  applyRecall(returnedIds, embeddingById) {
    const bump = new Set(returnedIds.map(String));
    const now = new Date().toISOString();
    const recs = this.all();
    for (const r of recs) {
      if (embeddingById && embeddingById.has(String(r.id))) r.embedding = embeddingById.get(String(r.id));
      if (bump.has(String(r.id))) {
        r.access_count += 1;
        r.last_access = now;
        r.importance = r.access_count; // retention signal only; NOT used in ranking
      }
    }
    this._writeAll(recs);
  }

  vacuum() {
    const kept = this.all().filter((r) => !r.deleted);
    this._writeAll(kept);
    return kept.length;
  }

  hasDeleted() { return this.all().some((r) => r.deleted); }

  nextId() {
    const ids = this.all().map((r) => Number(r.id)).filter((n) => !Number.isNaN(n));
    const max = ids.length ? Math.max(...ids) : 0;
    const now = Date.now();
    return now > max ? now : max + 1;
  }
}

const store = new JsonlStore(STORE_PATH);

// ---------------------------------------------------------------- service
async function saveMemory(content) {
  content = (content || "").trim();
  if (!content) return "Nothing to save: `content` was empty.";
  let embedding = null;
  try { embedding = (await embed([content]))[0]; } catch { embedding = null; }
  const now = new Date().toISOString();
  store.add({
    id: store.nextId(), created: now, modified: now, text: content,
    embedding, importance: 0, access_count: 0, last_access: null, deleted: false,
  });
  return "Saved. (" + store.active().length + " memories total.)";
}

async function recallMemory(query, k = 5) {
  query = (query || "").trim();
  if (!query) return "Provide a `query` string to recall.";
  const mems = store.active();
  if (!mems.length) return "No memories saved yet.";

  let ranked;
  try {
    // Embed the query plus only the records missing a stored vector (legacy or a
    // save-time endpoint outage). Steady state: nothing missing -> one embed call.
    const vectorless = mems.filter((m) => !m.embedding);
    const vecs = await embed([query, ...vectorless.map((m) => m.text)]);
    const qv = vecs[0];
    const fresh = new Map();
    vectorless.forEach((m, i) => fresh.set(String(m.id), vecs[i + 1]));

    ranked = mems
      .map((m) => ({ m, s: cosine(qv, m.embedding || fresh.get(String(m.id))) }))
      .sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.m);

    store.applyRecall(ranked.map((m) => m.id), fresh); // backfill + bump in one write
  } catch {
    ranked = mems
      .map((m) => ({ m, s: keywordScore(query, m.text) }))
      .sort((a, b) => b.s - a.s).slice(0, k)
      .filter((x, i) => x.s > 0 || i === 0).map((x) => x.m);
    store.applyRecall(ranked.map((m) => m.id), null); // bump access even on fallback
  }

  let out = ranked.map((m, i) => (i + 1) + ". [id " + m.id + "] " + m.text).join("\n");
  if (fieldEnabled() && mems.length > ranked.length) {
    try {
      const L = getLedger();
      const bonus = (a, b) => L.bonus(a, b);
      const edges = field.buildEdges(mems, { k: 2, minSim: 0.55, bonus });
      const rel = field.neighborhood(edges, ranked.map((m) => m.id), { hops: 1, max: 4 });
      if (rel.length) {
        const byId = new Map(mems.map((m) => [String(m.id), m]));
        out += "\n\nRelated:\n" + rel.map((e) => "- [id " + e.id + "] " + byId.get(String(e.id)).text).join("\n");
      }
      // Hebbian reinforcement on the returned payload, provenance-discounted.
      L.reinforceRecall(ranked.map((m) => m.id), rel.map((e) => e.id));
      L.tick();
      L.save();
    } catch { /* the field is additive; never let it break recall */ }
  }
  return out;
}

async function editMemory(id, content) {
  if (id === undefined || id === null || id === "") return "Provide the `id` shown in a recall listing.";
  content = (content || "").trim();
  if (!content) return "Provide the new `content`.";
  let embedding = null;
  try { embedding = (await embed([content]))[0]; } catch { embedding = null; }
  const ok = store.update(id, { text: content, embedding, modified: new Date().toISOString() });
  return ok ? "Edited memory " + id + "." : "No memory with id " + id + ".";
}

function deleteMemory(id) {
  if (id === undefined || id === null || id === "") return "Provide the `id` shown in a recall listing.";
  const ok = store.update(id, { deleted: true, modified: new Date().toISOString() });
  return ok ? "Deleted memory " + id + "." : "No memory with id " + id + ".";
}

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

async function callTool(name, args) {
  args = args || {};
  if (name === "save_memory") return await saveMemory(args.content);
  if (name === "recall_memory") return await recallMemory(args.query);
  if (name === "edit_memory") return await editMemory(args.id, args.content);
  if (name === "delete_memory") return deleteMemory(args.id);
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
      serverInfo: { name: "resonance-memory", version: "2.0.0" },
    } };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (method === "tools/call") {
    try {
      const text = await callTool(params.name, params.arguments || {});
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
