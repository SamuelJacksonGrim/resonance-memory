# Memory system installer

One command lays the Claude Code memory system down from Resonance Memory.
Dry-run is the default and writes nothing. `--apply` does it. Not an MCP tool
(still the four verbs). README, CHANGELOG, CABINET.md, and the guide are
Ember's; this file is the build note.

## What it does

`node entry.js --install-memory-system --memory-dir <dir>` (or the exe with
the same flag):

1. Copies `memory-system/template` into the directory you pass (a Claude Code
   memory folder, for example `~/.claude/projects/<project>/memory`). There is
   no default folder. An existing file is never overwritten. An existing
   `MEMORY.md` or `memory-architecture.md` is left alone and the plan says
   "merge by hand".
2. Merges hooks into `~/.claude/settings.json`. Every other hook and setting
   stays. A `.bak` is written only when the file actually changes. A second
   run does not add a duplicate and does not rewrite the file.
   - `UserPromptSubmit`: this program `--recall-hook` (timeout 15, status
     "recalling memory..."). Appended to an existing match-all group, or a
     new group with no matcher.
   - `PostToolUse` matcher `Write|Edit|MultiEdit`: this program
     `--rebuild-on-write` (timeout 10, status "refreshing recall index...").
3. Appends `memory-system/CLAUDE-memory-block.md` to `~/.claude/CLAUDE.md`
   once, with `MEMORY_DIR`, `node RECALL_JS`, and `CABINET_DIR` filled.
   Paths with spaces are quoted. The literal `MEMORY.md` in that block is
   not a placeholder and is left as written. A `.bak` is kept when the file
   already had text.
4. Writes `~/.resonance-memory/memory-system.json` (`memoryDir`, `cache`,
   `endpoint`, `model`; extra keys kept) and copies the Python cabinet
   package to `~/.resonance-memory/cabinet/cabinet/`.
5. Full-rebuilds the recall cache. Default cache is
   `~/.resonance-memory/memory-embeddings.json` under the home the install
   is using, not a path frozen when the module loaded.

A bad `settings.json` (invalid JSON, hooks not an object, a group that is
not an object) or a missing `--memory-dir` stops before any write, including
on `--apply`. If the rebuild fails after the files are in place, the exit
code is 1 and the message says to re-run `--apply` when the embedder is up.
The template and the hooks are left as they were.

## Why the hooks go through the exe

The hook commands are Claude Code exec form (`command` + `args`, no shell),
which is the shape already in the live settings file. Exec form does not
portably set environment variables on Windows, macOS, and Linux, and a
shell-form `RECALL_MEMORY=...` prefix is a different shell on each. Hand-run
`--recall` and the filled `CLAUDE.md` block cannot see a hook-only env
either, so one file is the source for all three.

`recall.js` resolves memory, cache, endpoint, and model as: flag, then
`RECALL_*` (endpoint also accepts `EMBED_ENDPOINT`), then
`memory-system.json`, then the defaults. The model follows `RECALL_MODEL`,
then the file, never `EMBED_MODEL`. An empty `RECALL_CONFIG` turns the file
off. A partial env passed by a test, with no home keys, does not fall
through to this process's real home.

From source the hook command is `node` (`process.execPath`) plus the
absolute path of `entry.js` plus the flag. Packaged, it is the exe plus the
flag. Direct `node rebuild-on-write.js` still spawns `recall.js --rebuild`,
so the old detached-rebuild test keeps working.

Anything whose command or args already contain `--recall-hook`,
`recall-hook.js`, `recall-hook.ps1`, `--rebuild-on-write`,
`rebuild-on-write.js`, or `rebuild-on-memory-write.ps1` counts as already
installed. `--recall` alone does not. The live PowerShell hooks are left
byte-for-byte. To cut over, remove those two entries and run `--apply`
again. The same is true if the repo or the exe later moves: detection is by
flag name, not by path, so an old command is not rewritten.

## Cabinet stays Python

The package is `hooks/cabinet/cabinet/` (15 modules: `__main__`, check,
embedtext, errors, frontmatter, guard, indexgen, links, mapping, migrate,
ops, rules, safety, starter, plus `__init__`). That is the pin guard, the
index generator, link checking, and migrate, not a thin CLI. A Node port is
not small enough to do well in this slice, so it was not done. `--apply`
copies the tree. Re-index is `python -m cabinet` from
`~/.resonance-memory/cabinet` (Python 3.9+, stdlib only). The installer
does not check that Python is installed.

