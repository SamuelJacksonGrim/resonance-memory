# Filing cabinet on the Resonance Memory record

Branch `feat/memory-cabinet`, worktree `C:\Users\spamw\Desktop\rm-wt-cabinet`.
Not pushed. `hooks/` and `CABINET.md` were not touched (those are the
parallel Claude Code branch). README and CHANGELOG edits are one bullet
each, under Unreleased / "What it can actually do", so they stay easy to
merge. `package.json` version was not bumped.

The cabinet was not opened in a browser, desktop or mobile. This session
has no browser tool. Panel coverage is the existing HTTP child
(`GET`/`POST /api/cabinet`) plus source checks that the client builds the
tree with `textContent` and does not inject `${` or backticks into the
page template.

## What shipped

RM still stores short facts as rows. The cabinet is three fields on the
row, not directories.

- `drawer` — subject path (`people`, `projects/towerdef`). Empty is
  unfiled. `inbox` is the catch-all, not "the baseline."
- `pinned` — the front. Who the user is and how they want to be treated.
  Recall prints these in their own section, created order, and removes
  them from the ranked pool so they cannot take a top-k slot or move a
  cosine result.
- `status` — `active` / `paused` / `shelved` / `done`. A label. The only
  default filter is `shelved` (out of ordinary recall until
  `include_shelved` or `status`). `paused` and `done` stay eligible.

No visibility column. History is still `valid_to` / `superseded_by`.
Deleted rows stay out of the tree.

`normalize()` in `record.js` backfills every new field on read
(`drawer ""`, `pinned false`, `status "active"`). An illegal drawer or
status fails open. A JSONL read does not rewrite the file. Writable
SQLite `ALTER TABLE ... ADD COLUMN` with a constant default, same shape
as the other late columns, so an already-created `.db` loads. A
read-only open (export) does not `ALTER`; `normalize()` fills the gaps.

Default drawers are a constant, not dummy memory rows: `people`,
`preferences`, `projects`, `tools`, `reference`, `inbox`. An empty
install shows them. Children appear when a fact is filed there. Depth
cap 3. Segment grammar is lowercase `[a-z0-9][a-z0-9_-]{0,40}`. Reserved
segments: `history`, `pinned`, `deleted`, `unfiled`, `cabinet`.

Assignment runs only when a **new** row is saved. Order:

1. Explicit drawer, including `""` (leave unfiled on purpose). A
   non-empty path that fails the grammar is not stored; assignment
   continues. Remembering the fact must not fail because the path was bad.
2. Unambiguous entity-id vote against current, non-pinned, non-inbox
   donors (sole drawer, or winner at least 2× the runner-up). An
   ambiguous vote does **not** then force `people`.
3. `people`, only when the text has a family / friend / work relation
   and the vote was not ambiguous. A bare name is not enough.
4. Nearest donor cosine at least `ASSIGN_MIN_COS` (0.72).
5. Else `inbox`.

Auto-assign never sets or clears `pinned`, and never rewrites an
existing row. A correction copies the retired row's drawer and pin, and
copies `shelved`. `paused` and `done` do not carry; the new row is
`active` unless this save set a status. A restatement
(`confirmRestatement`) does not auto-move or unpin. An explicit bad
drawer or status on that path returns the error and leaves the row.
Merge when the incoming text wins inherits the same way. Merge when the
existing text wins does not touch its cabinet fields.

Edit and the panel share `cabinetPatch`. Metadata-only edit does not
re-embed and does not bump `embedding_version`. Illegal drawer:
"That drawer path is not usable. Use a subject like people or
projects/towerdef." Illegal status: "Status must be active, paused,
shelved, or done." A metadata-only edit answers `Filed memory <id>.`
Empty `content` with no filing keys is still "Provide the new
`content`."

Still four MCP verbs. `save_memory` may take `drawer` and `pinned`.
`recall_memory` may take `status` and `include_shelved`. `edit_memory`
may take `drawer`, `pinned`, and `status`, and `content` is no longer
required when only filing changes. `callTool` forwards a drawer only
when it is a non-empty string, so a null drawer cannot unfile.
`save_memory`'s advertised schema does **not** include `status`. The
core still accepts it if a caller passes it. Status is a "put this
away / label it" act, which is an edit; advertising it on save would
let a first write hide the fact. See the decision list.

Recall, when at least one visible current pin exists:

```
Pinned (always in view, not ranked):
- [id N] text

1. [id …] …
```

