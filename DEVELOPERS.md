# Resonance Memory — developer notes

Resonance Memory is a local memory product with an MCP store and a markdown memory-folder
system. The public MCP surface stays at four verbs. This repository's
[ARCHITECTURE](docs/ARCHITECTURE.md) owns the runtime map, defaults and I1–I9 invariants;
[BACKLOG](docs/BACKLOG.md) owns item scope and acceptance, and
[ROADMAP](docs/ROADMAP.md) owns sequence and status.

History: `resonance-memory-stack` is the earlier cross-repo plan. It is retained for history,
not as the source of truth for work in this repository.

## Environment and entry points

The standalone server/build uses CommonJS, Node standard library and built-in `fetch`, with
Node ≥22.5 for `node:sqlite`. There are no runtime npm dependencies. The standalone executable
includes Node; users of that executable do not install Node separately. The Claude Code
plugin has its own [requirements and setup](plugin/README.md).

| Working on | Start here | Usage / design owner |
|---|---|---|
| Four MCP verbs | `server.js`, shared `memory-core.js` | [Architecture data flow](docs/ARCHITECTURE.md#5-the-four-verbs-data-flow) |
| SQLite/JSONL, migrations, learned edges | `store.js`, `store-sqlite.js`, `edges.js` | [Architecture storage](docs/ARCHITECTURE.md#6-storage-and-the-sidecars) |
| Folder recall, hooks and installer | `hooks/memory-system/`, `memory-system/` | [Memory system](docs/guides/MEMORY-SYSTEM.md) |
| Cabinet | `hooks/cabinet/` | [Cabinet](docs/guides/CABINET.md) |
| Claude Code plugin | `plugin/` | [Plugin guide](plugin/README.md) |
| Per-message recall proxy | `proxy.js` | [Auto-recall](docs/guides/AUTO-RECALL.md) |
| Panel and application installation | `panel.js`, `install.js`, `install-home.js`, `entry.js` | [Runtime entry points](docs/ARCHITECTURE.md#3-the-run-modes), [README](README.md) |
| Export/import | `export-memory.js`, `import-memory.js`, `zip.js` | [Architecture storage](docs/ARCHITECTURE.md#6-storage-and-the-sidecars), panel Terminal commands |
| Eval instruments | `eval/` | [Eval guide](eval/README.md), [soak](eval/soak/README.md) |

The complete module map lives in ARCHITECTURE. Keep `memory-core.js` the single implementation
of the four verbs; the server and cached-embedding eval inject their environments into it.
Folder recall is a separate path: its BM25 fallback is not the MCP store's keyword-overlap
fallback, and neither implements the open RM-05 fused retrieval arm.

## Checks

Run the checks for the surface you change. These commands print the current counts/scores;
do not copy those moving numbers into the docs.

```sh
npm test                              # main unit/regression suite
node eval/run.js                      # SQLite default, golden parity
node eval/run.js --store jsonl        # JSONL golden path
node hooks/memory-system/test.js      # folder recall/install/hook fixtures
node plugin/test.js                   # plugin packaging and recall-copy drift
```

Cabinet checks: run `python -m unittest discover -s tests` from `hooks/cabinet/`.
Reporting metrics: `npm run measure`; scale and soak instruments: `npm run scale` and
`npm run soak`. Their [eval guides](eval/README.md) describe scope, outputs and any write
behavior. Recorded measurements live in [eval results](eval/RESULTS.md) and [research](docs/research/).

Main tests and the golden runner use fixtures/cached embeddings; live cache refresh and
live-driver experiments are separate, explicit operations. The folder suite uses fixtures
and local test servers, with optional fixture-only PowerShell parity on Windows.

[PR/main CI](.github/workflows/ci.yml) runs the main suite, SQLite golden and plugin suite.
The [release workflow](.github/workflows/release.yml) gates native builds with the main suite
and SQLite golden, then smoke-tests each executable. The folder and cabinet suites are
separate contributor checks, not additional steps in those workflows.

`plugin/scripts/lib` contains packaged copies of the folder recall modules. After changing
their originals, `node plugin/test.js --sync` refreshes the copies; run the plugin check again.
Do not weaken a failed drift check by editing only the packaged copy.

## Build and release

```sh
node build-exe.js
```

[BUILDING](docs/guides/BUILDING.md) owns per-platform procedure, output names and OS warning
instructions. Builds are native per OS. Runtime assets include the demo seed, system prompt,
memory template, CLAUDE memory block, memory-system scripts and cabinet package; the executable
is still one self-contained file. `embedded-assets.js` is generated, not hand-edited.

GitHub Releases is the distribution path; [CHANGELOG](CHANGELOG.md) owns release chronology.
Native binaries are unsigned; signing/notarization remains RM-11. Release version metadata
comes from `package.json`.

## Before changing behavior

Read the [current invariants](docs/ARCHITECTURE.md#2-design-invariants-the-shape-is-load-bearing).
Default ranking is cosine; I2 permits no unmeasured rank signal. Experiments remain gated by
the [Phase 2 promotion contract](docs/phases/phase-2-retrieval-dynamics.md#fusion-promotion).
Enabling an experimental combiner is not default promotion.

Learned Hebbian state is irreplaceable; derived caches are reconstructible. Do not delete a
JSONL edge sidecar on the assumption that the texts recreate learned history. The default
live config is `resonance-memory.config.json` beside the store, unless overridden. Storage
details and the legacy/outage embedding-backfill exception belong to ARCHITECTURE.
`inspect_sidecar.js` supports JSON edge/legacy sidecars joined to JSONL; it does not inspect
the default SQLite tables.

A behavior change includes its documentation changes. Follow the [contribution workflow](CONTRIBUTING.md#development-and-documentation)
and [working brief](CLAUDE.md); BUG-006 records the failure that motivated this rule.

## Related

[[README]] · [[ARCHITECTURE]] · [[ROADMAP]] · [[BACKLOG]] · [[CLAUDE]] · [[CHANGELOG]] · [[BUGS]]