## What the binary carries

`build-exe.js` embeds, next to the demo seed and the system prompt:

- the CLAUDE memory block
- the memory-folder template (files and directory list)
- the five memory-system scripts (`recall.js`, `sources.js`,
  `recall-hook.js`, `rebuild-on-write.js`, `install-memory.js`)
- the cabinet package

`embedded-assets.js` is generated at build time and gitignored. The running
hooks are the bundled program, not extracted script files; the installer
does not write the JS out. Inside the exe, `__dirname` is not the repo, so
the template and the cabinet package come from the embedded copy. A dry-run
of `dist/resonance-memory.exe` against a temp home printed the template
plan and hook commands pointing at that exe, and wrote nothing.

## How to run

Dry-run (prints the plan, writes nothing):

```
node entry.js --install-memory-system --memory-dir <claude-memory-folder>
```

Do it:

```
node entry.js --install-memory-system --memory-dir <claude-memory-folder> --apply
```

The exe takes the same flags. Optional: `--cache`, `--endpoint`, `--model`.
`--help` prints the rest.

Hand search, after install (the config file supplies the folder and the
cache when the flag and the env are absent):

```
node entry.js --recall --query "what I'm trying to remember"
node entry.js --recall --rebuild
node entry.js --recall --plan
node entry.js --recall --history --query "..."
```

Hook stdin is the Claude Code JSON. `--recall-hook` prints the top 3 at
cosine >= 0.70, or a gated keyword match labelled `(keyword match)` if
the embedder is down, or nothing, and always exits 0. `--rebuild-on-write` only
fires for Write, Edit, and MultiEdit under the configured memory folder,
then returns without waiting.

## Tests

Not run against the live memory folder. The suite uses temp `USERPROFILE` /
`HOME` directories.

One direct exe launch in this session did read the real
`~/.claude/settings.json`. PowerShell's `$HOME` is a constant, so a temp
path never took and the process planned against `C:\Users\spamw`. It was a
dry-run: `settings.json` last write is still 2026-09-30 00:01:58, there is
no `settings.json.bak`, no `CLAUDE.md`, no `memory-system.json`, and no
`C:\Users\spamw\mem`. Nothing was applied. The real install is still yours
to run.

```
node hooks/memory-system/test.js
30 passed, 0 failed

node test.js
624 passed, 0 failed

node eval/run.js
27/31 checks passed
SqliteStore scorecard matches golden case-for-case.
No regressions vs golden.

node ci/smoke-exe.js dist/resonance-memory.exe
smoke ok  name=resonance-memory version=0.2.0
tools=[delete_memory, edit_memory, recall_memory, save_memory]
```

The new tests cover: config file used only when the flag and `RECALL_*` are
absent (`EMBED_MODEL` does not beat the file); the write hook watches the
config file's folder when `RECALL_MEMORY` is unset; dry-run writes nothing;
`--apply` without `--memory-dir` writes nothing; invalid `settings.json`
stops before any write; apply lays the template without overwriting
`MEMORY.md` or `memory-architecture.md`; the settings merge keeps existing
hooks and a second run adds nothing (bytes and `.bak` mtime unchanged);
the CLAUDE block is appended once; PowerShell hooks are preserved;
`node entry.js --recall-hook` with stdin JSON prints `[recall]` for a long
enough prompt. That last spawn is asynchronous on purpose: `spawnSync`
freezes the test process, so the fake embedder cannot answer and the
fail-silent hook prints nothing.

## Open questions

- A second `--apply` leaves settings, `CLAUDE.md`, the config, and existing
  template files byte-identical, but it still full-rebuilds the cache. If
  the embedder is down, that run exits 1 even though the files are already
  in place.
- Cutover off the PowerShell hooks is manual (remove them, re-apply). Same
  if you later point the hooks at a moved exe.
- `RECALL_CONFIG` set to an empty string disables the file. The hooks then
  no-op unless `RECALL_MEMORY` is in the environment, which a hook command
  cannot portably set.
- Python is assumed, not checked.
