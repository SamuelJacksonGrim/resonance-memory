## Memory (the Resonance memory system)

My memory folder is `MEMORY_DIR`. It belongs to the user, and its purpose is that they never have to repeat
themselves, so I use it on my own, without being asked. Codex doesn't load it for me: at the start of real work I
read `MEMORY_DIR/MEMORY.md`, the index. On each message a hook may add a `[recall]` block as developer context: up to
three matching memories, each a name, a score and one line. It's a pointer: I open the file if it's relevant.

Before I say I don't know something about the user or our work, and before I ask them to explain something again, I
search: `node RECALL_JS --query "what I'm trying to remember"` (add `--history` for text that has faded to
`history/`). Nothing rebuilds the index when I change a file, so after any change in the folder I run
`node RECALL_JS --rebuild`, and if the folder is a git repository I commit the change. The resonance-memory tools
(`save_memory`, `recall_memory`, `edit_memory`, `delete_memory`) reach a separate store: one holds things the other
doesn't, so I search both. The full rules, with the reasons, are in `memory-architecture.md` in the folder.

**Where a memory goes**
- Top level: who the user is, how they want to be treated, how we work together, standing rules and safety lines.
  Each gets a line in `MEMORY.md`. These are never filed into a drawer, because that would quietly change how I work
  with them.
- `people/` (one file per other person, never the user, relation first: `sister--naima.md`), `projects/<project>/`
  (one file per thing or per rate of change: what-it-is, status), `tools/` (one per tool), `reference/` (maps,
  findings, ledgers, rosters). `history/` holds replaced text, verbatim, under the live file's name.
- File names are plain words a fresh instance would understand from the name alone, unique across every folder
  (recall drops a duplicate). Folders other than these aren't searched.
- A drawer file gets a row in `cabinet.tsv` (`<name><TAB><folder>`, or `.` for the top level), then from
  `CABINET_DIR`: `python -m cabinet index --memory MEMORY_DIR --apply` and `python -m cabinet check --memory
  MEMORY_DIR` (`relink --apply` after moving files). A rename is by hand: the file, its history file, and every
  `[[link]]` and plain mention of the old name.

**What a memory holds.** The first paragraph is the current truth and names what it's about; readers stop early. What
and why: status and next steps live in the project's worklist or backlog with one pointer line here, how-tos in docs
or skills. At most one dated state line ("As of 2026-10-22: ..."). A big subject is split by how fast its parts
change, under about 4 KB per file. Related memories are linked with `[[their-name]]`.

**Frontmatter.** `name` (= the filename), `description` (one line, gist first, names what it's about), and under
`metadata`: `type` (user / feedback / project / reference), `persistence`, `reviewed` (YYYY-MM-DD), `subject`,
`contains: [...]`, `sensitivity` (normal / personal / sensitive), `surfaces-when` (what the user or I would say when
it matters). `milestone` never fades and is never merged away or pruned (it can still be corrected), and a file it
links to directly is protected too, one hop only; `standing` is durable and updated in place; `episodic` is a point
in time, expected to fade. Persistence decides what stays, never what ranks.

**Changing a memory**
- Merge before adding: find the file it belongs in and fold it in, keeping every specific that matters. Merge by
  reading both and rewriting one; never merge an already-merged file without re-reading its sources.
- Correct by replacement: rewrite the wrong text, and the description and `MEMORY.md` line with it. No "UPDATE",
  "CORRECTED", "no longer", "was X, now Y", and no writing a wrong idea down just to deny it ("X is not Y").
- Fade, don't pile up, don't delete: the live text becomes the current state and the old text moves verbatim to
  `history/<same-name>.md` under a line with the date and the reason. The live file ends with
  History: `history/<name>.md` (what's in it). A mistake that was never true is just removed.
- Date, check, fade: every fact carries its absolute date. Newer wins only when better supported; an unsettled
  conflict is written as the current state ("Open as of <date>: A vs B, because ..."). When a memory surfaces and I
  read it, I check it: if it holds, I set `reviewed` to today and change nothing else; if not, I correct or fade it.
- `MEMORY.md` holds only what must be in view before recall runs (one line per top-level file, hard rules whose files
  sit in drawers, a short "Now", one line per drawer), under about 10 KB. When it grows, trim the index, never the
  files.
