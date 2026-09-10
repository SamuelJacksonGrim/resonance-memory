<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# S2v2 result (live run 2026-09-10)

Pre-registration: [`s2v2-prereg.md`](s2v2-prereg.md) (method locked; cosine bound frozen at 0.05).
Driver: **stock qwen3.6-35B-A3B** (unsloth UD-Q4_K_M) served locally via llama.cpp on `:8080`,
greedy (`temp=0 seed=7`), recall block **injected** (not a tool-call), neutral system prompt.
Identity probed clean before scoring (plain Qwen, no baked persona). Full per-arm log committed at
[`../../eval/s2v2-live-log.json`](../../eval/s2v2-live-log.json); `--replay` re-derives every number.

## Scoped verdict

> **S2v2 for stock qwen3.6, this corpus, injected-recall format: PRIMARY-CHANNEL DOMINANT.**

When a Primary row and a `Related:` row carry the **same sentence** and contradict on the value —
so neither channel has any linguistic-salience advantage — the driver follows the **Primary
channel**, essentially always. It does **not** treat `Related:` as authoritative over Primary.

Claims nothing about other drivers, other corpora, or a live tool-call format.

## The numbers

| measure | value | meaning |
|---|---|---|
| **primary_following_rate** | **100%** (17/17) | of the pairs where it followed a *channel*, every one was Primary. `RR = 0`. |
| **channel_consistency_rate** | 89.5% (17/19) | it followed a channel (not a fixed value) in ~9 of 10 pairs. |
| pair-class (analysis) | **PP=17, RR=0, XX=1, YY=1** | Primary-consistent dominates; the two value-bias cases lean opposite (net `lean=none`). |
| **N-gate** | **29/29 → neither** | the unguessability gate held *perfectly*: with the memory stripped, the driver produced neither value on any case. The values are genuinely prior-free — this is what makes the result mean anything. |
| **A/A instrument** | 98.3% (57/58), PASS | when both channels agree, the driver emits the shared value — the format/parser/driver pipeline is sound (floor 95%). |
| decision_coverage | 98.3% (57/58) | it committed to a value on nearly every arm (floor 80%). |
| held-out (separate) | PP=5, RR=0, XX=1, YY=0 | the same Primary dominance holds on fresh templates — it generalizes. |

Analysis population = pair-complete ∩ N-clean ∩ in-pool ∩ not-cosine-quarantined (n=19). Four
cases were cosine-quarantined at the frozen 0.05 bound (3 in-pool + 1 held-out), excluded per the
prereg, not repaired.

## What it means (interpretation — separated from the measurement)

- **This answers the post-H6 question.** H6 showed the driver *uses* `Related:` (it's not
  decorative). It couldn't tell whether a contradicting `Related:` overturns Primary because
  the channel is trusted, or just because our H6 contradiction was phrased closer to the query.
  **S2v2 removes the phrasing advantage, and the overturning disappears: `RR = 0`.** So the H6
  hijack (4/7) was, as suspected, mostly the **salience confound** — not evidence that `Related:`
  is authoritative.
- **This is the two-sided-honesty landing we pre-registered for.** A clean matched-phrasing test
  can exonerate as readily as convict, and here it exonerated: under this format, the driver
  behaviorally respects Primary over `Related:` when they conflict — consistent with RM's I3
  (discovery nominates, does not appoint). *Consistent with, not proof of* — it's one driver, one
  corpus, one format.
- **The `Related:` contract now has a measured shape.** `Related:` is neither decorative (H6: it's
  used), nor authoritative (S2v2: Primary wins conflicts), nor inherently dangerous. It is a
  **secondary evidence channel whose behavioral weight is measurable** — exactly the boundary the
  campaign was trying to establish.
- **The format-authority experiment is now low priority.** The prereg pre-declared this: a
  "honored/dominant" result means labeling `Primary (authoritative)` vs `Related (associative)`
  isn't needed to get the driver to weight Primary — it already does.

## Honest anomalies (none move the verdict)

- **Two value-bias pairs** (`label-color` → X, `room-name` → Y): the driver picked the same token
  regardless of channel. They lean opposite directions, so net value-bias is ~nil; and the pair
  table is *why* we can see these as value bias rather than mistaking them for channel behavior.
  (`room-name` uses the value `wendu` — flagged at freeze as Chinese for "temperature"; its N-arm
  was clean, so the pull is between the two injected values, not a prior. Worth a swap in any
  replication, but it's 1 case and self-cancelling here.)
- **One A/A fail** (`label-color.AAx`) and **one invalid pair** (`bin-tag`, one arm abstained) —
  1 each out of 58/29; both above their floors.
- `RR = 0` in every slice (analysis and held-out): there is **no** case where the driver
  systematically followed a contradicting `Related:` over Primary.

## Reproduce

```
node eval/s2v2-run.js --replay eval/s2v2-live-log.json   # re-derives the verdict from the log
node eval/s2v2-audit-check.js                            # static fixture audit (cosine, symmetry, C4 shape)
node eval/s2v2-run.js --assemble-only                    # α/β/AAx/AAy/N assembly + masked-identity assert
```

The C4 joint-derivation marks in the fixtures are first-pass author-asserted (all `impossible`);
the highest-risk case (`held-anaphora`) was reviewed and confirmed — the query anaphor identifies
the object, not the value, and the values are absent from all non-answer context.

---
**Related:** part of the [activation & consumption campaign](../research/README.md) — the tree:
Lane A/B/C · [[h4-related-discovery|H4]] · [[h6-result|H6]] · **S2v2** (this result).
