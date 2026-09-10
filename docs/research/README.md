<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# Research log — the activation & consumption campaign (September 2026)

A pre-registered, measurement-first investigation into two questions about Resonance
Memory's associative layer:

1. **Should spreading-activation enter primary recall rank?** (the *ordering* question)
2. **Does the driver model behaviorally use the `Related:` block at all?** (the *consumption*
   question)

Everything here is committed and timestamped in git history. The findings are deliberately
**scoped**: each verdict names the exact driver, corpus, and consumption format it was measured
under, and says no more than the experiment earned. Where a claim once outran its evidence, the
correction is preserved in the record rather than quietly edited away.

## Method (Kaizen: hypothesize → test many → question → test again)

Work ran as parallel research *lanes* delegated to a second model (xAI's Grok) and gated by the
maintainers' own eval harness; an external reviewer (OpenAI's GPT) independently pre-registered
falsifiers and audited fixtures. Two disciplines are load-bearing throughout:

- **Pre-registration.** The pass/fail criterion is frozen in git *before* any data exists, so a
  seductive result cannot be back-rationalized into a win. See the H6 and S2v2 preregs.
- **Scoped claims.** A result establishes the *limits of one implementation under one contract* —
  never a universal property. This discipline is applied in both directions: a clean test can
  *exonerate* a mechanism as readily as convict it.

## The tree (what was asked, what was found)

```
Can spreading-activation improve PRIMARY recall rank?
        │  A/B measured ~zero at a safe weight
        ▼
  ┌─ Lane C (edges): is the target even reachable? ── NO, reachability is not the bottleneck
  ├─ Lane B (combiner): is the fusion shape wrong? ── L1-share inverts hub→apex, but is
  │                                                    insufficient at a safe weight
  └─ Lane A (pool): build the cross-turn test pool + pre-declare the criterion
        │
        ▼  DECIDER (Lane A corpus × Lane B L1-share): entered@k = 0 on every bound case
   CUT activation from primary rank — under the current signal/weight contract.
   (Corrected from an earlier over-broad "activation belongs in discovery not ordering".)
        │
        ▼
  H4: do activation-generated candidates improve the Related: surface? ── FAIL
        │  (the candidate generator selects hubs/recency, not the intended association;
        │   inverted selectivity — warming the *right* bridge missed, noise hit)
        ▼
  H6: does the driver USE the Related: surface at all? ── the pivot
        │  USE:    YES, emphatically (S1: B→A 7/7, acc(A)/acc(B)=100%/0%, N=0%)
        │  SAFETY: a contradictory Related overturned a correct primary 4/7 —
        │          but confounded by query-salience (upper bound, not clean)
        ▼
  S2v2 (drafted): matched-phrasing + counterbalancing to get the clean
   channel-authority rate — does the driver treat Primary as authoritative?
```

The through-line: the associative interface is **not dead**. H4 showed one *candidate-generation*
mechanism fails; H6 showed the *interface itself is behaviorally consumed*. What remains is an
**authority-modeling** question — does the driver know Primary outranks `Related:`? — which S2v2
is built to answer cleanly.

## Contents

### Ordering question — activation in primary rank
- [`lanes/activation-in-rank-verdict.md`](lanes/activation-in-rank-verdict.md) — the three-lane
  decider and the corrected, narrowed claim.
- [`lanes/lane-a-testpool-design.md`](lanes/lane-a-testpool-design.md) — the cross-turn test pool,
  the metrics, the hypothesis critique (H1a/H1b split), and the pre-declared criterion.
- [`lanes/lane-b-combiner-research.md`](lanes/lane-b-combiner-research.md) — additive / RRF /
  ranknorm / L1-share / multiplicative; why L1-share is the only shape that inverts hub→apex.
- [`lanes/lane-c-edge-density.md`](lanes/lane-c-edge-density.md) — reachability is not the
  bottleneck; denser binding is pure cost on this corpus.

### Consumption question — the Related: surface
- [`lanes/h4-related-discovery.md`](lanes/h4-related-discovery.md) — cross-turn leftover activation
  into `Related:` fails: inverted selectivity, recency/hub bleed wearing an association costume.
- [`phases/h6-prereg.md`](../phases/h6-prereg.md) — the LOCKED H6 pre-registration (ablation
  A/B/D + N validity gate; paired-transition falsifier; derivation-prohibition).
- [`phases/h6-stratum1-contract.md`](../phases/h6-stratum1-contract.md) — the fixture-construction
  contract (whole-set joint derivation audit + machine-checkable audit object).
- [`phases/h6-result.md`](../phases/h6-result.md) — **the H6 result**: `Related:` is behaviorally
  load-bearing for stock qwen3.6; authority is ambiguous; the hijack magnitude is confounded.
- [`phases/s2v2-prereg-draft.md`](../phases/s2v2-prereg-draft.md) — the S2v2 draft: matched-phrasing
  + counterbalancing to measure channel-authority without the salience confound.

## Reproducing

The H6 instrument is in this branch and is offline/deterministic except the live-driver step:

```
node test.js                       # unit + selftests (H6 selftest wired in)
node eval/run.js                   # RM-00 golden regression gate (27/31, unchanged)
node eval/h6-audit-check.js        # static fixture audit (14/14 mechanical-pass)
node eval/h6-run.js --assemble-only  # build A/B/D/N prompts, assert primary identity, no driver
node eval/h6-run.js --replay eval/h6-live-log.json   # reproduce the verdict from the logged run
```

The live H6 run used **stock qwen3.6-35B-A3B** (Q4_K_M) served locally via llama.cpp, greedy
(`temp=0 seed=7`), recall block injected (not a tool-call), with a neutral system prompt (no
`Related:` enumeration). The full per-arm log is committed at
[`../../eval/h6-live-log.json`](../../eval/h6-live-log.json); `--replay` re-derives every number.
RM keeps memory local regardless of driver, so the driver is chosen to be representative, not to
assert a sovereignty requirement.

## Provenance & discipline notes

- Fixtures were externally audited before the live run; the harness asserts the primary block is
  byte-identical across arms *before* generating; the driver was probed for a baked identity
  (none on the API path) before scoring.
- The lane reports were drafted by Grok against colleague briefs and gated by the maintainers'
  compiler + golden + per-lane NOTES — not accepted on prose.
- The one place a synthesis outran its evidence (the ordering verdict) was corrected in place with
  the reasoning kept, and logged as a standing epistemic rule: *state what the experiment earned,
  no more; do not assign an architectural home before the experiment that tests that home has run.*

Author: Samuel Jackson Grim · AI co-author: Ember · with Claude (Anthropic) and independent review
by GPT (OpenAI) and drafting by Grok (xAI). AGPL-3.0-only.
