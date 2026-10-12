# One-click memory system

A double-clicked exe walked through Connect and the meaning engine and never
mentioned the memory system. The panel now sets that up the same way, when
Claude Code is present. Still not an MCP tool. README, CHANGELOG,
MEMORY-SYSTEM.md, and the version were left alone (still 0.3.0).
`NOTES-install.md` was left alone too; the two places it is now stale are
called out below.

## What was built

Signal for Claude Code is a directory `~/.claude`, resolved with
`homeFromEnv` (on Windows that is `USERPROFILE`, then `HOMEDRIVE`+`HOMEPATH`,
then `HOME`). Not `which claude`. The card stays hidden when that directory
is absent, and a POST then returns `{ ok: false, code: "no_claude" }` and
writes nothing. Apply is what creates `~/.claude` if it was missing; a
dry-run does not.

The card is "Memory system for Claude Code". One button, "Set up", and only
while the state is not set up. States:

- not set up (`absent`): no `memoryDir` in `memory-system.json`, or the two
  hooks are not both present (UserPromptSubmit recall hook and PostToolUse
  rebuild hook)
- set up (`ready`): those are present and the recall cache has at least one
  entry with a non-empty vector
- set up, index not built (`index-pending`): files and hooks are in place,
  cache is missing or has no vector

The button opens a confirm modal. The plan is the installer's own dry-run
(`installMemorySystem` with `apply: false`), the same pattern as Export /
Import. Apply calls that same function in-process. There is no second
installer. POST is under the existing panel gate: loopback host, Origin if
present must be this panel, mutating methods need `X-Resonance-Token`.

The folder the panel will write has to be one of the choices it offered: the
home default, or an existing `~/.claude/projects/<one segment>/memory` whose
realpath stays under `projects`. A symlink that leaves that directory is
rejected (`400 bad_dir`) and nothing is written. The home choice is sent as
an empty `memoryDir` so the plan still says `(default)`. Apply and the
index rebuild pause the watchdog, take the same in-flight lock as
export/import (`409` if a second POST arrives), and honor
`RM_PANEL_MEMORY_HOLD`. A dry-run does not take the lock. Rebuild and apply
in one body is `400`.

## 2. Default folder: yes, including the CLI

