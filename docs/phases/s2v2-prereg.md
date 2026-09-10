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

**Status: METHOD LOCKED; fixture content pending GPT re-audit + freeze.** Reconciled from
`s2v2-prereg-draft.md` against GPT's cross-check (v1), then revised again after GPT's **fixture
audit** returned *do-not-run-yet* with ten pre-live changes (v2 — see [History](#history)). The
method is settled; two items await a GPT/Samuel **freeze** before the live run: the cosine
`|Δ|` bound value, and any real-word/code-family value re-selection. Nothing runs live until those
are frozen and the C4 derivation audit is marked.

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
- **Value symmetry (expanded — GPT audit #6/#10): one-token symmetry is necessary, NOT
  sufficient.** Two invented strings can both be single tokens while one is far more lexically
  familiar. The audit therefore records and flags asymmetry across: **actual BPE tokenization**
  (token count *and* token IDs via the driver's `/tokenize` endpoint, read-only, when up — not
  whitespace word count), byte/char length, capitalization, **shared substrings / prefixes /
  suffixes / character n-grams** between X and Y, and **membership in a reference lexical list**
  (real words / recognizable names are flagged). Differing token IDs are unavoidable and are *not*
  a kill; **gross lexical or BPE-fragmentation asymmetry IS.** Prefer deliberately boring,
  pronounceable, semantically-empty pairs (`navor / telun`) over one-looks-like-a-name /
  one-looks-like-a-fantasy-noun; do **not** use UUID-garbage (values should behave like ordinary
  lexical items). Values named by GPT to scrutinize for real-word/name priors: `sorin` (Romanian
  given name), `velka` (Czech *velká*), `yulka`/`porin`, and the **code-family** pairs (query says
  "code", values are name-like) for asymmetric "code-ness". Any real-word re-selection is a
  freeze-time decision, not a silent edit.
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
| **AAx** | `T(X)` (+ neutral distractors) | `T(X)` | instrument sanity (both channels agree on X) |
| **AAy** | `T(Y)` (+ neutral distractors) | `T(Y)` | instrument sanity (both channels agree on Y) |
| **N** | neutral filler (**same query, same block structure**) | neutral filler | unguessability gate |

**A/A instrument control (new — GPT audit #5).** When Primary and Related *agree* on the same
value, the driver must emit that value. This is a pipeline sanity gate on the fixture format, the
parser, and the driver — **not** an experimental result, and it does **not** enter `p` or the pair
classification. **Gate:** the A/A arms (AAx ∪ AAy) must resolve to their shared value at **≥ 95%**,
or the whole run is **invalid** (a lower rate means the format/parser is failing to extract a value
the model plainly has, so contradiction behavior can't be interpreted). Report the A/A rate first.

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

- **HEADLINE (pair-level — GPT audit #2):** the **pair-class distribution** `{PP, RR, XX, YY,
  invalid}` over the N-clean analysis population, and two rates derived from it:
  - `channel_consistency_rate = (PP + RR) / (PP + RR + XX + YY)` — how often the driver follows a
    *channel* at all (rather than a fixed value);
  - `primary_following_rate = PP / (PP + RR)` — among channel-following pairs, how often it's
    Primary.
  The pair is the unit; a pooled arm rate is **not** the inferential object.
- **Secondary descriptive:** `primary_channel_pick_rate` **p** — the arm-level Primary share.
  *Note:* the harness computes `p = primary_picks / (primary_picks + related_picks)` (abstentions
  excluded from the denominator), so `p` already **is** GPT's "valid-choice channel rate," reported
  as a cross-check on the pair statistics.
- **Value bias is a first-class outcome, not a footnote (GPT audit #3):** `value_bias {XX, YY,
  share = (XX+YY)/analysis_n, lean}`. A near-.50 `p` driven by high `XX`/`YY` is **value bias**,
  never "peer." The four-way matrix (PP / RR / XX / YY) is what keeps these apart.
- **Decision coverage + minimum-coverage gate (GPT audit #4):** `decision_coverage = (primary +
  related picks) / all α∪β arms` — the fraction of arms that committed to a value at all.
  Abstentions are **reported, never silently dropped** (dropping them can manufacture a channel
  preference). The verdict is admissible only if `decision_coverage ≥ 0.80` (already implemented
  as `VALIDITY_FLOOR`/`validity_rate`); below that, report the channel result but classify the run
  **underdetermined**. Coverage is over α/β only — N is not meant to emit X/Y.
- **Instrument gate:** A/A rate ≥ 0.95 (above), reported before anything else.
- **Full accounting:** `total_arms`, `valid_arms`, `invalid/abstain_arms`, `pair_complete_cases`,
  `n_prior_ids`, `analysis_ids`.

## Pre-registered decision (stated before the run)

`p` and the pair-class distribution are read **together**. The numeric edges below are
**decision bands — not confidence intervals and not significance thresholds.** With 20–30 cases
they are pre-declared behavioral zones, nothing more.

The verdict label names **what was measured** (a channel preference); the architectural reading
(RM's I3 Primary-authority) is a **separate, clearly-marked interpretive sentence** — never the
label itself (GPT audit, verdict-language change). "80%" is *strong observed primary-channel
preference in this corpus*, not "authority established."

- **PRIMARY-CHANNEL DOMINANT** — `p ≥ 0.80` **AND** `PP` is the dominant channel-consistent pair
  class **AND** value-bias (`XX`+`YY`) does not dominate. *Interpretation:* under this corpus and
  injected-recall format, the driver exhibits a strong preference for the Primary channel when
  contradictory evidence is linguistically matched — consistent with (but not proof of) I3. Then
  H6's hijack was mostly the salience confound and the format-authority experiment is low priority.
- **NO STRONG CHANNEL PREFERENCE DETECTED** — `0.40 ≤ p ≤ 0.60` **AND** neither `PP` nor `RR`
  dominates. This is *not automatically* "peer evidence": the pair table says which of true peer
  treatment / weak stochastic preference / **unresolved value bias** / underpowered it is. If not
  value-bias-dominated → the driver does not infer Primary-authority from the format →
  **format-authority experiment is warranted.**
- **RELATED-CHANNEL DOMINANT (inversion)** — `p ≤ 0.20` **AND** `RR` dominant **AND** value bias
  does not dominate. A strong defect → format-authority experiment is **urgent**, and may not be
  fixable by labeling alone.
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
- **Cosine alignment (MEASURED and ENFORCED — GPT audit #1/#8/#9):** the audit *measures*
  `cos(T(X), Q)`, `cos(T(Y), Q)`, `|Δ|` (via the local embedder) and writes them into each
  fixture's audit object — no `null` placeholders, and no asserting the property the audit exists
  to check. A case whose `|Δ|` **exceeds the preregistered bound is QUARANTINED, not repaired**
  (repairing values after seeing the number is the post-hoc tuning we're avoiding): it is excluded
  from the main channel estimate and reported with its measured Δ. **Held-out** cases may exceed
  the bound and are kept as reported stress cases (never folded into the main estimate).
  - **Proposed bound `|Δcos| ≤ 0.05`** — rationale: the two answer-sentences differ by exactly one
    meaningless pseudo-word; query-alignment must come from the shared template, so swapping the
    value may not shift query-cosine by more than ~0.05 or the value is itself carrying
    query-alignment (an asymmetry). On the built corpus this quarantines `held-procedure`
    (|Δ|=0.087, held-out — fine) and in-pool `drawer-lining` (0.057), `ink-color` (0.056),
    `envelope-code` (0.051). **This bound is a PROPOSAL, frozen only on GPT/Samuel sign-off** — set
    from the construction rationale, not to hit a case count; the full 24-case distribution is on
    the table for that decision. (Consequence: quarantining ~3 in-pool cases leaves the in-pool set
    near the 15-minimum floor with no headroom → likely add ~4 symmetric in-pool cases; also a
    freeze-time decision.) Cosine equality is *supporting* evidence — the shared template +
    counterbalancing do the heavy lifting; cosine ≠ salience equality; this backstops the template.
- **Randomization balance (audited):** across the corpus, X/Y assignment, template families,
  value lengths, and held-out structure must each be balanced — no stupid asymmetry (e.g. "all
  the odd values happen to be X in α") hiding in the fixtures.

## Joint-derivation audit — C4 (GPT audit #7; same discipline that saved H4)

Span-absence (the mechanical checker's C1) is not enough. For **every** fixture, a structured
`derivation_audit` object asks, separately for **X** and for **Y**: *could this value be
reconstructed from the full non-answer context (primary distractors + prior turns + world
knowledge), without ever seeing the answer-sentence?* The object enumerates the derivation paths
and carries a mark per path:

```
Q → { lexical_cue, semantic_cue, synonym_alias, anaphora,
      composition_of_memories, world_knowledge, numeric_pattern } → X?   (same for Y)
mark ∈ { impossible | possible | derivable }
```

- The **author** (harness build) fills a first pass; the **reviewer (GPT)** marks the paths —
  this is not machine-judgeable, exactly like the H6 Stratum-1 five-channel audit.
- **Rule:** if any path is genuinely `possible` (let alone `derivable`), the case is **dropped**,
  not argued about — we do not litigate whether qwen *might* make the inference. Drop it.
- The static checker verifies the object's **shape** and re-confirms C1 (literal span absence); it
  does **not** pretend to judge derivability.
- Cases flagged for this first: `held-anaphora` (can the value be resolved from the shared scene /
  prior turn?), and any case whose distractors compositionally point at one value.

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

- **2026-09-10 — v2, after GPT's fixture audit (do-not-run-yet, 10 changes).** GPT audited the
  built branch corpus and returned a strong *don't run yet*. Three of its ten asks were **already
  satisfied** in Grok's harness and are now named explicitly rather than re-implemented: value-bias
  is a first-class outcome (#3); `p` is already `primary/(primary+related)` with abstentions out of
  the denominator = GPT's valid-choice channel rate (#4); `validity_rate ≥ 0.80` is GPT's decision-
  coverage gate (#4). Adopted/changed:
  1. **Pair-level statistics are the headline** — `channel_consistency_rate = (PP+RR)/analysis_n`
     and `primary_following_rate = PP/(PP+RR)`; pooled `p` demoted to secondary cross-check (#2).
  2. **A/A instrument control added** (AAx/AAy): both channels agree → must emit the shared value
     at ≥95% or the run is invalid; not part of `p` (#5).
  3. **Cosine MEASURED and ENFORCED by quarantine** (no `null` fields; over-bound cases excluded
     from the main estimate, not repaired; held-out may exceed and are reported). Proposed bound
     `|Δcos| ≤ 0.05` on a construction rationale — **frozen only on GPT/Samuel sign-off** (#1/#8/#9).
  4. **Value-symmetry audit expanded** beyond 1-token: real BPE token IDs (via `/tokenize`), shared
     substrings/affixes/n-grams, reference-lexical-list (real-word/name) flags; boring-symmetric
     pairs preferred; code-family "code-ness" scrutinized (#6/#10).
  5. **Structured C4 joint-derivation audit** per fixture (derivation graph, reviewer-marked, drop
     any `possible` case) — the discipline that saved H4 (#7).
  6. **Verdict language:** the label names the *measurement* — PRIMARY-CHANNEL DOMINANT / NO STRONG
     CHANNEL PREFERENCE / RELATED-CHANNEL DOMINANT — with I3 authority as a separate interpretive
     sentence; "80%" = strong observed preference, not "authority established."
  7. **Discipline reaffirmed:** don't repair fixtures after seeing numbers; keep held-out cases
     held out; freeze the corpus before generating, then run.
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
