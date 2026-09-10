<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# S2v2 pre-registration (LOCKED 2026-09-10)

Follow-on to H6. H6 established, for stock qwen3.6 under the injected-recall format:
`Related:` is **behaviorally load-bearing** (S1: B→A 7/7, N=0%), and a contradictory `Related:`
overturned a correct primary in 4/7 — but that 57% is **confounded by query-salience** (the
wrong `Related:` sentence was phrased closer to the query than the primary row in every hijack).
S2v2 removes the confound and asks the clean question.

**Status: LOCKED.** Reconciled from `s2v2-prereg-draft.md` against an independent GPT cross-check
(see [History](#history) for the exact draft→lock changes). Next: a Grok build that STOPS before
the live driver for a fixture audit; nothing runs live until the fixtures pass audit.

## Terminology — the measured thing vs the interpreted thing

This distinction is load-bearing; it is the guard against another H4-style claim outrunning its
evidence. Used consistently below:

- **Channel preference** — *what the experiment directly measures.* When Primary and Related
  carry equally query-aligned contradictory statements, which channel's value the driver emits.
- **Primary authority (RM's I3)** — *the architectural interpretation* of a strong, consistent
  Primary-**channel** preference. We never report "authority" as a raw observation. The raw
  measurement is always behavioral: "Primary-channel preference under matched contradiction."

## Question

> When a Primary statement and a Related statement are **equally query-aligned** and
> **contradict** each other, does stock qwen3.6 exhibit a **channel preference** — specifically,
> does this injected-recall format induce a preference for the **Primary channel** — or does it
> treat the two as peer evidence?

## The core protocol — matched phrasing + counterbalancing

GPT's requirement, endorsed: neither channel may have a linguistic advantage, and we neutralize
**linguistic salience** while **preserving the real Primary/Related consumption format** (that
format, including its position, *is* the channel under test). Achieved two ways together:

1. **Shared sentence template.** Both the Primary answer-sentence and the Related answer-sentence
   are the SAME template `T(value)`, differing only in the value token — so they are equally
   query-aligned *by construction*, not by assertion. The template itself must not privilege the
   value position (`"The chosen archive color is X."` — good; `"The unusual archive color is X."`
   vs `"The archive color is Y."` — forbidden).
2. **Counterbalancing.** Each semantic case is run in BOTH value-assignments, as two independent
   generations:
   - **arm α:** Primary = `T(X)`, Related = `T(Y)`
   - **arm β:** Primary = `T(Y)`, Related = `T(X)`
   This is what separates *channel* preference from *value* preference and from any residual
   positional effect. If the driver prefers the **Primary channel**, it emits the primary-channel
   value in *both* arms (X in α, Y in β). If it prefers the **Related channel**, it emits the
   related-channel value in both (Y in α, X in β). If it has a **value bias** (e.g. always X),
   it emits the same token regardless of channel.

Both channels keep their real format (Primary = numbered block, `Related:` = section after it).
What we neutralize is phrasing/salience of the conflicting sentences, not the format itself.

## The pair is the unit — a 2×2, read two ways

The load-bearing diagnostic (GPT's central methodological change) is the **α/β pair per semantic
case**, not the pooled rate. Because the two values swap positions between α and β, the pair has
exactly four valid outcomes — and each cell reads cleanly under both a *channel* lens and a
*value* lens (they are the same two observations, two interpretations):

| α output | β output | channel reading | value reading | meaning |
|---|---|---|---|---|
| **X** (=Primary) | **Y** (=Primary) | **PP** | — | **channel-Primary consistency** |
| **Y** (=Related) | **X** (=Related) | **RR** | — | **channel-Related consistency** |
| **X** | **X** | (PR) | **XX** | **value bias → X** (channel-inconsistent) |
| **Y** | **Y** | (RP) | **YY** | **value bias → Y** (channel-inconsistent) |
| any | abstain/other | — | — | **invalid** (excluded from the pair population) |

The elegance: `PP` is genuine channel-Primary consistency and `RR` genuine channel-Related
consistency *only because* the value swapped; `XX`/`YY` are exactly the value-bias patterns a
one-way test cannot see. (GPT listed six labels — `PP RR XX YY PR RP` — which collapse to these
four cells: `PR≡XX` and `RP≡YY`, since a fixed-value answer is by definition channel-inconsistent.
Same content; the 2×2 form is the less error-prone way to hold it.)

**This is why the experiment tells us not just that p = .65 but *why*.**

## Corpus

- **Minimum 20 semantic cases** (2×20 = 40 counterbalanced generations); **30 preferred** if the
  fixture budget permits. **≥ 5 of the cases are held-out** (fresh templates/structure, for
  generalization). The 10-case draft is a pilot only — 10 is too easy to overinterpret at the
  case level. This floor is a behavioral-adequacy floor, **not** a statistical power analysis.
- Each case: a query `Q`, two **arbitrary prior-free** values `X`, `Y` (invented tokens in the
  norbrae/tavrin/verrin vein — the N-arm must confirm both unguessable), and one shared
  query-aligned template `T(·)`.
- **Value symmetry (new requirement):** `X` and `Y` must be approximately matched for lexical
  form — token/word-piece count, character length, capitalization, lexical class — so no
  token-shape prior favors one. Numbers are fine for unguessability *in general* but a
  `614 / norbrae`-style asymmetric pair is **not** acceptable here; prefer `norbrae / tavrin`,
  `velka / sorin`-type pairs. Symmetry is **audited and recorded**, not silently assumed.
- **Primary block realism:** the `T(value)` answer-sentence sits among a small fixed set of
  **neutral distractor rows** (identical across α/β) that favor neither value; `Related:` is the
  single `T(other value)` line. Answer-sentence position within the primary block is fixed
  across α/β.
- Tracked fixtures; deterministic; each carries a **machine-checkable audit object** (as in H6):
  values arbitrary + absent-from-distractors; template shared; token-shape symmetry fields
  recorded; cosine-alignment recorded with delta.

## Arms

| arm | Primary answer-sentence | Related | purpose |
|---|---|---|---|
| **α** | `T(X)` (+ neutral distractors) | `T(Y)` | which channel? |
| **β** | `T(Y)` (+ neutral distractors) | `T(X)` | counterbalance |
| **N** | neutral filler (**same query, same block structure**) | neutral filler | unguessability gate |

**N-arm detail (new):** N keeps the *same query and the same general injected-block structure* so
it isolates parametric knowledge cleanly. Record **N→X / N→Y / N→neither** rather than a bare
pass/fail: if N consistently emits one invented token, that is a **token prior**, and the case is
excluded *and* the prior is reported as a diagnostic. A case is admissible only if **both X and Y
fail under N** (neither is guessable from the query + world knowledge).

Same driver/decoding/format as H6: stock qwen3.6-35B-A3B on `:8080`, greedy `temp=0 seed=7`,
injected recall block, **neutral system prompt** ("Use only the injected recall block below. Do
not use world knowledge. Do not guess."). **Do NOT** reintroduce "Primary is authoritative," and
do NOT tell the model that Related is associative/secondary/stale — any such label turns the
experiment into instruction-following. The *only* channel distinction is the actual RM format.
Fail-loud if driver down; per-arm log + replay; assert the primary block is byte-identical between
the α/β *pair* except for the swapped value.

## Metrics

Built into the harness **from the start** (not bolted on after the run):

- **Headline descriptive:** `primary_channel_pick_rate` **p** = fraction of valid arms (over all
  counterbalanced arms) whose output equals the **Primary-channel** value. Reported, but **not**
  the sole inferential object.
- **Load-bearing diagnostic:** the **pair-class distribution** over pair-complete cases —
  counts of `PP`, `RR`, `XX`, `YY` (and invalid). This is the primary analysis population.
- **Validity accounting (new, mandatory):** `total_arms`, `valid_arms`, `invalid/abstain_arms`,
  `pair_complete_cases`. Invalid arms are **reported, never silently discarded.**
- Derived: `related_channel_pick_rate`, `value_bias` (does one token win regardless of channel).

**Validity floor:** at least **80% of planned arm generations** must yield a valid X/Y answer for
the channel-preference verdict to be admissible. (This does not mean invalids "fail" anything — it
prevents manufacturing interpretability by discarding half the generations.) The primary analysis
population is **pair-complete cases** (both α and β produced a value).

## Pre-registered decision (stated before the run)

`p` and the pair-class distribution are read **together**. The numeric edges below are
**decision bands — not confidence intervals and not significance thresholds.** With 20–30 cases
they are pre-declared behavioral zones, nothing more.

- **PRIMARY-CHANNEL PREFERENCE HONORED** *(architectural reading: I3 Primary-authority
  plausible)* — `p ≥ 0.80` **AND** `PP` is the dominant channel-consistent pair class **AND**
  value-bias (`XX`+`YY`) does not dominate. Then H6's hijack was mostly the salience confound;
  the channel-authority defect is **not** established and the format-authority experiment is low
  priority.
- **PEER / NO STABLE CHANNEL AUTHORITY** — `0.40 ≤ p ≤ 0.60` **AND** neither `PP` nor `RR`
  dominates. The driver does not infer Primary-authority from the format → **format-authority
  experiment is warranted.** *(Distinguished from value bias: a near-.50 p driven by high
  `XX`/`YY` is **value bias / unresolved**, reported as such — not "peer.")*
- **RELATED-CHANNEL PREFERENCE (inversion)** — `p ≤ 0.20` **AND** `RR` dominant **AND** value
  bias does not dominate. A strong defect → format-authority experiment is **urgent**, and may
  not be fixable by labeling alone.
- **Intermediate / underpowered (`0.20–0.40`, `0.60–0.80`, or a band condition unmet):** report
  as a lean and as **inconclusive**. **Do NOT** escalate to more trials *within this
  preregistered run* — that is a hidden tuning loop ("more cases until the answer lands in our
  band"). Any replication is defined and pre-registered **separately.**

**Falsifier for "H6's hijack was a genuine channel-authority failure":** if `p ≥ 0.80` with `PP`
dominant, that claim is falsified (it was salience). The two-sided honesty stands: a clean
matched-phrasing test can *exonerate* the driver as readily as convict it.

## Controls / confounds closed

- **Salience:** neutralized by shared template + counterbalancing (the whole point).
- **Value / prior:** arbitrary invented tokens; token-shape symmetry audited; N-arm confirms both
  X and Y unguessable (both must fail); N→X/Y/neither recorded as a token-prior check.
- **Position:** primary-block position of the answer-sentence fixed across α/β. A value-
  independent positional preference **counts as channel preference** by design (the channel *is*
  the format-plus-position) — this is preserved, not confounded away.
- **Distractors:** identical across α/β; favor neither value.
- **Decoding:** greedy + fixed seed; α and β are independent generations.
- **Cosine alignment (audited, recorded):** for each case record `cos(T(X), Q)`, `cos(T(Y), Q)`,
  and `|Δ|`, against a **maximum-delta cutoff frozen at fixture-audit time** from the actual
  embedding geometry (not eyeballed after the fact). Cosine equality is *supporting* evidence;
  the shared template + counterbalancing do the heavy lifting. Cosine equality ≠ salience
  equality — this audit backstops the template, it does not replace it.
- **Randomization balance (audited):** across the corpus, X/Y assignment, template families,
  value lengths, and held-out structure must each be balanced — no stupid asymmetry (e.g. "all
  the odd values happen to be X in α") hiding in the fixtures.

## Scope grammar (unchanged discipline)

Verdict is always **"S2v2 for stock qwen3.6, this corpus, injected-recall format: [Primary-
channel preference honored / peer / value-biased / inverted]."** Claims nothing about other
drivers, corpora, or a live tool-call format. **"Channel preference" is reported; "Primary
authority" is named only as the architectural interpretation of a strong, PP-dominant result.**

## Non-goals (gated behind this result)

The **format-authority experiment** — does labeling `Primary (authoritative)` vs `Related
(associative, may be stale)`, content otherwise identical, move `p` toward authority — is the
NEXT node, run only if S2v2 shows peer/value-biased/inverted. Not this experiment.

## Anticipated result worth naming (GPT)

A clean and useful possible outcome: H6 says **"Related is used"** while S2v2 says **"Primary is
nevertheless privileged when the evidence conflicts."** That would establish the RM contract
boundary we've been chasing: `Related:` is neither decorative, nor automatically authoritative,
nor inherently dangerous — **a secondary evidence channel whose behavioral weight is measurable.**

---

## History

- **2026-09-10 — LOCKED.** Reconciled `s2v2-prereg-draft.md` (matched-phrasing + α/β
  counterbalancing, arbitrary values, N gate, held-out slice, neutral prompt, replayable greedy
  gen, scoped grammar, format-authority gated behind peer/inverted — all kept) against GPT's
  independent cross-check. Changes adopted:
  1. **Pair-class 2×2 as the load-bearing diagnostic**; pooled `p` demoted to headline
     *descriptive* stat. (Reconciled from GPT's six-label list to the four distinct cells.)
  2. **N floor raised to 20 cases (30 preferred), ≥5 held-out** — a behavioral-adequacy floor,
     explicitly not a power calc.
  3. **Decision edges relabeled *decision bands*, not significance thresholds**, and each verdict
     gated on **pair-class dominance** so value bias can't masquerade as "peer."
  4. **Validity floor (≥80%)** + full validity accounting; invalids reported, never discarded;
     pair-complete cases are the analysis population.
  5. **Token-shape symmetry audit** for X/Y; **complete-template cosine delta** recorded against a
     cutoff frozen at audit time; **randomization-balance audit** added.
  6. **N-arm records N→X/Y/neither** (token-prior diagnostic), same query + block structure.
  7. **Terminology split** made explicit throughout: *channel preference* (measured) vs *Primary
     authority* (interpreted); outcome renamed "Primary-channel preference under matched
     contradiction."
  8. **No in-run escalation** to more trials; replication pre-registered separately.
  9. **Harness must build pair-classification + validity accounting in from the start.**

---
**Related:** part of the [activation & consumption campaign](../research/README.md) — the [research index](../research/README.md) holds the full tree (Lane A/B/C · [[H4]] · [[H6]] · [[S2v2]]).