An empty pin section adds zero bytes, so the golden recall strings do
not move. Drawer names and status labels are not printed on ranked
lines. Ranking stays cosine only (I2). Pins are not access-bumped for
being in the section.

A shelved pin is **not** kept in that section. `formatPinSection` uses
the same status filter as the pool. Otherwise shelve cannot put a pin
away. The shelved pin also stays out of the numbered list, so it does
not fall into cosine rank. If the only current row is a shelved pin,
recall says the shelved-filing hint rather than "Nothing current
matches."

The panel section is open by default (`#cabinetSec`), not a buried
`<details>`. Tree: pin / unpin, status, move to an existing drawer or
type `projects/name`. Pins are listed under Pinned only; the drawer is
still stored, so unpin lands there. History is a collapsed, display-only
group. Scroll cap 360px. `POST /api/cabinet` is metadata only and needs
the existing CSRF token. The memory-count line on the page does not
refresh after a cabinet POST (filing does not add or delete rows).

`--export` still writes the date-folder JSON, `memories.jsonl`, and
`catalog.txt` (`schema_version` stays 1, catalog status stays
current/superseded/deleted). It additionally writes:

- `cabinet/INDEX.md` — default drawers even at count 0
- `cabinet/pinned/<id>-<slug>.md`
- `cabinet/<drawer-or-unfiled>/…`
- `cabinet/history/<drawer>/…` for superseded rows

Frontmatter: `id`, `drawer`, `pinned`, `status`, `created`, `valid_to`,
then the text. Deleted rows stay in `memories.jsonl` and the date JSON
only. There is no import path for the markdown tree; import already
runs `normalize()`, so the JSONL fields round-trip. Slug is local to
`cabinet.js` (export must not be required from cabinet — cycle).
Non-ASCII is stripped from the filename; the body keeps the text.
Windows device names (`con`, `prn`, `nul`, `comN`, `lptN`) become
`<id>.md`.

First-run copy is unchanged: "Nothing saved yet", "Copy a starter
prompt", "Connected, but nothing saved yet", "remember that". The
cabinet card is what a fresh install shows instead of a folder setup.

## Why these calls

- **Metadata, not files.** RM's one schema is `normalize()`. A directory
  tree inside the store would be a second source of truth and a
  migration.
- **No fifth verb.** `ci/smoke-exe.js` asserts exactly the four names.
  Optional args on the verbs that already exist are the compromise.
  The server still owns embeddings, importance, and timestamps.
- **On by default.** No flag. An empty store shows the drawers. Recall
  grows a pin section only when a pin exists, so the default path is
  the old string until someone pins.
- **Pins restrain automation; they are not a sign-off.** Nothing asks
  the user to approve a move. Auto-assign also refuses to touch a pin
  or any existing row. The model is told (tool text and system-prompt
  item 4) not to unpin unless the user is changing that fact, and not
  to ask permission to file.
- **No visibility field.** Pinned, shelved, and superseded already cover
  the axes. A fourth label invents combinations (pinned + history) and
  a migration of meaning. History already exists.
- **Do not auto-pin `is_constraint`.** A constraint is not "who the user
  is." Pinning it would put it on every recall and change what the
  model sees outside the golden ranking. The user (or the model, when
  the fact really is identity) sets the pin.
- **0.72, not the merge band.** Nearest-drawer sits above the 0.70
  recall floor and below the ~0.88 merge band. Below 0.72, inbox is
  more honest than a guess. A fact that is actually a near-duplicate
  restates or merges; it is not "filed" as a second row.
- **Shelved pins leave the front.** Called out because it disagrees
  with a literal reading of "pinned comes back with every recall."
  Shelve has to mean something on the front, or the user cannot put a
  pin away without unpinning it. `paused` and `done` stay in the
  section: the fact is still one they asked to see.

## Gate

`node test.js` (this worktree, after the cabinet tests, exit 0). Ending:

```
filing cabinet (assignment, pin section, status — rank stays cosine)
  ok   pinned memories are their own section and do not take a ranked slot
  ok   a store with no pins keeps the old recall shape
  ok   drawer and status label or filter; they do not reorder cosine
  ok   a shelved pin leaves the pin section until recall asks
  ok   save files an explicit drawer, else entity, else nearest, else inbox
  ok   corrections keep filing; a restatement and an unrelated save do not move a pin
  ok   a near-duplicate keeps filing only when the new wording wins
  ok   a metadata edit files without re-embedding, and a bad drawer is refused

RM-11 CI smoke (live --mcp + hang guard)
  ok   failure: a silent child is killed by the smoke timeout (must not hang CI)
  ok   failure: missing binary fails closed
  ok   smoke: node entry.js --mcp returns serverInfo + exactly four verbs

645 passed, 0 failed
```

