# Handoff brief (paste-able)

*A self-contained onboarding message for an agent or developer picking this repo up on a
fresh machine. Copy everything below the line and paste it in. The detailed reference —
verified vs unverified, exact commands, per-item context — lives in
[`HANDOFF.md`](HANDOFF.md); this is the short form that gets someone oriented and working.*

---

# Resonance Memory — handoff

You're picking up https://github.com/SamuelJacksonGrim/resonance-memory — work from the
tip of `main`. Recently landed: GPL-3.0 licensing, a 3D associative graph, the temporal
memory schema (`RM-04`), and fixes for two critical storage bugs. `CHANGELOG.md` has the
current state.

**Read `docs/HANDOFF.md` first.** It separates what's actually been verified from what
hasn't — the previous work was done in a sandbox with no GPU, no LM Studio, and no
ability to complete the SEA build. Don't re-verify what's already green; do verify what's
listed as unknown.

## Priority 1 — the build

```bash
node --version    # 22.x expected
npm test          # dependency-free, <1s — every test should pass
npm run build     # THE UNVERIFIED ONE
```

`npm run build` is the highest-priority check. Steps 0–1 (asset embed + esbuild bundle)
are confirmed working, but the Node SEA blob → `postject` → Windows PE-subsystem flip
were out of reach in the sandbox. If it fails, that's the most valuable thing you can
fix today. Expected output: a single self-contained `resonance-memory.exe` (~89 MB) and
a `dist/` containing only that exe.

## Priority 2 — with a real embedder

Everything so far has been exercised with the embedding endpoint *down*, so every recall
fell back to keyword matching. **Cosine ranking, the associative field, and the Hebbian
ledger are all unexercised against real 768-dim vectors.** Start LM Studio, load
`text-embedding-nomic-embed-text-v1.5`, then:

```bash
npm run panel     # 127.0.0.1:9090
```

- Does "Meaning engine" say **ready**?
- Click **Show demo graph** — 24 nodes should settle into a slowly rotating 3D cloud.
  Drag to rotate. Nobody has actually *looked* at this yet; the physics is only validated
  numerically.
- Save some memories via a connected client and confirm the cloud re-settles **only** when
  a memory is added — not on a timer. (An every-8-seconds bounce is what this replaced.)

The temporal behaviour is worth exercising by hand — `docs/HANDOFF.md` has a copy-paste
snippet for marking a memory superseded, since automatic detection (`RM-03`) isn't built yet.

## Trust the code more than the prose

`BUG-006` and `BUG-007` in [`BUGS.md`](BUGS.md) are worth two minutes before you start:

- **Six doc claims about how the system behaves were wrong** — some never checked against the
  source, some true when written and falsified by later commits in the same branch. They were
  audited and fixed, but by the same author who wrote them, so that audit isn't independent.
  **If a doc asserts what the code does, open the file.**
- **One fix introduced a worse bug than it solved.** The `BUG-002` sidecar work made
  `access_count` double on every mutation. It was caught by adversarial review, not by the
  test suite — because the tests were written to confirm the fix rather than attack it. Both
  "recall doesn't rewrite the store" and "sidecar round-trips" passed the whole time; nothing
  tested *recall followed by a mutation*.

The code is tested and independently verifiable in under a minute (below). The prose is the
part that earned suspicion.

## Already verified — don't redo

The test suite passes; every file parses; the esbuild bundle builds and runs as an MCP server with
all four verbs; `record.js`/`store.js` are bundled; exactly one GPL notice in the bundle;
temporal recall works end-to-end over stdio (present-tense query excludes superseded facts,
historical query returns them labelled); recall performs zero writes to the store; legacy
stores load with no migration.

## House rules (please don't violate)

- **Four MCP verbs, never five.** Capability goes in the substrate. If a design seems to
  need a fifth tool, the design is wrong.
- **All store writes go through `writeFileDurable()`** in `record.js`. Plain
  `fs.writeFileSync` on a live data file can truncate the user's entire memory — that was
  `BUG-001`.
- **Nothing on a read path writes to the store** — that was `BUG-002`.
- **No unmeasured signal touches ranking.** See `docs/proposed/0003 §5` — hybrid retrieval
  ships flag-off until an A/B win justifies flipping it.
- **`npm test` before pushing.**

## If you want to build, not just verify

From `docs/BACKLOG.md`, in order:

1. **`RM-00`** — the eval harness (`docs/proposed/0007`). Nothing else should merge first.
   `RM-03`'s detection logic in particular can quietly make recall *worse*, and there's
   currently no way to notice.
   **Highest-value first run once you have the embedder:** the constraint cases in
   `proposed/0007`, each with `field: false` and `field: true`. The gap between those two
   numbers is **the measured value of the associative field** — this project's central claim,
   and it has never been tested. Also run `constraint-learning`, which repeats a query several
   times: a constraint that misses on turn 1 and lands by turn 4 is the Hebbian loop working,
   and a one-shot test would score that as a failure.
2. **`RM-03`** — supersession detection. All plumbing is done and tested
   (`supersedePatches`, `updateMany`, filtered recall); only the *decision of when to call
   it* is missing. Scoring function is in `docs/proposed/0002 §Detection`.
3. **`RM-02`** — near-duplicate merge. Exact-match dedup already ships.

## Notes specific to this machine

- **16 GB VRAM** — enough to hold the embedding model and a 7–14B instruct model at once,
  which makes the optional LLM tiers in `proposed/0001` (extraction) and `0002`
  (contradiction adjudication) genuinely testable. Caveat: the sanity gate in `0001` was
  written blind assuming a small flaky model, and is probably **far too strict** for a 14B.
  Measure it, then loosen it. Keep both tiers **off by default** regardless — the target
  user is on a laptop with no GPU.
- **128 GB RAM / 2 TB** — the `RM-15` soak test (1,000+ updates) and a 100k-memory
  `store_growth` run are both cheap here. The "~10k memory ceiling" in `docs/BUGS.md` is an
  **estimate from reading the code, not a measurement** — replacing it with a real number
  would be genuinely useful.
- **Node 22 confirmed, `node:sqlite` available** (`DatabaseSync`, `StatementSync`, `backup`).
  This resolves the open dependency question in `proposed/0005`: `RM-07` can use built-in
  SQLite with no native module and no risk to the single-file SEA build. Remaining unknown
  is whether the `sqlite-vec` extension loads inside a SEA context — there's a documented
  fallback if not.
- **Admin rights** — code signing (`BUG-005`, `RM-11`) is the one adoption blocker that
  needs a certificate rather than code. Unsigned binaries trip SmartScreen, which is a rough
  first impression for a product asking to hold someone's private memories.

## Open issues

`docs/BUGS.md` — 3 fixed, 2 open (`BUG-004` store path names LM Studio even for Claude-only
users; `BUG-005` unsigned binary), plus a watch list. `W-02` (panel has no CSRF token or
Origin check — any local process, or a web page via DNS rebinding, can drive the API) should
be settled before `RM-12` exposes it as a documented API.
