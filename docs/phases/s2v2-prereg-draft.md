<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# S2v2 pre-registration (DRAFT — for GPT cross-check, not yet locked)

Follow-on to H6. H6 established, for stock qwen3.6 under the injected-recall format:
`Related:` is **behaviorally load-bearing** (S1: B→A 7/7, N=0%), and a contradictory `Related:`
overturned a correct primary in 4/7 — but that 57% is **confounded by query-salience** (the
wrong `Related:` sentence was phrased closer to the query than the primary row in every hijack).
S2v2 removes the confound and asks the clean question.

**Status: DRAFT.** Mirroring H6, this wants an independent GPT draft / cross-check before it is
locked, then a Grok build that STOPS before the live driver for a fixture audit. Nothing runs
until the prereg is reconciled + locked and the fixtures are audited.

## Question

> When a Primary statement and a Related statement are **equally query-aligned** and
> **contradict** each other, does stock qwen3.6 privilege one channel — and specifically, does
> it treat the Primary channel as authoritative (RM's I3) — or does it treat them as peer
> evidence?

## The core protocol — matched phrasing + counterbalancing

GPT's requirement: neither channel may have a linguistic advantage. Achieved two ways together:

1. **Shared sentence template.** Both the Primary answer-sentence and the Related answer-sentence
   are the SAME template `T(value)`, differing only in the value token — so they are equally
   query-aligned *by construction*, not by assertion. (Mechanical belt: cosine(T(X), Q) ≈
   cosine(T(Y), Q) — the value token barely moves the embedding; the audit checks this.)
2. **Counterbalancing (my addition to "symmetric").** Each semantic case is run in BOTH
   value-assignments, as two independent generations:
   - **arm α:** Primary = `T(X)`, Related = `T(Y)`
   - **arm β:** Primary = `T(Y)`, Related = `T(X)`
   This is what actually separates *channel* preference from *value* preference and from any
   residual positional effect. If the driver privileges the **Primary channel**, it outputs the
   primary-channel value in *both* arms (X in α, Y in β). If it privileges the **Related
   channel**, it outputs the related-channel value in both. If it has a **value bias** (e.g.
   always says X), that shows as picking the same token regardless of channel. If it is
   **indifferent**, picks scatter ~50/50.

Both channels keep their real format (Primary = numbered block, `Related:` = section after it),
because the channel-under-test *is* that format including its position. What we neutralize is
phrasing/salience of the conflicting sentences, not the format itself.

## Corpus

- **≥ 10 semantic cases** (more than H6's 7 — the metric is a rate over 2×N counterbalanced
  arms, so power matters). Each: a query `Q`, two **arbitrary prior-free** values `X`, `Y`
  (invented tokens in the norbrae/tavrin/verrin vein — N-arm must confirm both unguessable),
  and one shared query-aligned template `T(·)`.
- **Primary block realism:** the `T(value)` answer-sentence sits among a small fixed set of
  **neutral distractor rows** (same across α/β) that favor neither value; `Related:` is the
  single `T(other value)` line. Answer-sentence position within the primary block is fixed
  across α/β.
- Held-out slice (fresh templates/structure) for generalization, as in H6.
- Tracked fixtures; deterministic; each carries a machine-checkable audit object (values
  arbitrary + absent-from-distractors; template shared; cosine-alignment near-equal).

## Arms

| arm | Primary answer-sentence | Related | purpose |
|---|---|---|---|
| **α** | `T(X)` (+ neutral distractors) | `T(Y)` | which value? |
| **β** | `T(Y)` (+ neutral distractors) | `T(X)` | counterbalance |
| **N** | neutral filler | neutral filler | unguessability gate (both X and Y must fail) |

Same driver/decoding/format as H6: stock qwen3.6-35B-A3B on `:8080`, greedy `temp=0 seed=7`,
injected recall block, neutral system prompt. Fail-loud if driver down; per-arm log + replay;
assert the primary block is byte-identical between the α/β *pair* except for the swapped value.

## Metric

For each counterbalanced arm, record which channel's value the driver output.
- **`primary_channel_pick_rate` p** = fraction of arms (over all 2×N) where the output equals the
  **Primary-channel** value.
- Also: `value_bias` (does one token win regardless of channel?), `related_channel_pick_rate`,
  and per-arm `abstain/other` (neither value → parser `absent`, excluded like an invalid trial).

## Pre-registered decision (three-way, stated before the run)

Let p = `primary_channel_pick_rate` over valid counterbalanced arms (both members of a pair must
produce a value; N-pass cases and abstains excluded first).

- **AUTHORITY HONORED — p ≥ 0.80:** even with salience neutralized, the driver privileges
  Primary. Then H6's hijack was mostly the salience confound; the channel-authority defect is
  **not** established, and the format-authority experiment (next node) is **low priority**.
- **PEER / INDIFFERENT — 0.40 ≤ p ≤ 0.60:** the driver treats Primary and Related as peer
  evidence; it does **not** infer I3's Primary-authority from the format. The channel-authority
  gap is real (peer-treatment form) → **format-authority experiment (b) is warranted.**
- **RELATED PRIVILEGED (inversion) — p ≤ 0.20:** the driver actively prefers Related over a
  contradicting Primary. A strong defect → format-authority (b) is **urgent**, and may not be
  fixable by labeling alone.
- **Intermediate bands (0.20–0.40, 0.60–0.80):** report as a lean; underpowered — say so and
  recommend more cases rather than over-reading.

**Falsifier for "H6's hijack was a genuine channel-authority failure":** if p ≥ 0.80, that claim
is falsified (it was salience). The two-sided honesty: a clean matched-phrasing test can *exonerate*
the driver as well as convict it.

## Controls / confounds closed

- Salience: neutralized by shared template + counterbalancing (the whole point).
- Value/prior: arbitrary invented tokens; N-arm confirms both X and Y unguessable (both must fail).
- Position: primary block position of the answer-sentence fixed across α/β; channel = format,
  intentionally including its position.
- Distractors: identical across α/β, favor neither value.
- Decoding: greedy + fixed seed; α and β are independent generations.

## Scope grammar (unchanged discipline)

Verdict is always **"S2v2 for stock qwen3.6, this corpus, injected-recall format: [honored /
peer / inverted]."** Claims nothing about other drivers, corpora, or a live tool-call format.

## Non-goals (gated behind this result)

The **format-authority experiment** — does labeling `Primary (authoritative)` vs `Related
(associative, may be stale)`, content otherwise identical, move p toward authority — is the
NEXT node, run only if S2v2 shows peer/inverted. Not this experiment.

---

*Draft for reconciliation. Open questions for GPT: (1) the 0.80 / [0.40–0.60] / 0.20 thresholds
at n≥10×2 — right, or want a McNemar-style paired test on the α/β pairs instead of a pooled
rate? (2) should a case where α and β disagree in a way consistent with position-not-channel be
flagged separately? (3) minimum N for the power you'd trust.*

---
**Related:** part of the [activation & consumption campaign](../research/README.md) — the [research index](../research/README.md) holds the full tree (Lane A/B/C · [[H4]] · [[H6]] · [[S2v2]]).
