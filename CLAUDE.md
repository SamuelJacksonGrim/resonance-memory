# CLAUDE.md

Guidance for AI assistants working in this repository.

## Authority and orientation

This repository's [ARCHITECTURE](docs/ARCHITECTURE.md) owns runtime behavior, defaults and
the I1–I9 invariants. [BACKLOG](docs/BACKLOG.md) owns scope and acceptance;
[ROADMAP](docs/ROADMAP.md) owns route and phase-level status. The earlier
[`resonance-memory-stack`](https://github.com/SamuelJacksonGrim/resonance-memory-stack)
cross-repo plan is retained for history, not as the current source of truth.

Start with [DEVELOPERS](DEVELOPERS.md) for entry points, checks and build links. Keep the
module/configuration map in ARCHITECTURE instead of duplicating it here. The memory-folder
system and MCP store are separate representations; their boundaries are documented there.

## Constraints

- The public MCP surface stays at **four verbs**: `save_memory`, `recall_memory`,
  `edit_memory`, `delete_memory`. The interface may get simpler, never more cognitively demanding.
- Preserve the exact [current invariants](docs/ARCHITECTURE.md#2-design-invariants-the-shape-is-load-bearing),
  including I2b and the named I4/I5 exception. No unmeasured rank change; default promotion uses
  the [Phase 2 gate](docs/phases/phase-2-retrieval-dynamics.md#fusion-promotion).
- Pure Node standard library and built-in `fetch`, CommonJS, zero runtime npm dependencies.
  Do not add a runtime dependency without a strong reason; this property supports the build
  and standalone distribution. Build-time tools are invoked through `npx`.
- Keep `memory-core.js` the single implementation of the four verbs. Inject the environment
  from server/eval rather than forking a recall or save path.
- Server metadata comes from the substrate/text, never model-assigned arguments.
- Record schema is defined in `record.js` `normalize()` with legacy defaults. Schema
  normalization is distinct from the explicit/default JSONL→SQLite backend conversion.
- Keep measured flag-off mechanisms as experiment seams. A failed experiment is not permission
  to delete its implementation during unrelated cleanup.

## Working conventions

- Read the code that decides a behavior before describing or changing it. Comments should
  carry the reason, measurement or defect that makes a choice load-bearing.
- Follow [CONTRIBUTING](CONTRIBUTING.md#development-and-documentation) for behavior/documentation
  changes. Run the relevant checks listed in [DEVELOPERS](DEVELOPERS.md#checks).
- Keep each source file's AGPL header. Generated assets stay generated; do not hand-edit
  `embedded-assets.js` or commit it.
- Preserve `.gitattributes` line endings: LF normally, CRLF for `.bat`. User state, build
  output and binaries stay untracked according to `.gitignore`; fixtures and demo seed are
  intentional tracked exceptions.
- Release metadata comes from `package.json`; CHANGELOG owns release chronology. Do not
  bump versions or edit release history for an unrelated documentation change.

## Git workflow

- Do not push directly to `main`. Work on a feature branch unless the user directs otherwise.
- Do not create a pull request unless the user explicitly requests one.
- The user's current instructions control commits, checkouts and other repository operations.

## Related

[[ARCHITECTURE]] · [[ROADMAP]] · [[BACKLOG]] · [[BUGS]] · [[DEVELOPERS]] · [[CONTRIBUTING]] · [[proposed/README]]
