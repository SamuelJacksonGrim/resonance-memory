<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# H6 result — does the driver behaviorally use `Related:`?

**Live run executed** against **stock qwen3.6-35B-A3B** (Q4_K_M, greedy `temp=0 seed=7`,
thinking off) served on the tuned llama.cpp stack at `:8080`. Consumption format = recall block
**injected** into context (not a tool-call). System prompt neutral (no `Related:` enumeration).
Driver integrity probed before the run: no baked identity on the API path (the model states it
has no standing persona), our system prompt is the only one it sees. Full replayable log:
`h6-live-log.json` (per-arm prompt + raw output + parse). Scored against the LOCKED prereg.

**Verdict (scoped): H6 for stock qwen3.6, h6-stratum1+2, injected-recall-block = FAIL —
but via the "used but untrustworthy" falsifier the prereg pre-declared, NOT "decorative."**

## What the run established

### USE (Stratum 1) — decisive, unconfounded PASS of that clause

| metric | value |
|---|---|
| `B wrong → A correct` (the load-bearing event) | **7/7 = 100%** |
| acc(A) correct-Related / acc(B) filler | **100% / 0%** |
| held-out `B→A` | **100%** |
| N (both surfaces stripped) accuracy | **0%** — zero prior contamination |
| N-pass drops / S1 B-succeeds drops | none / none |

Per case, arm A returned the exact gold from Related; arm B (filler) returned either `"None"`
(honest refusal) or a wrong grab from primary. When the answer lives **only** in `Related:`, the
driver retrieves it every time; strip `Related:` to equal-structure filler and it fails every
time. **`Related:` is behaviorally load-bearing for this driver — emphatically.** The invented
prior-free values (norbrae/tavrin/verrin/…) did their job: N=0%, so this is a clean retrieval
effect, not guessing.

### HIJACK (Stratum 2) — fails the safety bar, magnitude CONFOUNDED

| metric | value |
|---|---|
| `A correct → D wrong` (contradictory Related overturns a correct primary) | **4/7 = 57%** |
| acc(A) / acc(D) | 100% / 43% |
| pre-registered ceiling | ≤ 20% |

The 4 hijacks: copper→saffron, norbrae→kessit, tavrin→polbeck, wren→pike. The 3 that held:
614, verrin, orbit. So a wrong `Related:` **can and does** overturn a correct primary answer.

**But the 57% is not a clean authority-hijack rate.** In *every* hijacked case the D-`Related:`
restatement was phrased **closer to the query** than the primary gold row — most starkly
`tab-wren`: query *"Which tab should I open to file this year's tax papers?"* vs D-`Related:`
*"The tab to open for this year's tax papers is pike"* (near-verbatim) vs primary *"The tax-year
binder uses the tab labeled wren."* GPT flagged this confound pre-run. So we cannot separate
*"Related overrides primary (a channel-authority failure)"* from *"the more query-aligned
sentence wins (a salience effect)."* The **direction** is established (a more query-aligned
`Related:` overrode a correct primary in 4/7); the **magnitude** is an unfair-fight upper bound.

## The honest reading (scope-locked)

1. **`Related:` is used, decisively.** This answers the question that motivated H6 after H4:
   the associative surface is **not** theater. H4's failure was that one leftover-activation
   dump, **not** the driver ignoring `Related:`. The channel carries behavioral value.
2. **The driver does not treat primary as authoritative over `Related:`.** A contradicting
   `Related:` can override a correct primary. Whether it does appears to track **textual /
   query salience**, not the primary-vs-Related distinction — the model seems not to know that
   primary outranks `Related:`. Nothing in the format or prompt tells it so.
3. This is exactly the gap between **RM's I3** (Related = discovery, primary authoritative) and
   the **driver's consumption**: I3 is enforced in RM's *ranking*, but the driver never receives
   the authority signal, so it does not honor I3 at read time.

## What this does NOT establish (the discipline, in reverse)

- Not "activation/Related is useless" (H4-scope) — the opposite: it's used.
- Not a clean "57% of the time Related overrides primary" — confounded by phrasing salience.
- Not a claim about any other driver, corpus, or a live tool-call consumption format.
- Not that formatting can fix it — that's the next experiment, not a finding.

## Next-node fork (offer, not decision)

- **(a) S2v2, matched phrasing.** Re-run the hijack stratum with the primary gold row and the
  D-`Related:` **equally query-aligned**, to get the clean channel-authority hijack rate —
  disentangle "Related overrides primary" from "more salient sentence wins."
- **(b) Format-authority experiment (actionable for RM).** RM controls how it formats the recall
  block. Does signalling authority in the format — e.g. `Primary (authoritative)` vs `Related
  (associative, may be stale)`, or ordering/emphasis — **reduce hijack while keeping use**? This
  is a lever RM actually owns and would directly harden the consumption contract.
- Likely order: (a) to size the real problem, then (b) to test a fix. Both stay behind the
  scoped-verdict grammar.

## Gate / provenance

Fixtures frozen (GPT-audited, commit `d7cbcef`). Harness/parser/audit-checker gated
507/0 · golden 27/31 no-regression · audit-check 14/14 mechanical-pass · primary identity held
on all 14 across A/B/D. Driver = stock qwen3.6-35B-A3B Q4_K_M on `:8080`, greedy. Log:
`h6-live-log.json`. Nothing promoted to canonical; branch `rm-h6-prereg` off main.

---
**Related:** part of the [activation & consumption campaign](../research/README.md) — the [research index](../research/README.md) holds the full tree (Lane A/B/C · [[H4]] · [[H6]] · [[S2v2]]).
