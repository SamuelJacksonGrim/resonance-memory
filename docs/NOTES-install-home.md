# Install home

Connect and the two memory hooks were writing down `process.execPath`.
Run the exe from Downloads, clean Downloads later, and recall stops
with no error that points at the cause. v0.3.1 left this out on
purpose. This slice puts the packaged program in one folder and keeps
every path we own pointed at that file.

README, CHANGELOG, MEMORY-SYSTEM.md, the itch page, and the version
were left alone. Still 0.3.1. Still four MCP verbs.

## What was built

`install-home.js` decides. The panel and the CLI call it. It is not an
MCP tool.

A packaged exe is "at home" when `resonance-memory.install.json` sits
beside it (`installed: true` and a version string). Anywhere else is a
stray copy. `node entry.js` is source. Source never installs and never
consults the install record. `--install-app` from source exits 1 and
writes nothing.

On first run of a stray exe the panel shows "Where should Resonance
Memory live?" The folder is a text field, filled with the default,
editable. Checkbox "Put a shortcut on the Desktop", default on. The
warning is this, and it is the same string everywhere:

> The installed file has to stay where you put it. Moving or deleting
> it breaks Connect and the memory hooks until you put the file back.
> The Desktop shortcut can be moved or deleted freely.

No folder picker. A page cannot open one. A PowerShell
`FolderBrowserDialog` would, and it would pop a window out of a
process that otherwise stays hidden. This program already refuses
that kind of surprise (`RESONANCE_MEMORY_NO_OPEN`, `windowsHide`).
The text field is the whole chooser.

Install copies the exe into the folder, writes the marker beside it,
and writes `~/.resonance-memory/install-home.json` with the path, the
version, and the shortcut path. That file is a note about the
program. It is not a memory. The database, the jsonl, the embeddings,
and the cabinet are never deleted by install or uninstall.

Then the configs we own are repointed, and only those:

- an existing `mcpServers["resonance-memory"]` entry (LM Studio,
  Claude Desktop). Other servers in the same file stay. A missing
  config is not created.
- the two memory hooks, matched the way the memory installer already
  matches them: `--recall-hook` / `recall-hook.js` / `.ps1`, and
  `--rebuild-on-write` / `rebuild-on-write.js` /
  `rebuild-on-memory-write.ps1`. Timeout and status message stay.
  Other hooks stay.

Invalid JSON is left alone, with a warning. A backup is a copy
(`file.bak`), not a rename. On Windows a rename onto an existing
`.bak` fails.

After a successful install the panel starts the installed exe and
exits. The installed exe opens its own panel. The old tab loses its
process. There is no way to retarget the tab that is already open.
Tests set `RESONANCE_MEMORY_NO_OPEN=1`, which skips that handoff. The
page then reloads its own status and shows "Already installed" /
"Open installed copy" instead. That is what the headless check below
saw, because it set the same flag.

Not now, on a first offer, writes `{ declined: true, warned: true }`
and the card stays hidden after that. The warning has been shown
once. Not now on an update only hides the card for that page. It
does not decline, and it does not skip a later newer version.

A spare copy of the same version does not install again. The card
offers "Open installed copy". A spare that is older than the
installed copy is refused (`newer_installed`). Nothing is downgraded.

A newer stray exe sees the installed one and offers to update in
place. A different folder on that update is refused
(`already_installed`). The path Connect and the hooks already have
does not change. The update text says to restart the AI app. The
process that already has the file mapped keeps the old image until
it is restarted. The new bytes are what the path names, for the next
launch.

Connect (`selfLaunch`) and the memory installer (`selfExe` /
`hookSpec`) both prefer that installed path when this process is the
packaged exe. From source they still launch `node` plus the script,
and an install record is ignored. Retargeting existing hooks happens
only from the packaged exe. From source, "already has a hook, not
adding another" is unchanged.

CLI, for the guide:

```
resonance-memory --install-app [--dir <folder>] [--no-shortcut]
resonance-memory --uninstall-app
```

`--uninstall-app` disconnects the MCP entry, removes the two hooks,
deletes the shortcut if it is ours, and deletes the installed file
when this process is not that file. Memories stay.
`uninstall.bat` beside a Windows install runs `--uninstall-app` and
then deletes the local exe, the `.old`, and the marker. A running
exe cannot delete itself. The bat runs it first, and deletes it
after the process has exited. Disconnect on the panel is still only
the unwiring. The page says so, and it still says "Does not delete
your memories."

## Where it lives, and why

