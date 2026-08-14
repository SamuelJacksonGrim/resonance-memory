# Handoff — local build and verification

> **Just need something to paste to an agent?** Use
> [`HANDOFF-BRIEF.md`](HANDOFF-BRIEF.md) — the short, self-contained version. This document
> is the detailed reference behind it.

For whoever picks this up on Samuel's machine with a real GPU and admin rights. Everything
below was written in a sandbox **without** a GPU, without LM Studio, and without the ability
to run the full SEA build. That means a specific set of things are *verified* and a specific
set are *unverified* — this document is mostly about telling those two apart honestly.

---

## What is already verified (and how)

| Claim | How it was checked |
|---|---|
| The whole test suite passes | `npm test` |
| Every source file parses | `node --check` on each |
| esbuild bundle builds and runs | bundled `entry.js`, ran it as `--mcp`, exercised all four verbs |
| Bundle carries exactly one AGPL notice | counted notices before/after the strip in `build-exe.js` |
| `record.js` + `store.js` are bundled | grepped the module list in the output bundle |
| Temporal recall works end-to-end | live stdio server: present-tense query excluded a superseded fact; historical query returned it labelled |
| Restatement confirms instead of duplicating | live server, saved the same text twice, got one record |
| Recall performs no store writes | test asserts store bytes **and** mtime unchanged across `applyRecall` |
| Legacy stores need no migration | test loads a `ts`-only record and a bare `created` record |
| Panel serves the 3D graph | booted it, fetched `/api/graph`, got 24 demo nodes / 45 edges with `current` flags |

## What is NOT verified — please check these first

1. **The full SEA build** (`npm run build`). I ran steps 0–1 (asset embed + esbuild) but not
   the Node SEA blob → `postject` → PE-subsystem flip. Those need the platform Node binary and
   were out of reach in the sandbox. **This is the single most important thing to run.**
2. **Anything involving a real embedder.** No LM Studio, so every recall I exercised fell back
   to keyword matching. Cosine ranking, the associative field, and the Hebbian ledger are all
   unexercised against real 768-dim vectors in this round.
3. **The 3D graph visually.** The physics is validated numerically (see below) but nobody has
   *looked* at it.
4. **Windows specifics** — the PE subsystem flip, SmartScreen behaviour, `uninstall.bat`.

---

## Run this first

```bash
node --version          # need 18+; 22+ unlocks node:sqlite (see "RM-07" below)
npm test                # dependency-free, <1s — every test should pass
npm run build           # the unverified one — SEA + postject + dist/
```

Then the real check, with LM Studio running and the embedding model loaded:

```bash
npm run panel           # opens 127.0.0.1:9090
```

- Does "Meaning engine" say **ready**?
- Click **Show demo graph** — 24 nodes should settle into a rotating 3D cloud. Drag to rotate.
- Save a few memories through a connected client, then confirm the graph re-settles **only**
  when a memory is added, not on a timer. (The old every-8s bounce is what this replaced.)

### The temporal behaviour is worth exercising by hand

```
save_memory   "I work at Acme"
save_memory   "I work at Acme"          -> should CONFIRM, not duplicate
recall_memory "where do I work"         -> Acme
```

Then mark it superseded (until `RM-03` lands there's no automatic detection — that's the point
of `RM-03`):

```js
const { normalize, supersedePatches } = require("./record.js");
const { JsonlStore } = require("./store.js");
const s = new JsonlStore(process.env.MEMORY_FILE_PATH);
const old = s.all().find(r => r.text.includes("Acme"));
const now = new Date().toISOString();
s.add(normalize({ id: 999, text: "I work at Globex", created: now, valid_from: now }));
const p = supersedePatches(old, s.get(999), now);
s.updateMany({ [String(old.id)]: p.old, "999": p.new });
```

```
recall_memory "where do I work"            -> Globex only
recall_memory "where did I used to work"   -> both, Acme marked "no longer current"
```

In the panel, the Acme node should now render **dimmed**, and the counter should read
"… , 1 superseded".

---

