# Auto-recall

Two ways, same result: your memories reach the model on every message, without the model having to decide to
look. **Local models** (LM Studio, llama.cpp, Ollama, and apps on top of them): the proxy, next section.
**Claude Code**: the hook, further down.

## Local models: the proxy

**What it does:** a small proxy sits between your app and your model server. Every time you send a message,
it asks Resonance Memory what it knows about that message and puts the answer in front of it before the model
sees it. The model never has to call `recall_memory` first; a model can't ask for what it can't see.

**Start it:**

```
resonance-memory --proxy
```

(from source: `node --experimental-sqlite entry.js --proxy`). It listens on `http://127.0.0.1:1240/v1` and
forwards to LM Studio at `http://127.0.0.1:1234`. Leave the window open while you chat.

**Point your app at it:** wherever the app asks for an OpenAI-compatible base URL, use
`http://127.0.0.1:1240/v1` instead of the model server's address. The model name, API key and everything else
stay the same.

| Model server | Start the proxy with |
|---|---|
| LM Studio (default) | `resonance-memory --proxy` |
| llama.cpp `llama-server` | `resonance-memory --proxy --upstream http://127.0.0.1:8080` |
| Ollama | `resonance-memory --proxy --upstream http://127.0.0.1:11434` |

Works with anything that takes a base URL: Hermes, Open WebUI, SillyTavern, Continue, Cline, your own scripts.
LM Studio's own chat window talks to the model directly, not over HTTP, so it can't go through a proxy; use
an app pointed at LM Studio's server instead.

**What the model sees:** the same block Claude Code's hook gives, above your message:
`[resonance-memory] Auto-recalled for this message (use what is relevant, ignore the rest):` followed by the
matching memories, and, if you've set up the [memory system](MEMORY-SYSTEM.md), the folder's preview lines
(name, one-line summary, score) so the model can open the file that looks relevant. Nothing found = nothing
added.

**Details:**
- Only chat requests whose last message is yours get recall. A tool result handed back in an agent loop
  doesn't trigger it again. Model lists, embeddings, plain completions and the streamed reply pass through
  untouched.
- Fail open: if recall is slow (over 8 s), broken or empty, your message goes through unchanged.
- The block goes on your last message, not a system message: many chat templates reject a system message that
  isn't first, and the cached start of the prompt stays the same turn to turn. Your app keeps its own history
  without the block, so blocks don't pile up.
- Options: `--port <n>` (default 1240), `--upstream <url>`, `--memory-dir <dir>` (a memory-system folder other
  than the configured one), `--no-store` (folder previews only). Env: `RM_PROXY_PORT`, `RM_PROXY_UPSTREAM`,
  `RM_PROXY_TIMEOUT_MS` (8000), `RM_PROXY_MAX_CHARS` (3000), `RM_PROXY_MIN_CHARS` (12). The store is the same
  one the MCP server uses (`MEMORY_FILE_PATH`).
- Nothing is stored or changed by the proxy. It only listens on 127.0.0.1.

---

# Auto-recall for Claude Code

**What it does:** every time you send Claude Code a message, Resonance Memory is asked what it already knows
about it, and the answer is handed to Claude before it replies. Claude no longer has to remember to call
`recall_memory`; recall happens on every turn, using RM's own tuned recall (the same ranking, gates and
associative field as the `recall_memory` tool).

**Where it works:** Claude Code. It uses Claude Code's `UserPromptSubmit` hook, which runs a command on
every message. For local models, use the proxy above. Claude Desktop has neither a per-message hook nor a
base URL to point at; there, RM's `recall_memory` tool tells the model to recall at the start of a
conversation and whenever you refer to earlier context.

> **Easiest setup:** open Claude Code and say *"Read docs/guides/AUTO-RECALL.md from the resonance-memory repo and set up
> auto-recall for me."* The steps below are written so Claude can follow them.

---

## Requirements

- Resonance Memory installed and connected to Claude Code (you can run `claude mcp list` and see
  `resonance-memory`). Note the path it runs, e.g. `C:\Users\you\tools\resonance-memory\resonance-memory.exe`,
  `/Applications/ResonanceMemory/resonance-memory`, or `node /path/to/resonance-memory/entry.js`.