Windows: `%LOCALAPPDATA%\Programs\Resonance Memory\resonance-memory.exe`.
Per-user, no admin. That is the usual place for a program installed
for one account. Program Files needs an administrator. The memory
directory does not.

macOS: `~/Applications/Resonance Memory/resonance-memory`. A folder,
not a bare file dropped into `~/Applications`, and not
`~/.resonance-memory/bin`. `~/Applications` is the per-user
Applications directory. The folder holds the exe, the marker, and
nothing else that looks like a database. This is not a `.app` bundle.
The thing we ship is one executable.

Linux: `~/.local/bin/resonance-memory`. That directory is the XDG
user bin, already on `PATH` for a normal desktop session, and it is
outside the memory directory. `~/.resonance-memory/bin` was the other
candidate. It was rejected because uninstall then sits in the same
tree as the database, and a later "delete this folder" is one
careless step from the memories.

The cost of the Linux choice: the marker
`resonance-memory.install.json` sits in `~/.local/bin` next to other
programs. A private directory such as `~/.local/opt/resonance-memory`
plus a symlink on `PATH` would keep that file out of the shared bin.
Not built. Easy to switch if the marker in `bin` is annoying.

The folder the user types has to be absolute, not a drive root, and
not the memory directory or anything inside it. A path that ends in
the exe name is treated as the folder above it.

## The Desktop thing is a shortcut

Samuel's "a copy placed to desktop" is a shortcut, not a second exe.
A second exe is another file that can be the one that goes stale, or
the one that gets deleted while the configs still point at the first.
A shortcut is the XP behaviour he described: the icon can move or
go away, and the program does not.

Windows: a `.lnk`, written by `WScript.Shell` in one hidden PowerShell
process. Not a hand-built `.lnk`. The COM object is the writer
Windows itself uses, and the test reads `TargetPath` back. A
hand-rolled shortcut file is shorter to call and easier to get
subtly wrong.

macOS: a symlink, not an alias. An alias needs Finder or AppleScript,
which is a visible hop from a background process. A symlink also
does the thing we want and an alias would not. An alias tries to
follow the file if someone moves it. We do not want the shortcut to
paper over a moved exe. The exe has to stay. A symlink breaks when
the target moves, which is the right signal. Moving or deleting the
symlink does nothing to the target.

Linux: `Resonance Memory.desktop` with
`X-Resonance-Memory=install-home`, `Terminal=false`, and the
executable bit set. Uninstall only removes a `.desktop` file that
carries that key, so a person's own launcher with the same name is
left alone.

## Updates and a file that is open

On Windows a running exe cannot be overwritten. It can be renamed.
The copy goes to `name.new`, the live file is renamed to `name.old`
(or `name.old-<time>` if `.old` itself is locked), then `.new` is
renamed onto the real name. The old image stays mapped in the
process that had it open. The next launch of that path is the new
file. A later launch of the installed exe deletes `.old` and `.new`
when the marker is beside it and the file is no longer locked.

If the rename of the live file fails, the new staging file is
removed and the installed file is untouched (`locked`). The message
says to close Claude, LM Studio, and Claude Code. If the live file
was renamed and the rename of `.new` onto the real name then fails,
the code renames the saved `.old` (including a timestamped one) back.
If that restore also fails, the original is left under the
timestamped name. That is the rare case. It is not papered over.

macOS and Linux rename the new file over the old directory entry.
The running process keeps the old inode. Same rule: restart to load
the new bytes. After the copy, both get mode `0755`. On macOS the
code also runs `xattr -d com.apple.quarantine`. Exit status 1, or
"No such xattr", counts as success (there was nothing to clear).
Any other failure is a warning on the install, not a reason to
delete the file. A copied download can carry the quarantine
attribute, and a binary that is quarantined will not start when
double-clicked until it is cleared.

## What was verified on this machine