## Things this machine unlocks that the sandbox could not

The specs matter for *which backlog items are now testable*, not just for speed.

**16 GB VRAM.** Enough to hold the embedding model **and** a 7–14B instruct model resident at
the same time. That makes the optional LLM tiers genuinely evaluable rather than theoretical:

- **`proposed/0001` Tier 2** — the single-pass extraction prompt. The sanity gate in that
  design (reject the extraction if it's longer than the input or echoes the prompt) was
  written blind, assuming a small flaky model. With a 14B model it may be far too strict.
  **Measure it, then loosen it.**
- **`proposed/0002` Tier 2** — contradiction adjudication for the uncertain 0.4–0.7 band.

Please keep both **off by default** regardless of how well they perform here. A 4070 Ti is not
the target machine; the person on a laptop with no GPU is, and the tiered design exists so
they get a working product anyway.

**128 GB RAM + 2 TB storage.** The `RM-15` soak test (1,000+ updates) and a 100k-memory
`store_growth` run are both comfortable. Those are the numbers that would actually tell us
where the JSONL backend gives out — my "~10k memories" ceiling in `BUGS.md` is an estimate
from reading the code, **not a measurement**. Replacing it with a real number would be a
genuinely useful contribution.

**Node 22 is installed** — I confirmed `node:sqlite` is available (`DatabaseSync`,
`StatementSync`, `backup`). That resolves the open question in `proposed/0005 §"Dependency
question"`: **option 1 is viable**, so `RM-07` can use built-in SQLite with no native module
and no threat to the single-file SEA build. The remaining unknown is whether the `sqlite-vec`
extension loads inside a SEA context; the doc has a documented fallback if it doesn't.

**Full admin.** Code signing (`RM-11`, `BUG-005`) is the one adoption blocker that needs a
certificate rather than code. Unsigned binaries trip SmartScreen, which is a bad first
impression for a product asking to hold private memories.

---

## Where to start, if you want to build rather than verify

Straight from [`BACKLOG.md`](BACKLOG.md), in order:

1. **`RM-00`** — the eval harness ([`proposed/0007`](proposed/0007-eval-harness.md)). Nothing
   else should merge before it. `RM-03`'s detection logic in particular is exactly the kind of
   change that can quietly make recall worse, and there is currently no way to notice.
2. **`RM-03`** — supersession *detection*. All the plumbing is done and tested
   (`supersedePatches`, `updateMany`, the filtered recall paths); what's missing is only the
   decision of *when* to call it. [`proposed/0002 §Detection`](proposed/0002-temporal-supersession.md)
   has the scoring function.
3. **`RM-02`** — near-duplicate merge. Exact-match dedup already ships; the cosine-banded case
   is what's left.

## House rules worth not violating

- **Four verbs.** If something seems to need a fifth MCP tool, the design is wrong — capability
  goes in the substrate.
- **All store writes go through `writeFileDurable()`.** Plain `fs.writeFileSync` on a live data
  file can truncate the user's entire memory (`BUG-001`).
- **Nothing on a read path writes to the store** (`BUG-002`).
- **No unmeasured signal touches ranking.** See the invariant fight in
  [`proposed/0003 §5`](proposed/0003-hybrid-retrieval.md) — hybrid retrieval ships flag-off
  until an A/B win justifies it.
- **`node test.js` before pushing.**

## Known open issues

[`BUGS.md`](BUGS.md) — five fixed, **two open** (`BUG-004` store path names LM Studio for
Claude-only users; `BUG-005` unsigned binary), plus a three-item watch list. `W-02` (the panel
has no CSRF token or `Origin` check, so any local process — or a web page via DNS rebinding —
can drive its API) is the one worth settling before `RM-12` turns that into a documented API.

Two of the fixed ones are worth reading before you trust the prose here: **`BUG-006`** (design
docs asserted system behaviour that the code contradicted) and **`BUG-007`** (a fix that
introduced a worse bug than it solved, caught by review rather than by the test suite). The
code is tested; the documentation is the part that earned suspicion.