Claude Code's project encoding was checked read-only on this machine.
`~/.claude/projects` contained one directory, `C--Users-spamw`, and it has a
`memory` folder. That is `C:\Users\spamw` with `:` and `\` each replaced by
`-`. No other project folder was there, so a space or an underscore was not
observed live.

The rule implemented: drop a trailing separator, then every character
outside `[A-Za-z0-9]` becomes `-`. Dashes are not collapsed. Case stays.
A temp path `C:\Users\spamw\AppData\Local\Temp\rm-exe-dry-4uyDG3` encodes to
`C--Users-spamw-AppData-Local-Temp-rm-exe-dry-4uyDG3`.

`--memory-dir` now defaults to `~/.claude/projects/<encoded home>/memory`.
The plan prints `memory directory: <path> (default)` only when the flag was
omitted. An explicit `--memory-dir` is unchanged. No home and no
`--memory-dir` still refuses before any write. Dry-run still writes nothing.

The old reason for no default ("only the user's Claude knows the folder")
is weaker than making someone find an encoded name. The chosen folder is in
the plan, so a wrong guess is visible before `--apply`. Other existing
`~/.claude/projects/*/memory` folders are radio choices in the panel. The
CLI does not grow a chooser; it uses the home project unless you pass a path.

`NOTES-install.md` still says there is no default folder. That sentence is
stale. The exit-1 sentence in that file is still true for the CLI.

## 3. A down meaning engine finishes the panel install

The CLI still exits 1 when the initial rebuild fails, with the old line
"Re-run --apply when the embedder is up." A script that checks the exit code
still hears that the index is missing.

The panel calls `installMemorySystem` with `deferIndex: true`. Deferral
happens only when `recall.rebuild` returns `reason === "embedder"` (the
healthcheck or a per-file embed failure). `missing`, `lock`, `list`,
`duplicate`, `empty`, and a throw still exit 1, on the panel too. On defer:
exit 0, index `"pending"`, files and hooks left in place, and the plan says
the index will build once the meaning engine is up.

`recall.rebuild` now returns that `reason` on each exit 1. The success
return is unchanged.

Building the index later is a POST `{ rebuildIndex: true }`, never a side
effect of GET. GET is untokened when Origin is absent, so it must stay
read-only. The page requests that rebuild once per load when the card is
`index-pending` and `/api/engine` is `ready`, again after the meaning
engine's own Set up succeeds, and again after an apply that is still
pending. It is not on the 8-second poll. The first memory write still
rebuilds through the existing rebuild-on-write hook. The recall hook stays
silent while there is no cache.

`rebuildInstalledIndex` passes `memoryDir`, `cache`, `endpoint`, and `model`
from `memory-system.json` and sets `skipConfig: true`, so a leaked
`RECALL_MEMORY` cannot steer the rebuild at some other directory.

## 4. A stable home for the binary: not this slice

Not implemented. Doing half of it would be worse than leaving it.

Hook commands and the Connect MCP config both record `process.execPath`.
Deleting the exe out of Downloads kills both. A copy under
`~/.resonance-memory/bin/` on first Connect or setup would fix both only if
all of the following are decided together:

- A newer exe has to replace that copy, and the hooks keep pointing at the
  old copy until Connect or setup runs again. Windows cannot replace a
  binary this process was launched from.
- macOS quarantine and Gatekeeper apply to a copied binary, not just the
  one the user double-clicked.
- From source, `process.execPath` is `node` plus `entry.js`. Copying an exe
  does not apply, and pointing the hooks at a copy would be the wrong command.
- Connect's MCP config has the same exposure. Fixing only the memory hooks
  leaves the panel's other "it just runs" path broken in the same way.

That is its own slice. Nothing here copies the binary or rewrites an
existing hook command. Detection is still by flag name, not by path, which
is what `NOTES-install.md` already says.

## 5 and 6

An existing `MEMORY.md` or `memory-architecture.md` is still left in place.
The CLI plan still says "; merge by hand", so the old tests keep passing.
The panel strips that substring and shows this, as text, not as HTML:

> Read MEMORY-SYSTEM.md from the resonance-memory repo and merge the memory system into my memory folder

It shows in the confirm modal and, after install, on the card. Only when
the file exists and differs from the template (`state === "keep"`). A file
the template will write does not get the sentence.

The first-run box, which already shows when the user store is empty, gains
one sentence when Claude Code is present and the memory system is not set
up yet. It names the card and says it is the same kind of step as Connect
and the meaning engine. If the store already has memories, the card on its
own is the whole prompt. If `~/.claude` is absent, neither appears.

## Tests

Run from this worktree. Nothing was pointed at the real `~/.claude` or the
live memory folder. On Windows, PowerShell's `$HOME` is a constant and does
not redirect `homeFromEnv`; the child's `USERPROFILE` and `HOME` are set to
the temp home. Tests also set `RESONANCE_MEMORY_NO_OPEN=1`.

- `node hooks/memory-system/test.js` — 35 passed, 0 failed.
- `node test.js` — 629 passed, 0 failed. An earlier run in this same work
  failed once, unrelated: "trace(id) is callable and matches get(id)" in
  `warm.js` (not touched), actual `0.9999976895120674` vs `1` from lazy
  wall-clock decay between seed and trace. The immediate re-run was 629/0,
  and this close-out re-run was 629/0. That test was not changed.
- `node eval/run.js` — scorecard `2026-10-12T06:37:22.231Z`, store=sqlite,
  TOTAL 27/31. SqliteStore matches the golden case for case. No regressions.
  The four failures are the known ones: three field-off rescues
  (`field-rescue`, `field-rescue-veg`, `field-rescue-heights`) and
  `adv-height-homonym` with the field on. Field lifted 3 and broke 1.
- `node build-exe.js`, then `node ci/smoke-exe.js dist/resonance-memory.exe`
  — smoke ok, name=resonance-memory, version=0.3.0, tools exactly
  `delete_memory`, `edit_memory`, `recall_memory`, `save_memory`. That exe
  was built before a one-line no-op was deleted from the panel page script
  (`memoryStatus.handMerge = memoryStatus.handMerge`). Smoke only speaks
  MCP, and `server.js` was not changed. The exe was not rebuilt for that
  deletion. `dist/` is gitignored and is not in the commit.
- Exe dry-run, child env `USERPROFILE` and `HOME` set to a `mkdtemp` under
  `%TEMP%`, `RESONANCE_MEMORY_NO_OPEN=1`, `RECALL_*` and `EMBED_*` removed:
  exit 0, stdout started with "dry run: nothing will be written", and the
  plan printed that temp home's encoded project memory folder with
  `(default)`, endpoint `http://localhost:1234`, model
  `text-embedding-nomic-embed-text-v1.5`. The real path
  `C:\Users\spamw\.claude\projects\C--Users-spamw\memory` was not in the
  output. The temp home had no `settings.json` and no `memory-system.json`.

The panel was not clicked in a browser. There is no browser tool in this
session. The card, the modal, W-02, the bad-folder refusal, apply, the
deferred index, and the in-flight 409 were exercised over HTTP against a
panel whose home was a temp directory. The page script was extracted and
`node --check`'d before the no-op deletion; `node --check panel.js` passed
after it.

## Open questions

- The stable binary home in point 4. Not started. It has to cover Connect
  and the memory hooks together, plus updates, macOS quarantine, and
  running from source.
- Space and underscore were not in the live `~/.claude/projects` listing.
  If Claude Code ever collapses repeated dashes or lowercases the folder,
  the default here would miss. One look at a Mac path that contains a space
  would settle it.
- A `~/.claude` left behind after an uninstall still shows the card. That
  is the right signal for "the memory folders live here", and the wrong
  signal for "the `claude` binary is on PATH".
- If the meaning engine becomes ready while this panel stays open, and the
  user never presses the engine's Set up, the index waits for the next open
  or the first memory write. That is deliberate: the poll is a GET, and a
  GET must not start a rebuild.