This Windows machine. Nothing here was pointed at the real
`~/.claude`, the real LM Studio or Claude Desktop config, the real
Desktop, or `C:\Users\spamw\tools\resonance-memory\` (the exe this
session is being served from). Tests set `USERPROFILE`, `HOME`,
`LOCALAPPDATA`, `APPDATA`, and `RESONANCE_MEMORY_NO_OPEN=1` on each
child. The panel tests also set `RESONANCE_MEMORY_DESKTOP` and
`RESONANCE_MEMORY_CONFIGS_JSON` to a temp desktop and an empty
config list. `os.homedir()` follows `USERPROFILE`, but
`[Environment]::GetFolderPath('Desktop')` does not, so the known
folder is asked only when the panel is allowed to open a browser
and the env is the live process env.

Rename, on a scratch copy of `C:\Program Files\nodejs\node.exe`
named `scratch-node.exe` under `%TEMP%`. Not the Resonance Memory
binary. A second run confirmed it with `process.kill(pid, 0)`:

- overwriting the running file failed, `EBUSY`
- renaming it to `.old` succeeded, and the process was still alive
- copying a new file onto the original name succeeded
- deleting `.old` while that process was alive failed, `EPERM`
- `child.kill()` returned true; the process was gone about 200ms
  later (`signal` `SIGTERM`, `exitCode` null, which is normal for a
  signalled exit)
- `.old` deleted cleanly after that

So the update plan matches this machine. Cleanup of `.old` has to
wait until the process that had the file mapped has exited. The
test in `test.js` copies `process.execPath` the same way and checks
the same two facts (overwrite fails, rename does not kill it). Both
"deleted while running" and "deleted after exit" would have been
acceptable. This machine is the second one.

`node test.js`: 648 passed, 0 failed.
`node hooks/memory-system/test.js`: 35 passed, 0 failed.
`node eval/run.js`: 27/31, sqlite scorecard matches golden, no
regressions. The four failures are the known ones:
`adv-height-homonym` field on, and `field-rescue`,
`field-rescue-veg`, `field-rescue-heights` field off.
`node build-exe.js`, then `node ci/smoke-exe.js dist/resonance-memory.exe`:
`resonance-memory` 0.3.1, tools exactly
`delete_memory`, `edit_memory`, `recall_memory`, `save_memory`.
`dist/` is gitignored. The build's "signature seems corrupted" line
is postject injecting into `node.exe` on Windows. It is not a macOS
codesign result.

Headless Chrome (a temp profile, not the signed-in one) loaded the
panel against a temp home with the test seam
(`RESONANCE_MEMORY_NO_OPEN=1`, `RESONANCE_MEMORY_ASSUME_SEA=1`, and
`RESONANCE_MEMORY_INSTALL_SOURCE` pointing at a fake file). The seam
cannot fire on a real double-click, because a real launch does not
set `NO_OPEN`.

The card was visible. Title, warning, default folder under that temp
`LOCALAPPDATA`, shortcut checkbox on. Install was one line at a
1280-wide window and at a 390-wide one (`white-space: nowrap`,
button height 36px both times). Clicking Install wrote the fake
bytes into the temp folder, wrote the `.lnk` on the temp Desktop,
left the sentinel database as `MEMORIES-STAY`, and the page changed
to "Already installed" / "Open installed copy" with the message that
Connect and the hooks now point at that copy. It did not relaunch,
because `NO_OPEN` was set. A production install would exit this
process and start the installed exe, which opens its own panel.

## What CI still has to prove

This machine is Windows. macOS and Linux were not run.

macOS CI, on a downloaded binary that actually has
`com.apple.quarantine`:

- the installed copy is mode `0755`
- `xattr -d com.apple.quarantine` clears it
- the same command on a file that has no such attribute exits 1 or
  says "No such xattr", and the install still succeeds
- an ad-hoc signature (`codesign -s -`) still verifies after the
  copy, or it does not, and the notes say which. Copying a Mach-O
  usually keeps the signature. Quarantine removal should not strip
  it. That is the claim to prove, not something verified here.

Linux CI:

- the installed file is mode `0755`
- the `.desktop` file is mode `0755`, `Exec` is the installed path,
  and `X-Resonance-Memory=install-home` is how uninstall recognises
  it

Neither of those is a reason to block this branch. The code paths
are the ones above, and they are untested on those kernels.

## Open questions

The known-folder Desktop (OneDrive redirection included) is only
asked on a real launch. It was not aimed at the real Desktop here,
on purpose. A machine whose Desktop is the OneDrive one will get
that path. A test cannot see it without dropping `NO_OPEN`.

The handoff starts the installed exe and lets it open a new tab. The
old tab dies because the old process exits. There is no way to point
the already-open tab at the new process. If that flash is worse than
staying on the Downloads process, the handoff is the piece to drop.
The paths would still be right.

A lock that refuses even the rename (some antivirus filters do) comes
back as `locked` and leaves the old file in place. The scratch node
did not hit that. Claude Desktop holding the exe as an MCP server is
the case the rename is for, and a renamed node stayed alive, which
is the same kernel rule. It was not proved by attaching to the live
Claude or LM Studio. Those were left alone.

Linux marker-in-`~/.local/bin`, above. Not changed.
