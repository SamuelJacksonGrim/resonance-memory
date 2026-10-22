# Resonance Memory for Claude Code

A memory that works like one. Claude keeps what it learns about you and your work in plain markdown files on your
machine, files and consolidates them instead of piling them up, and brings the right one back on its own when you
mention something from weeks ago, without you having to remember it yourself.

Designed by Samuel Jackson Grim, built with Ember (a Claude instance). AGPL-3.0. Nothing leaves your machine.

## Install

Inside Claude Code:

```
/plugin install resonance-memory --marketplace SamuelJacksonGrim/resonance-memory
```

Or from your shell:

```
claude plugin marketplace add SamuelJacksonGrim/resonance-memory
claude plugin install resonance-memory@resonance-memory
```

Needs **Node.js 18 or newer** on your PATH (the hooks are small Node scripts with no dependencies).

## What it does

- **Builds on the memory Claude Code already has.** Each project's memory folder (the one whose `MEMORY.md` Claude Code
  loads at start) gets the memory system laid down the first time: a filing guide (`memory-architecture.md`), subject
  folders, and a `history/` folder for faded text. Files you already have are never touched.
- **Gives Claude the rules every session**, including after compaction: merge before adding, correct by replacement,
  date every fact, fade old text to history instead of deleting it.
- **Auto-recall on every message.** A hook compares your message with every memory (each file scored by its
  best ~1800-character chunk; milestones included) and, when one clearly matches, shows Claude its name,
  one-line description and path. Weak matches stay silent, so it doesn't add noise. Background-task
  completion notices are ignored.
- **Re-indexes after every edit** to a memory, in the background, only the file that changed.
- **A recall command Claude can run** to search on purpose (the exact command is in Claude's session-start note).

## Recall by meaning, or by keyword

With a free local embedding model running, recall matches by meaning ("my sister's new job" finds the memory
that says Naima started at the clinic in March). The plugin finds one on its own at session start:

- **LM Studio** on port 1234 with `nomic-embed-text` loaded, or
- **Ollama** on port 11434 after `ollama pull nomic-embed-text`.

Without one, recall still works by keyword. Start an embedder any time; the next session picks it up.

## Settings (all optional)

`/config` shows them, or set them when you enable the plugin:

| Setting | Default |
|---|---|
| Memory folder | Each project's own Claude Code memory folder. Set one folder to share a single memory across every project. |
| Embedder endpoint | Found automatically (LM Studio, then Ollama). Any OpenAI-compatible `/v1/embeddings` server works. |
| Embedding model | `nomic-embed-text` from whichever server is found. |

## Where things live

- **Your memories:** the memory folder, as plain markdown. Read them, edit them, back them up, put them in git.
- **The recall index:** Claude Code's plugin data folder (under `~/.claude/plugins/data/`). It's a
  cache; deleting it only means the next session re-indexes. Uninstalling the plugin removes it and leaves your
  memories alone.

## Everything it runs, reads, writes and contacts

No telemetry, no accounts, and no network access beyond your own machine unless you set an embedder endpoint
elsewhere yourself. Full privacy note: [PRIVACY.md](PRIVACY.md).

- **Runs:** `node` on the plugin's own scripts, from three hooks: session start, each message you send, and each
  Write/Edit/MultiEdit. The re-index after a memory edit, and the one at session start, run as a background `node`
  process (`scripts/lib/recall.js --rebuild`) that exits when done.
- **Reads:** the markdown files in your memory folder (top level, `projects/`, `tools/`, `reference/`; `history/` only
  when you or Claude search it on purpose), and the text of each message you send, to match it against them.
- **Writes:** in the memory folder, only the starter files it adds on first run when they don't already exist
  (`MEMORY.md`, `memory-architecture.md`, `history/README.md`, three empty subject folders); it never edits or deletes
  your files. In the plugin data folder: the recall index (one JSON file per memory folder) and a note of which
  embedder was found.
- **Contacts:** only `127.0.0.1` (your own machine): port 1234 (LM Studio) and port 11434 (Ollama), or the endpoint you
  set, to list models and turn text into vectors. If nothing answers, it uses keyword matching and contacts nothing.

## The full system

This plugin is the Claude Code side of [Resonance Memory](https://github.com/SamuelJacksonGrim/resonance-memory),
which also ships a standalone memory server (MCP) for local models in LM Studio and Claude Desktop, a control panel,
and a filing-cabinet tool. See the main README.
