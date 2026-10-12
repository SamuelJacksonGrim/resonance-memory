# The memory filing cabinet

Part of [the Resonance memory system](MEMORY-SYSTEM.md): the filing system Samuel Jackson Grim and Ember built for
the memory folder they run every day. The installer sets it up with everything else; this page is how it works and
how to file a folder that already has memories in it.

**What it does:** a memory folder with one flat list grows hard to navigate. The cabinet files it:

- **The surface** stays at the top of the folder: who you are, how you want to be treated, how you and the AI work
  together, and any standing safety lines. Those memories stay put: the cabinet scripts will never move, rename,
  delete or rewrite them. Filing them away would quietly change how the AI works with you.
- **Drawers** hold everything else, sorted by subject: `projects/<subject>/`, `tools/<subject>/`,
  `reference/<subject>/` (people, places, findings). A folder holds however many files share its subject; it splits
  only when part of it keeps being wanted on its own.
- **`history/`** (flat) holds faded material: fixed problems, finished phases, replaced text, kept word for word with
  the date and the reason, so nothing replaced is ever lost.
- **Index cards** in `_indexes/`, one per drawer (every memory in it and its one-line description), linked from the
  top of `MEMORY.md`.

"Stays put" only restrains the *scripts*. The AI still edits any memory in conversation, the normal way; nothing here
adds a sign-off step.

It works on any memory folder of markdown files. It's independent of Resonance Memory's own SQLite store, and pairs
with the memory system's auto-recall, which shows the drawer each surfaced memory lives in.

> **Easiest setup:** run the [memory system installer](MEMORY-SYSTEM.md). If the folder already has memories, then
> say to Claude *"Read CABINET.md from the resonance-memory repo and file my memory folder."* The steps below are
> written so Claude can follow them.

---

## Requirements

- **Python 3.9 or newer** (`python --version`). The scripts use only the standard library.
- The cabinet scripts. The installer copies them to `~/.resonance-memory/cabinet/`; from the repo they're
  [`hooks/cabinet/`](hooks/cabinet/).

## Setup (steps for Claude to carry out)

1. **Find the memory folder.** Claude Code keeps it under `~/.claude/projects/<project-folder>/memory/` (the folder
   that holds `MEMORY.md`). Call it `DIR` below. Run every command from the copied `cabinet` folder
   (`cd ~/.resonance-memory/cabinet`).
2. **Back it up first.** Copy the whole folder next to itself (`memory.bak-<date>`), and compare the copy against the
   original before going on. If the folder is a git repo, commit first as well. Keep the backup until step 8 passes.
3. **Set up the drawers:** `python -m cabinet init --memory DIR` shows what it will do; add `--apply` to do it. This
   creates `projects/`, `tools/`, `reference/` and writes `DIR/cabinet.tsv`, with every existing memory marked `.`
   (stays at the top level). Nothing moves yet.
4. **Decide where each memory goes.** Read each memory and edit `cabinet.tsv`: one row per memory,
   `<name><TAB><destination>`.
   - Keep `.` for anything that shapes the relationship: who the user is, their circumstances and constraints, how
     they want to be talked to, how you work together, your identity, and standing safety lines. **When unsure, keep
     it `.`**: a file left at the top that didn't need to be costs a little context, while a relationship memory filed away changes how
     Claude behaves.
   - Everything else goes to `projects/<subject>`, `tools/<subject>` or `reference/<subject>`, named for its subject.
   - A memory can live in a drawer and still keep its one-line entry in `MEMORY.md`. If a drawer file carries a rule
     that should always be in view (a hard boundary, a care stance), keep that rule in its index line.
   - Show the user the plan in plain words before applying it: what stays at the front and what goes where.
5. **Move the files:** `python -m cabinet migrate --memory DIR` (dry run), then add `--apply`. It refuses to move a
   surface file, refuses to overwrite, and checks every moved file is byte-identical to the original.
6. **Build the indexes:** `python -m cabinet index --memory DIR --apply` (written under `DIR/_indexes/`).
7. **Fix the index links:** `python -m cabinet relink --memory DIR --apply` rewrites `MEMORY.md`'s links to the moved
   files' new locations. It reports any link that still doesn't resolve.
8. **Check:** `python -m cabinet check --memory DIR` must say `ok: true` (unique names across folders, every
   `[[link]]` resolves, every surface memory still at the top level, every memory listed in `cabinet.tsv`). Then delete the
   backup from step 2.
9. **Teach future sessions to file.** Add a short block to the user's `~/.claude/CLAUDE.md` so every session knows
   the layout, for example:

   ```markdown
   ## Memory cabinet
   My memory folder is filed: the top level is the surface (who the user is, how we work; never filed away), and
   everything else lives in projects/, tools/, reference/ subject folders (history/ holds faded text, flat).
   When saving a new memory: surface material goes at the top level with a line in MEMORY.md; anything else goes in
   the matching drawer folder (a new subject folder if none fits) plus a row in cabinet.tsv. Then run, from
   ~/.resonance-memory/cabinet: python -m cabinet index --memory <dir> --apply and
   python -m cabinet check --memory <dir>. Correct a memory by rewriting it, not by appending "UPDATE" notes;
   move replaced text to history/ with the date and the reason.
   ```

## Undo

Restore the step-2 backup (or `git checkout` the folder). The scripts never delete memory content: a move is a
byte-identical copy followed by removing the original, and they refuse anything that would overwrite.

## Commands

| Command | What it does |
|---|---|
| `init --memory DIR [--apply]` | create the drawers and a starter `cabinet.tsv` (never overwrites one) |
| `migrate --memory DIR [--apply] [--report PATH]` | move files per `cabinet.tsv`; refuses surface files and overwrites |
| `index --memory DIR [--apply]` | write drawer indexes (and a pointer index of `~/.claude/skills`) under `_indexes/` |
| `relink --memory DIR [--apply]` | point `MEMORY.md`'s links at the files' current locations |
| `check --memory DIR` | unique names, links resolve, surface memories at the top, every memory mapped |
| `list --memory DIR` / `surface --memory DIR` | print the live memories / the surface (stays-put) names |

`--mapping FILE` overrides the default `DIR/cabinet.tsv`. Every command that writes is a dry run unless `--apply` is
passed. Tests: `python -m unittest discover -s tests` inside `hooks/cabinet/`.
