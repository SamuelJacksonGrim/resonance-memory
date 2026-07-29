# Known bugs and defects

Found defects, what they cost, and whether they're fixed. Newest first. A bug leaves this
list only when it is *fixed*, not when it is understood — if it's understood but unfixed, it
stays here with an owner in the backlog.

**Severity:** `critical` data loss / corruption · `high` user-visible breakage ·
`medium` degradation at scale · `low` cosmetic

---

## `BUG-001` — Non-atomic store writes could truncate the entire memory file
**Severity:** critical · **Status:** ✅ **fixed** (this branch) · **Found:** July 2026

### What
`JsonlStore._writeAll()` replaced the live store with `fs.writeFileSync(this.file, data)`.
That is **not atomic**. `writeFileSync` opens with `O_TRUNC` — the file is emptied first, then
rewritten. A crash, power loss, OOM kill, or full disk between those two steps leaves a
truncated or empty store. **The user's entire memory, gone**, with no backup on that path.

The same pattern was in `Ledger.save()` (the Hebbian sidecar), where the cost was lower — a
corrupt ledger fails to parse and silently resets learned associations.

### Why it mattered
The exposure window opened on **every recall**, not just on writes — see `BUG-002`. A read
operation could destroy the store.

### Fix
`record.js: writeFileDurable()` — write to a temp file in the *same directory*, `fsync`, then
`rename()` over the target. Rename within a filesystem is atomic on POSIX and on Windows, so a
reader observes either the complete old file or the complete new one, never a partial write.

Same-directory placement is deliberate: `os.tmpdir()` is frequently a different mount, and
`rename()` across filesystems is not atomic (and fails outright on some platforms).

`fsync` is wrapped in a try/catch — some filesystems and network shares refuse it, and the
rename is still atomic without it. Failing the whole write because `fsync` is unsupported
would be worse than the durability gap it closes.

**Tests:** `test.js` → "durable writes" (6 tests), incl. a 5,000-record write verified
complete and parseable line-by-line.

---

## `BUG-002` — Every recall rewrote the entire store file
**Severity:** critical (with `BUG-001`) / high alone · **Status:** ✅ **fixed** (this branch)

### What
`applyRecall()` was called on **every** `recall_memory`, and it:

1. parsed the whole store into memory,
2. bumped `access_count` on the ~5 returned rows,
3. **rewrote the entire file.**

So a read did `O(store)` work and — combined with `BUG-001` — opened a whole-store data-loss
window. At 50k memories with 768-dim vectors that's tens of MB re-serialized per recall, plus
proportional SSD wear.

### Root cause
`access_count` / `last_access` are **retention** signals. The project's own ranking invariant
says they never influence retrieval order. Metadata that cannot affect the answer had been
placed on the critical path of producing the answer.

### Fix
Moved to a sidecar: `record.js: AccessLog`, persisted at `<store>.access.json`, folded onto
records at read time. Same pattern `ledger.js` already used for Hebbian weights.

**Recall now performs zero writes to the memory store in steady state.** The only remaining
store write on a read path is embedding backfill, which fires only for legacy rows or after an
embedder outage, and is now durable.

Losing the tail of the sidecar to a crash costs a few access counts — which govern nothing
that affects an answer. That is the correct thing to make cheap.

**Tests:** `test.js` → "recall does NOT rewrite the store" asserts the store bytes *and*
mtime are unchanged across `applyRecall`, while the access bump still lands.

### Still open (tracked, not a bandaid)
`all()` still parses the full store on every call, and mutations (`save`/`edit`/`delete`)
still rewrite the whole file. That is inherent to a flat JSONL backend and is the actual
subject of **`RM-07`** (SQLite + `sqlite-vec` + FTS5, design in
[`proposed/0005`](proposed/0005-store-abstraction.md)). It is a *performance* limit now, not a
correctness or data-loss one — the difference that matters. Current ceiling: comfortable to
~10k memories, degrading after that.

---

## `BUG-003` — `HISTORICAL_RE` missed "previous"
**Severity:** low · **Status:** ✅ **fixed** (this branch) · **Found:** by its own test

The historical-query regex matched `previously` but not `previous`, so "what was my previous
address" was treated as a present-tense question and superseded memories were filtered out of
a query explicitly asking for them. Caught by `test.js` on first run — which is the argument
for `RM-00` in miniature.

---

## `BUG-004` — Store path defaults to `~/.lmstudio/` even for Claude-only users
**Severity:** low · **Status:** 🔲 open · **Owner:** `RM-11`

A user who only runs Claude Desktop gets their memories in a directory named for a product
they don't have installed. Cosmetic, but confusing, and awkward to change later without a
migration. Already noted under "Known limitations" in the changelog.

---

## `BUG-005` — Unsigned binary trips SmartScreen / Gatekeeper
**Severity:** medium (adoption, not correctness) · **Status:** 🔲 open · **Owner:** `RM-11`

First launch shows a scary OS warning. For a product whose core pitch is "trust this with your
private memories," an "unknown publisher" dialog is a real adoption tax.

---

## Watch list — suspected, not yet confirmed

| | Concern | Next step |
|---|---|---|
| `W-01` | `nextId()` uses `Date.now()`; two saves in the same millisecond could collide | Write a test that hammers `saveMemory`; if it reproduces, add a counter suffix |
| `W-02` | Panel binds `127.0.0.1` with no CSRF token — any local process can drive the API | Assess before `RM-12` exposes it as a documented API |
| `W-03` | `field.buildEdges()` is O(n²) per recall when the field is on | Profile at 10k memories; likely needs an ANN index alongside `RM-07` |
| `W-04` | A concurrent panel + MCP server write could interleave (last-writer-wins) | Real risk once the panel gains write features; needs a lock or single-writer discipline |

---

## Conventions

- **Encode the bug as a test.** Every fix above ships with a test that fails without it, so no
  future backend reintroduces it (see the conformance suite planned in `proposed/0005`).
- **No bandaids.** If the correct fix is a rewrite, do the rewrite or write the bug down
  honestly with its real owner — don't wrap it in a mitigation that adds a layer without
  removing the failure.
