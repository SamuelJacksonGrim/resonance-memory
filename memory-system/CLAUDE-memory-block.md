## Memory (the Resonance memory system)

My memory folder is `MEMORY_DIR` (its `MEMORY.md` index loads at the start of every session). Before saying I don't
know something about the user or our work, search it: `node RECALL_JS --query "what I'm trying to remember"`.
A hook also surfaces matching memories on every message; read the ones that look relevant.

**How the memory works (full rules + reasons in `memory-architecture.md` in that folder; read it before writing):**
- **Layout:** the top level is the surface (who the user is, how they want to be treated, how we work, standing
  rules: never filed away); everything else lives in `projects/`, `tools/`, `reference/` subject folders; `history/`
  holds faded text, flat. The hook shows a surfaced memory's folder.
- **Merge before adding:** find the memory something belongs in; don't make a second file.
- **Correct by replacement, never annotation.** No "UPDATE:" blocks. Rewrite the live text to what's true now.
- **Date, check, fade:** every fact is dated. Newer wins only when it's better supported. A real open conflict is
  written as the current state. Replaced text moves verbatim to `history/` with the date and reason (nothing lost).
  When a memory surfaces, check it: leave it if it holds, correct it, or fade it.
- **Filing:** surface material goes at the top level with a line in `MEMORY.md`; anything else in the matching
  subject folder plus a row in `cabinet.tsv`. Then `python -m cabinet index --memory MEMORY_DIR --apply` and
  `python -m cabinet check --memory MEMORY_DIR` from `CABINET_DIR`.
- The recall index rebuilds itself after every Write/Edit to that folder; after edits made by script or shell, run
  `node RECALL_JS --rebuild` by hand.
