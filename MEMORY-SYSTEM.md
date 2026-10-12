# The Resonance memory system

This is the memory system Samuel Jackson Grim and Ember built and run every day: one Claude Code instance, on one
machine, across months of work. It ships with Resonance Memory exactly as it runs there.

It is plain folders and markdown files on your computer. Nothing lives in a cloud and nothing needs managing by hand.
The AI files, corrects and recalls its own memories by the rules that come with it. You just talk.

**What you get:**

- **A memory folder with an index.** `MEMORY.md` is the index: one line per memory, ordered by tier (milestones,
  standing, episodic). It loads at the start of every session, so the AI starts out knowing what it knows.
- **The surface and the drawers.** The top level of the folder is the surface: who you are, how you want to be treated,
  how you and the AI work together, and standing safety lines. Those memories are never filed away. Everything else is
  filed in subject drawers (`projects/`, `tools/`, `reference/`), each with its own generated index card in
  `_indexes/`. `history/` holds faded text word for word, so nothing replaced is ever lost.
- **Auto-recall on every message.** A hook embeds each message you send and surfaces the memories that match it
  (cosine >= 0.70, top 3), with the drawer each one lives in. The AI doesn't have to remember to look.
- **Self-updating recall.** Every time the AI writes or edits a memory, the recall index rebuilds itself in the
  background. Only the changed memories are re-embedded, so it stays fast at any size.
- **The rules, in the folder.** `memory-architecture.md` is how the AI keeps memory honest over time: merge before
  adding; correct by replacing, never by appending "UPDATE:" notes; date every fact, let newer facts win only when
  better supported, and move replaced text to `history/` with the date and the reason. When a memory surfaces, the AI
  checks it: leaves it, corrects it, or fades it.
- **The filing cabinet tools** (`cabinet`): build the drawer indexes, fix links after a move, and check the folder is
  sound. They refuse to move, rename or overwrite a surface memory. See [CABINET.md](CABINET.md).

Claude Code's part is small: it loads `MEMORY.md` from the memory folder when a session starts and runs the hooks.
The structure, the index tiers, the recall, the rules and the cabinet are this system.

---

## Requirements

- **Resonance Memory** (the exe from the [release page](https://github.com/samueljacksongrim/resonance-memory/releases),
  or this repo with Node 20+). The exe carries everything the installer needs; nothing else is downloaded.
- **A local embedder** at an OpenAI-compatible `/v1/embeddings` endpoint. The default is LM Studio on
  `http://localhost:1234` with `text-embedding-nomic-embed-text-v1.5` loaded. Free, offline, about 2 s per search. If
  the embedder is down, auto-recall stays silent and never blocks a message.
- **Python 3.9+** for the cabinet tools (standard library only). Recall and the hooks don't need it.

## Install in Claude Code: one click

Run Resonance Memory. When Claude Code is on the machine, the page that opens has a **Memory system for Claude Code**
step next to Connect and the meaning engine. Press **Set up**: it shows exactly what it will do, then does it. The
memory folder is chosen for you (Claude Code's memory folder for your home directory; other existing project folders
are offered as choices). If the meaning engine isn't running yet, setup still finishes and the recall index builds
itself once it is. If your memory folder already has an index or rules, the page tells you the one sentence to say to
Claude to merge them.

## Install in Claude Code: by hand (hand this file to Claude)

Open Claude Code and say: *"Read MEMORY-SYSTEM.md from the resonance-memory repo and install the memory system for me."*
These are the steps Claude carries out:

1. **Find the memory folder.** Claude Code's memory folder is `~/.claude/projects/<project-folder>/memory/` for the
   project you start Claude in (the folder that holds, or will hold, `MEMORY.md`). Call it `DIR`. If it already has
   memories, back it up first (copy it next to itself, or commit if it's a git repo).
2. **Dry run:** `resonance-memory --install-memory-system --memory-dir DIR` (leave out `--memory-dir` to use the
   home-directory project's folder; the plan prints which folder it chose)
   (from source: `node entry.js --install-memory-system --memory-dir DIR`). It prints exactly what it will do and
   writes nothing. Show the user the plan.
3. **Install:** the same command plus `--apply`. It:
   - lays the template into `DIR` (index, rules, `history/`, drawers, `cabinet.tsv`). It never overwrites an
     existing file; if `MEMORY.md` or `memory-architecture.md` already exist, it leaves them and says so;
   - adds the two hooks to `~/.claude/settings.json` (recall on every message, rebuild after every memory write),
     keeping every existing hook and setting, with a `.bak`. Running it twice adds nothing;
   - adds the memory block to `~/.claude/CLAUDE.md` once, with this machine's paths filled in, so every session
     knows the layout and the rules;
   - writes `~/.resonance-memory/memory-system.json` (memory folder, cache, endpoint, model), copies the cabinet
     tools to `~/.resonance-memory/cabinet/`, and builds the recall index.
4. **If `MEMORY.md` or `memory-architecture.md` already existed,** merge by hand: bring the template's rules and
   index header into the existing files rather than keeping two versions. If there are existing memories, file them
   with the cabinet ([CABINET.md](CABINET.md)): when unsure, a memory stays on the surface.
5. **Check it works:** `resonance-memory --recall --query "who is the user"` returns results, and the next message
   in a new session shows a `[recall]` block when something matches.

Optional flags on install: `--endpoint`, `--model`, `--cache`. `resonance-memory --install-memory-system --help` lists them.

## Other agents

The memory is just a folder. Any agent that can read files can use it: point it at `DIR`, tell it to read
`MEMORY.md` first and follow `memory-architecture.md`. Local models, and other assistants (Grok and GPT read the same
folder on the machine this was built on), work from the same memories. Recall from the command line works for any of
them:

```
resonance-memory --recall --query "what I'm trying to remember"
resonance-memory --recall --history --query "..."     # search faded text on purpose
resonance-memory --recall --rebuild                    # after edits made by a script or shell
```

Per-message auto-recall needs a hook, which Claude Code has; in other apps, have the agent run the recall command
when a conversation starts.

## Undo

- Remove the two `--recall-hook` / `--rebuild-on-write` entries from `~/.claude/settings.json` (or restore its
  `.bak`), and the `## Memory (the Resonance memory system)` block from `~/.claude/CLAUDE.md`.
- The memory folder is yours: the installer only adds files to it and never deletes or rewrites any.
- `~/.resonance-memory/memory-system.json`, `memory-embeddings.json` and `cabinet/` can be deleted freely.

## How this relates to Resonance Memory's database

Resonance Memory's MCP server (the four verbs: save, recall, edit, delete) keeps its memories in a SQLite store, with
the associative field, the panel and export. This memory system is the folder-and-files side, used through Claude
Code's hooks or any agent that reads files. They work side by side; the folder system doesn't need the MCP server
running.
