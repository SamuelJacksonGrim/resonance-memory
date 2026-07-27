# resonance-memory

A minimal MCP memory server a small local model cannot misuse. Two cognitive verbs today
(`save_memory`, `recall_memory`), growing to four (`edit_memory`, `delete_memory`). The
graph is the substrate, never the interface — the model never sees embeddings, importance,
timestamps, or any storage internals.

- Server: `server.js` (Node stdlib + built-in fetch, no SDK).
- Store: flat JSONL at `MEMORY_FILE_PATH` (default `~/.lmstudio/resonance-memory.jsonl`).
- Recall: local embeddings via LM Studio `/v1/embeddings`, cosine ranking, keyword-overlap
  fallback if the endpoint is down.
- Wired into LM Studio via `~/.lmstudio/mcp.json` as the `memory` server.

> **Cross-repo plan.** This is **Phase 1** of the Resonance memory stack. Lantern is the
> Phase-2 substrate that will replace the JSONL store behind the same MCP API. The
> portable work-order — roadmap + per-repo backlog — lives at
> https://github.com/SamuelJacksonGrim/resonance-memory-stack.

## Turn the associative field on/off (no terminal)

Double-click **`start-panel.bat`** (Windows) or **`start-panel.command`** (macOS). A browser
tab opens with a single switch:

> Associative field: **[ ON / OFF ]**

Flip it and it applies **instantly** — no restart. The switch writes `config.json`, which the
memory server reads on every recall. To turn the *whole* memory system on or off, use your
app's MCP server list (LM Studio / Claude Desktop).

*(Requires Node.js today — a fully bundled, no-install version is a planned packaging step.)*

## Design invariants (do not violate)

- **Four verbs, nothing more** in the public tool surface.
- **Ranking = cosine only.** `importance`/`access_count`/`durability` are stored substrate
  metadata that govern *retention*, never *retrieval order* — until a labelled-set A/B
  proves blending helps. (Measured: adding a durability weight to cosine inverts rankings.)
- **Embed once at save**, store the vector; recall embeds only the query.
- **Server owns all metadata.** The model never assigns importance or touches internals.
- **A `Store` abstraction sits behind the verbs** so the backend (JSONL now, Lantern later)
  can be swapped without changing the interface.