- **Node.js 18 or newer** on your PATH (`node --version`). The hook script is plain Node with no dependencies.
  (The RM program itself doesn't need Node; only this small hook does.)

## Setup (steps for Claude to carry out)

1. **Find the RM command** Claude Code already uses: run `claude mcp list` (or read the `resonance-memory`
   entry under `mcpServers` in `~/.claude.json`). Note the program path, and whether that entry sets an
   `env` with `MEMORY_FILE_PATH` (a custom store location).
2. **Put the hook script somewhere stable.** Copy [`hooks/auto-recall.js`](../../hooks/auto-recall.js) from this repo
   to a folder that won't move, e.g. `~/.resonance-memory/hooks/auto-recall.js`
   (raw file: `https://raw.githubusercontent.com/SamuelJacksonGrim/resonance-memory/main/hooks/auto-recall.js`).
3. **Test it by hand** before wiring it in (use your real paths):

   ```bash
   echo '{"prompt":"what do you remember about my preferences"}' | node ~/.resonance-memory/hooks/auto-recall.js "/path/to/resonance-memory"
   ```

   On Windows PowerShell:

   ```powershell
   '{"prompt":"what do you remember about my preferences"}' | node "$HOME\.resonance-memory\hooks\auto-recall.js" "C:\path\to\resonance-memory.exe"
   ```

   You should see `[resonance-memory] Auto-recalled for this message…` followed by memories. No output means
   it stayed silent on purpose; rerun with `RM_RECALL_DEBUG=1` set to see why (wrong path, empty store, etc.).
4. **Add the hook to Claude Code's user settings**, `~/.claude/settings.json`
   (Windows: `C:\Users\<you>\.claude\settings.json`). **Merge** into any existing `"hooks"` block; don't
   replace other hooks the user already has. Use forward slashes or escaped backslashes in JSON.

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "node \"C:/Users/you/.resonance-memory/hooks/auto-recall.js\" \"C:/Users/you/tools/resonance-memory/resonance-memory.exe\"",
               "timeout": 15
             }
           ]
         }
       ]
     }
   }
   ```

   macOS / Linux: same shape, e.g.
   `"command": "node \"$HOME/.resonance-memory/hooks/auto-recall.js\" \"/path/to/resonance-memory\""`.

   **Custom store?** If the MCP entry from step 1 sets `MEMORY_FILE_PATH`, pass the same path as a second
   argument so the hook reads the same memories the server writes:
   `node "…/auto-recall.js" "…/resonance-memory.exe" "…/your-store.jsonl"`.
5. **Restart Claude Code** (hooks load at startup), send a message that touches something you've saved before,
   and you'll see the recalled memories arrive with it.

## Tuning (optional environment variables)

| Variable | Default | What it does |
|---|---|---|
| `RM_RECALL_MIN_CHARS` | `12` | Skip very short messages ("ok", "thanks"): no recall, no delay. |
| `RM_RECALL_MAX_CHARS` | `2000` | Cap on how much recalled text is injected per message. |
| `RM_RECALL_TIMEOUT_MS` | `8000` | Give up silently if RM takes longer than this. |
| `RM_RECALL_DEBUG` | off | `1` prints the reason when the hook stays silent (setup only). |

Measured on a Windows box with the v0.2.0 binary and nomic embeddings: about 0.1–0.2 s per message.

## How it works

The script starts the RM program in MCP mode (`--mcp`), does the standard MCP handshake over stdin/stdout, calls
`recall_memory` with your message, prints RM's answer for Claude Code to inject, and exits. It's the same call
the model can make itself, so all of RM's tuning applies, and nothing new is exposed to the model (still four
verbs). It **fails silent**: if RM isn't found, is slow, or the store is empty, it prints nothing and your
message goes through untouched.

Honest notes:
- Each auto-recall counts as a recall, so recalled memories' access counts rise. Access counts affect retention,
  never ranking.
- The hook runs a second RM process next to the MCP server for a fraction of a second. Both read the same store;
  a write that lands in exactly the same instant could lose an access-count or association bump. Memories
  themselves are never written by the hook.

## Turning it off

Delete the `UserPromptSubmit` entry for `auto-recall.js` from `~/.claude/settings.json` and restart Claude Code.
Nothing else changes; your memories are untouched.