Earlier schema / panel / export cases in the same run, all ok: normalize
backfill and idempotence, JSONL missing keys do not rewrite the file,
writable SQLite adds the columns and read-only does not, empty
`GET /api/cabinet` lists the defaults, POST pin/move/status does not
re-embed, export zip adds the markdown tree and keeps the date layout
(deleted slug is absent from `/cabinet/` only).

`node eval/run.js` (default store, sqlite), 2026-10-12T03:21:56Z, exit 0:

```
TOTAL: 27/31 checks passed

SqliteStore scorecard matches golden case-for-case.
No regressions vs golden.
```

The four FAILs are the golden ones: `adv-height-homonym [field:on]`,
`field-rescue [field:off]`, `field-rescue-veg [field:off]`,
`field-rescue-heights [field:off]`. No case flipped.

`node eval/run.js --store jsonl`, 2026-10-12T03:22:40Z, exit 0:

```
TOTAL: 27/31 checks passed

No regressions vs golden.
```

No `IMPROVED since golden` line, so the JSONL scorecard did not move
either. The empty pin section is what keeps recall byte-identical on a
store with no pins, which is every golden case.

Line endings on the touched sources are LF (no CR).

## Unsure

- Entity votes depend on `entity.js`. The tests cover one unambiguous
  "Naima" vote into `projects/lab` and one split vote that stays
  `inbox`. Real names and nicknames will mis-file sometimes. Inbox is
  the recovery, and the panel can move the row. I have not watched this
  on a real store.
- `people` as the relation-class fallback will over-file some sentences
  that mention a sister or a coworker but are really about a project.
  The ambiguous-vote guard stops the worst case (split donors). It does
  not stop a single relation cue with no donors.
- Nearest-drawer and the merge band are close. `unit2(0.75)` against a
  unit donor is cosine 0.75 (files). `unit2(0.5)` against `unit2(0.75)`
  is ~0.95 and **merges** instead of filing. Assignment tests have to
  keep every vector in that core outside the merge band of every other
  current vector, not only under 0.72 of the donor. A production fact
  that is a near-duplicate never receives its own drawer; it inherits
  or leaves the survivor alone, which is what we want, but it means
  "why did this land in inbox" sometimes means "it merged."
- Export filenames drop anything outside `[a-z0-9._-]`. A CJK-only
  memory exports as `<id>.md`. The body is intact. A user browsing the
  zip by filename will not see the words.
- The panel memory count stays stale after a pin/move/status until the
  next full reload. I left it, because a cabinet POST does not change
  the count. It will look wrong if someone is watching that number.
- Controls wrap inside the existing card. I did not look at that wrap
  on a narrow window.
- `cabinet/INDEX.md` lists default drawers at count 0, including on an
  old store that has never used them. That is the "fresh install"
  promise applied to export. It also means an export of a pre-cabinet
  store grows six empty drawers the user never chose.

## For Samuel to decide

1. **Shelved pins leave the always-in-view section.** I think shelve
   has to work on the front. If you want a pin to survive shelve, say
   so and the filter comes off `formatPinSection` only (the ranked pool
   should still exclude pins).
2. **`status` is on `edit_memory`, not on the `save_memory` schema.**
   The core accepts it on save. If you want the model to shelve or mark
   done in the same breath as the first write, add the property next to
   `drawer` / `pinned` in `server.js` `TOOLS`. I would not.
3. **Illegal drawer on save falls through; on edit it refuses.** Save
   must not drop the fact. Edit must not unfile on a typo. If you want
   save to refuse too, the model has to retry or the fact is lost for
   that call.
4. **No markdown-tree import.** Sovereignty here is "you can read the
   folders." Round-trip is still `memories.jsonl`. A second import path
   would have to decide what wins when the markdown and the JSONL
   disagree. I would not build it until someone edits the markdown and
   wants it back.
5. **Default drawer set** is generic (`people`, `preferences`,
   `projects`, `tools`, `reference`, `inbox`), not your project names.
   Children are born by naming them. If `reference` or `preferences` is
   the wrong cut for other users, change `DEFAULT_DRAWERS` before this
   ships in an `.exe` — empty drawers are cheap to show and annoying to
   rename later only because INDEX.md and the panel both advertise them.
6. **Look at the panel.** HTTP tests do not show whether the tree, the
   wrap, or the 360px scroll is actually usable. I would open a fresh
   store and one with a pin before the PR merges.
