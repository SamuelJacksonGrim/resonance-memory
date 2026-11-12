# Known bugs and defects

Found defects, what they cost, and whether they're fixed. Numbered in the order found, grouped
so related ones read together — check the status line on each rather than the position. A bug
leaves this list only when it is *fixed*, not when it is understood; if it's understood but
unfixed, it stays here with an owner in the backlog.

BUG-005 signing remains open; W-03/W-04 record unresolved scaling/concurrency exposure.
Use the individual status lines rather than a copied count. The fixed-defect narratives below
are history from the work included in 0.2.0 (2026-09-10), not new defects on the docs branch.

**Severity:** `critical` data loss / corruption · `high` user-visible breakage ·
`medium` degradation at scale · `low` cosmetic

---

## `BUG-001` — Non-atomic store writes could truncate the entire memory file
**Severity:** critical · **Status:** ✅ **fixed** · **Found:** July 2026

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

**Regression evidence:** `test.js` → "durable writes", including complete/parseable large writes.
Run `npm test` for current results. Release provenance: [0.2.0](../CHANGELOG.md#020---2026-09-10).

---

## `BUG-002` — Every recall rewrote the entire store file
**Severity:** critical (with `BUG-001`) / high alone · **Status:** ✅ **fixed**

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

**JSONL steady-state recall does not rewrite the memory file**; retention updates use its
AccessLog sidecar. **SQLite recall updates retention columns in a bounded transaction.**
Legacy/outage vector backfill is the separate named I4/I5 exception, including a full JSONL
rewrite when needed; [ARCHITECTURE §2](ARCHITECTURE.md#2-design-invariants-the-shape-is-load-bearing)
owns that limitation. Release provenance: [0.2.0](../CHANGELOG.md#020---2026-09-10).

Losing the tail of the sidecar to a crash costs a few access counts — which govern nothing
that affects an answer. That is the correct thing to make cheap.

**Tests:** `test.js` → "recall does NOT rewrite the store" asserts the store bytes *and*
mtime are unchanged across `applyRecall`, while the access bump still lands.
**SQLite (RM-07):** the analogue is not "file mtime unchanged" — a bounded in-table
`UPDATE` of the returned ids is the I5-permitted retention write. The test is:
after recall, only retention columns changed on those rows, row count unchanged,
no other column touched.

### Backend scope

The full-file parsing/rewrite limitation remains specific to JsonlStore. RM-07 storage work
is complete; SQLite is the default. Current backend selection and migration behavior live in
[ARCHITECTURE §6](ARCHITECTURE.md#6-storage-and-the-sidecars). Remaining field graph scaling is W-03.

---

## `BUG-003` — `HISTORICAL_RE` missed "previous"
**Severity:** low · **Status:** ✅ **fixed** · **Found:** by its own test

The historical-query regex matched `previously` but not `previous`, so "what was my previous
address" was treated as a present-tense question and superseded memories were filtered out of
a query explicitly asking for them. Caught by `test.js` on first run — which is the argument
for `RM-00` in miniature.

---

## `BUG-004` — Store path defaults to `~/.lmstudio/` even for Claude-only users
**Severity:** low · **Status:** ✅ **fixed** · **Owner:** `RM-11`

A user who only runs Claude Desktop got their memories in a directory named for a product
they don't have installed. Cosmetic, but the fix touches user data, so the mover is the
load-bearing part.

### Fix
The default location is RM-owned and legacy-location migration preserves user data.
`store.js` owns the resolver/mover; [ARCHITECTURE storage](ARCHITECTURE.md#6-storage-and-the-sidecars)
owns the current path, copy/verify/fail-open behavior and overrides.

**Tests:** `test.js` → "BUG-004 default store location + legacy ~/.lmstudio/ relocate".

---

## `BUG-005` — Unsigned binary trips SmartScreen / Gatekeeper
**Severity:** medium (adoption, not correctness) · **Status:** 🔲 open · **Owner:** `RM-11`

First launch shows a scary OS warning. For a product whose core pitch is "trust this with your
private memories," an "unknown publisher" dialog is a real adoption tax. The RM-11 release
matrix ships unsigned binaries. RM-20 first-run guidance is complete as scoped; it cannot
silence the OS warning. [BUILDING](guides/BUILDING.md) and the user entry guides own the
platform click-path. Signing/notarization is the open remainder of RM-11.

---

## `BUG-007` — Access counts doubled on every store mutation
**Severity:** high (silent data corruption) · **Status:** ✅ **fixed** · **Introduced by:** the
`BUG-002` fix before the 0.2.0 release

### What
`all()` folds sidecar counts onto records. `_writeAll()` then persisted those *folded* values
into the store — while the sidecar kept its own copy. The next read added them again.

```
2 recalls        -> access_count 2   ✓
   ...one edit   -> access_count 4   ✗
   ...another    -> access_count 6   ✗
```

It compounds without bound, and every `update()` / `delete()` / `vacuum()` triggers it.

### Why it mattered
History: the access-derived importance proposal made this latent corruption look like a future
retention hazard. A frequently edited memory appeared more important without any user intent.
Current I2b forbids access-frequency input to decay/pruning; RM-08 must resolve its older
access-refreshed retention proposal before implementation. Corrupt telemetry is still wrong,
but no shipped record-pruning consumer is claimed here.

### Fix
`AccessLog.consolidate()` — after a full rewrite persists the folded totals, clear the
sidecar. A rewrite is the natural checkpoint: the store file becomes the authority, the
sidecar restarts from zero. Regression evidence is in `test.js` under access-count consolidation.

### How it was found
**Adversarial audit prompted by the reviewer**, not by the tests. The original test suite
covered "recall does not rewrite the store" and "sidecar round-trips" — but never *recall
followed by a mutation*. The bug lived exactly in the seam between two things that were each
tested in isolation.

> **Lesson worth keeping:** a fix for a real bug can introduce a worse one. `BUG-002` was
> genuine and the sidecar is still the right design — but "the old code was wrong" does not
> establish that the new code is right, and my tests were written to confirm the fix rather
> than to attack it.

---

## `BUG-008` — `edit()` destroyed the embedding whenever the embedder was down
**Severity:** critical (silent data loss; recoverable only by re-editing, which nothing prompts) · **Status:** ✅ **fixed** · **Found by:**
roadmap consolidation review, reading `edit()` to answer a schema question

### What
`edit()` set `embedding = null` when the embedder threw, then passed that straight into
`store.update()` — which does `Object.assign(record, patch)`. The null overwrote a perfectly
good vector.

```
good vector -> embedder down -> edit() -> embedding: null -> Object.assign -> vector gone
```

The memory silently dropped to keyword-fallback ranking until someone happened to edit it again, `edit()`
returned `"Edited memory N."` as though nothing had happened, and nothing anywhere surfaced the
degradation. An embedder outage lasts minutes; the damage outlived it indefinitely.

### Why it mattered more than it looked
Same shape as `BUG-007`: a patch path silently overwriting good state through `Object.assign`, with no error raised and nothing checking afterward.
It also breaks a rule the design depends on — a *failed* embed was indistinguishable from a
legitimate embedding change. `ROADMAP.md` Phase 0.0 keys semantic-cache validity on
`embedding_version`, so under that scheme this bug would have had a failed embed masquerading as
a real mutation and silently invalidating every incident edge.

### Fix
Omit `embedding` from the patch entirely when embedding fails, so the null can never reach
`Object.assign`, and report the degraded state to the caller. The edit still applies in full;
only the vector is left behind. A stale vector beats no vector: the record still ranks
semantically, and the next successful edit repairs it.

Guarded by `test.js` (`edit() embedding safety`), including a case asserting a
*successful* re-embed still replaces the vector — so the fix can't regress into never updating
embeddings at all. Verified failing before the fix, passing after.

---

## `BUG-001` addendum — the durability fix has a measured cost

**Historical measurement — before the 0.2.0 release (2026-09-10):** a JSONL rewrite benchmark,
not a current SQLite mutation or general recall-latency measurement.

```
20 × rewrite of a 5.9 MB store:  plain 138ms | durable 494ms  (3.58×)
```

`fsync` is the expensive part, and that is the point of it — the guarantee is that the bytes
are on disk before anything references them, subject to the unsupported-fsync caveat above.
The measured full-file cost applies to JSONL mutations and the legacy/outage recall-backfill
exception, not ordinary steady-state recall. RM-07 incremental SQLite writes are shipped;
[ARCHITECTURE storage](ARCHITECTURE.md#6-storage-and-the-sidecars) owns current durability.

---

## `BUG-006` — Design docs asserted system behaviour without re-checking the code
**Severity:** high (misleads every future decision) · **Status:** ✅ **audited and fixed**

### What
Several design documents made confident claims about how the system currently behaves that
were either **never verified against the source**, or were **true when written and silently
falsified by later commits in the same session**. Found by audit after a reviewer challenged
one of them and it collapsed.

Two distinct failure modes, both worth naming:

**(a) Reasoned from a mental model instead of the code.** `0006`'s problem statement was
rewritten three times, each draft arguing that constraints can't surface — while
`server.js: recallMemory()` already implements a `Related:` channel (four extra slots reached
by association, not competing with the ranked five), applies the Hebbian bonus *before* the
`minSim` gate, and reinforces the edge on every co-recall so the path strengthens with use.
The mechanism the document proposed building was already built, and the built version learns.
The files had been read earlier in the same session; reading is not checking.

**(b) Shipped a change, left the docs describing the old state.** Six claims went stale this
way, every one of them from work on that implementation branch before 0.2.0:

| Doc | Claim | Reality |
|---|---|---|
| `0001` | "`saveMemory()` today is: trim → embed → append" | also confirms exact restatements (`RM-04`) |
| `0002` | "the store has no concept of when a fact was true" | temporal schema shipped |
| `0005` | "every recall rewrites the entire store" | fixed — sidecar, zero writes on read |
| `0005` | "kill-9 leaves an unreadable store" | fixed — atomic writes |
| `COMPETITIVE-ANALYSIS` | temporal metadata ❌ | ✅ shipped |
| `COMPETITIVE-ANALYSIS` | deduplication ❌ | ✅ cosine-banded at save (RM-02.b) + `--dedup-existing` backfill (RM-02.c) |

### Why it matters more than a typo
Every one of these feeds a build decision. `0006` alone would have had someone implement a
static domain model to replace a dynamic one that already exists and is better. A stale
capability matrix distorts the roadmap it was written to justify.

### Ongoing workflow

The current [development/documentation rules](../CONTRIBUTING.md#development-and-documentation)
own this lesson. Preserve the past-tense incident and old function names above as historical
evidence; they are not a second description of the live call graph.

---

## Watch list — unresolved defects and risks

| ID | Status / exposure | Owner and evidence |
|---|---|---|
| W-01 | Dismissed: same-millisecond id allocation is monotonic. | `test.js` rapid-save/id tests. |
| W-02 | Fixed: panel Host/Origin and mutating-request token protection. A local process that reads the page can obtain its token. | Current contract: [ARCHITECTURE §11](ARCHITECTURE.md#11-configuration-surface); regression tests: `test.js`, W-02. RM-12 stable API remains open. |
| W-03 | Confirmed scaling defect: field-on recall still constructs all-pairs kNN. | RM-05 owns graph-scaling follow-up. The **2026-09-05 S1** field-on measurements are p95 90.8 s at N=10k and 724 ms at N=1k; [results](../eval/RESULTS.md) own the dated curve. SQLite storage does not remove graph construction cost. |
| W-04 | Current concurrency risk: the panel already imports/merges into the live store while an MCP process can be running. No concurrent-writer stress result establishes safety. | JSONL has competing whole-file/sidecar writers. SQLite has transactional writes but independent in-process memory/edge snapshots; transaction atomicity does not establish cache coherence. `panel.js` POST `/api/import`, `store-sqlite.js` cache, `edges.js` persistence. Needs a backend-specific concurrent-writer test and a lock/coherence/single-writer decision. MCP request-ID retry dedup is orthogonal and does not serialize processes. |

---

## Conventions

[CONTRIBUTING](../CONTRIBUTING.md#development-and-documentation) owns the ongoing fix/test workflow.
Both-backend conformance tests are implemented (`test.js` Store conformance and shared-core
sections); they are not merely planned in proposed/0005. Run the [developer checks](../DEVELOPERS.md#checks).
An unresolved defect stays here with an owner, even when its mechanism is understood.

---

## Related

[[ARCHITECTURE]] · [[BACKLOG]] · [[ROADMAP]] · [[phase-0-edge-substrate]] · [[DEVELOPERS]]
