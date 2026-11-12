<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# Resonance Memory docs

Every doc in the repo, by what it's for. Each fact has one owner; other docs link to it rather than repeat it.
**Current** docs describe the code as it is and are kept up to date. **Record** docs are dated history (results,
pre-registrations, build notes): they're kept as they were, not rewritten. **Plan** docs describe work not built yet.

## Start here

| Doc | What it's for |
|---|---|
| [README](../README.md) | What Resonance Memory is, how to install it, the measured A/B |
| [DEVELOPERS](../DEVELOPERS.md) | Entry points, how to run every check, where things live |
| [CONTRIBUTING](../CONTRIBUTING.md) | How to contribute, the docs workflow, licensing of contributions |
| [CHANGELOG](../CHANGELOG.md) | What shipped in which release |

## Using it (current)

| Doc | What it's for |
|---|---|
| [MEMORY-SYSTEM](guides/MEMORY-SYSTEM.md) | The memory folder: index, drawers, history, recall, and how to install it |
| [CABINET](guides/CABINET.md) | The filing cabinet scripts that keep the folder's drawers indexed |
| [AUTO-RECALL](guides/AUTO-RECALL.md) | Recall on every message: the proxy for local models, the hook for Claude Code |
| [Claude Code plugin](../plugin/README.md) | The one-command plugin install |
| [BUILDING](guides/BUILDING.md) | Building the executables, signing status, Gatekeeper and SmartScreen |
| [system-prompt.md](../system-prompt.md) | The optional system prompt for models that forget to use their memory tools |

## How it works and what's next (current)

| Doc | What it owns |
|---|---|
| [ARCHITECTURE](ARCHITECTURE.md) | Runtime paths, modules, defaults, configuration, and the I1–I9 invariants |
| [ROADMAP](ROADMAP.md) | Route and phase-level status, shipped product tracks |
| [BACKLOG](BACKLOG.md) | Every RM item's scope, status, acceptance and remaining work |
| [BUGS](BUGS.md) | Defects, fixes, regression evidence and open exposure |
| [Phase specs](phases/) | Buildable contracts per phase, including the Phase 2 fusion gate (0–1 built, 2 and 7 partly built, the rest plans; [ROADMAP](ROADMAP.md) has each status) |
| [COMPETITIVE-ANALYSIS](COMPETITIVE-ANALYSIS.md) | The memory-layer market (vendor facts dated 2026-09-10; check before quoting) |

## Measured (record)

| Doc | What it holds |
|---|---|
| [eval guide](../eval/README.md) | How the offline harness, metrics, scale and soak instruments work (current) |
| [eval results](../eval/RESULTS.md) | The core and substrate results (golden, write path, supersession, field), dated |
| [A/B results](../eval/ab/RESULTS.md) · [rig A](../eval/ab/README.md) · [rig B](../eval/ab-grok/README.md) | The two-rig A/B: Resonance against no memory and recent-chat stuffing |
| [soak](../eval/soak/README.md) · [substrate](../eval/substrate/README.md) | The long-run control soak and the substrate scale tests |
| [Research log](research/README.md) | The September 2026 activation campaign: lanes A–C, H4, H6, S2v2, each with its pre-registration and result |

## Designs (plan or record)

| Doc | What it holds |
|---|---|
| [Proposals](proposed/README.md) | RFC-style designs 0001–0011, each marked with what shipped and what's still a proposal |

## Notes

| Doc | What it holds |
|---|---|
| [itch page](notes/itch-page.md) | The itch.io listing text (current: update it when a release changes the app) |
| [dissemination log](notes/roadmap-dissemination-log.md) | Where each section of the original cross-repo spec landed in these docs (record, August 2026) |
| [install-home notes](notes/NOTES-install-home.md) | Build notes from the self-installing executable (record) |

Legal: [LICENSING](../LICENSING.md), [COMMERCIAL-LICENSE](../COMMERCIAL-LICENSE.md) and [`legal/`](../legal/).
The project site is [`index.html`](index.html) in this folder.
