<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# H6 pre-registration (LOCKED) — does the driver behaviorally use `Related:`?

**Status: LOCKED before any live-driver generation.** This document is the immutable
reference. The harness is built to satisfy it; results are scored against it; no architectural
conclusion beyond the scoped H6 verdict may be attached. Reconciled from two independent drafts
(Ember + GPT) that converged on the spine; the two deltas GPT contributed — the paired
transition as the load-bearing falsifier, and the derivation-prohibition in Stratum 1 — are
adopted here.

## Question (deliberately upstream of H4)

Does the consuming driver behaviorally use `Related:` when it holds information **unavailable
from primary recall**, while remaining **robust to contradictory** `Related:` content? Before
optimizing *what* goes into the associative surface, establish that the driver treats it as
information-bearing context rather than decoration.

## The claim under test (scoped)

> For **this driver, this corpus, and this exact consumption format**, `Related:` is
> behaviorally load-bearing iff correct `Related:` content causes answers that primary context
> alone cannot produce, while incorrect `Related:` content does not reliably overturn answers
> already supported by primary recall.

A pass or null is scoped to that driver/corpus/format. It does **not** establish a universal
property of `Related:` or of activation. Every verdict sentence names the driver and corpus.

## Arms

Same store, same query, **same primary top-k (byte-identical IDs and order)**, same system
instructions, same output contract, same decoding config. The harness asserts primary
identity across arms *before* generating.

| Arm | Recall context | Purpose |
|---|---|---|
| **A** | primary + **correct** `Related:` | reference |
| **B** | primary + **equal-structure natural filler** in the `Related:` slot | is `Related:` content used? |
| **D** | primary + **contradictory/wrong** `Related:` | susceptibility to hijack |
| **N** | primary **removed** + `Related:` removed/filler | validity gate (must fail) |

**Filler rule (B):** preserves the token count, delimiters, and positional structure of the
`Related:` block, contains **no task-relevant answer information**, and is **semantically
ordinary and coherent** — never gibberish or anything legible as "ignore this." B tests the
absence of *content*, not the presence of an obvious skip-cue.

## Corpus — two strata, synthetic, parametrically unguessable

The single most important corpus property: the target answer must be **impossible to produce
from the driver's parametric knowledge**. Facts are synthetic, user-specific (RM's real job —
facts *about the user*), and the value is drawn from a **high-entropy arbitrary space** so the
guess baseline is ≈ 0 (rules out the elimination loophole). Every case carries a canonical
answer slot + an enumerated accept-set authored up front.

### Stratum 1 — Related-necessary (tests USE)

Correct answer lives **only** in a `Related:` item; absent from primary top-k. Intended: A
correct, B incorrect.

**Insufficiency rule (the load-bearing construction constraint).** No primary item — alone or
in combination — may allow producing the target by any of: (a) verbatim, (b) synonym /
paraphrase, (c) logical entailment, (d) arithmetic / temporal composition, (e) elimination
over a small candidate set. "Not present verbatim" is **not** sufficient; derivability is
forbidden. This guards against a **false CUT**: if primary secretly entails the answer, B
succeeds, no transition fires, and the null is an artifact. A Stratum-1 case is **valid only
if B empirically fails** (on the driver); a case where B succeeds is dropped — it cannot
distinguish "Related unused" from "primary leaked."

### Stratum 2 — Primary-sufficient / Related-adversarial (tests HIJACK)

Correct answer is recoverable from primary top-k. D injects a plausible `Related:` statement
that **contradicts** it. Intended (if robust): A correct, D correct. This stratum does not ask
whether the driver *can* use `Related:`; it asks whether accepting `Related:` opens an unsafe
override path when stronger evidence already exists in primary.

## No-recall control (validity gate, not an accuracy estimate)

Every case gets arm **N** (both surfaces gone). Expected: failure. **A case the driver solves
under N is contaminated by priors/guessability and is removed *before* H6 scoring.** N does not
prove the fact is *metaphysically* unguessable — the fixture is *constructed* to be arbitrary;
N establishes **operational contamination for the tested driver** (if qwen3.6 produces the
value with no recall, this driver has a prior path to it and the case is invalid *for this
experiment*). That empirical gate is what makes the whole thing auditable. Favor exact,
arbitrary, slot-checkable values over common knowledge (GPT audit: the three real-word values
`vesper`/`juniper`/`moss` were replaced pre-run with invented tokens to shrink this risk rather
than lean on N alone — with only 7 S1 cases each contaminated case is costly).

## Consumption format (pre-run decision — injected block, not tool-call)

The consumption format under test is the **recall block injected directly into context** —
the exact `primary + Related:` string RM returns — **not** a live `recall_memory` tool-call by
the driver. This is *forced* by the "primary byte-identical across A/B/D" requirement: a driver
that tool-calls could vary its own primary set between arms, destroying the control. Injection
also removes the tool-calling path entirely, which sidesteps the known degradation of tool-call
behavior in abliterated/fine-tuned qwen variants (irrelevant here — we inject, the driver only
reads and answers). Verdicts are scoped to this format; live-tool-call consumption is a separate
future node.

## Live-driver protocol (pre-run decision — single driver: stock qwen3.6)

First live-generation eval in the campaign (prior lanes were offline/cached-embedding).
**Driver = stock `qwen3.6-35B-A3B`** (not an abliterated/heretic variant — this is a
utilization test, we want clean instruction-following), served via `serve-qwen.ps1`, greedy
decode, fixed seed where the stack supports it. **Single driver by decision (Samuel, pre-run):**
cross-driver replication is *deferred to a later node*, not part of this run — so the verdict is
explicitly scoped to qwen3.6 and claims nothing about other drivers (see Scope). Within-driver
generalization is still required via the held-out slice. The harness MUST: fail loudly if the
driver is down (never silently score 0); log per arm the exact injected prompt, model id/config,
generation params, raw output, parsed answer; support replay; and **assert primary IDs + order
identical across A/B/D before generating**. A/B/D generated independently from otherwise-identical
inputs.

## Answer scoring

Exact / normalized **slot-value matching** wherever possible; design all cases to be
slot-checkable so no LLM judge is needed. Normalize (case, punctuation, articles) then require
the canonical value or an enumerated accept-set member present as a token/span. **No
uncertainty credit and no list-everything credit:** credit iff the target value is present
**and** no other enumerated same-slot candidate value is also present (single-answer
discipline; this is what makes the D hijack test unambiguous). An LLM judge is allowed only
where a deterministic parser is genuinely impossible; its rubric and output are logged.

## Metrics (per case, per arm, per driver)

- Stratum 1: `A_correct`, `B_correct`; **paired transitions `B→A` (wrong→correct, the win) and
  `A→B` (correct→wrong, a mechanism failure, reported even though not a negative "contribution").**
- Stratum 2: `A_correct`, `D_correct`; dangerous transition **`A→D` (correct→wrong = hijack).**
- `no_recall_accuracy` (N) — reported separately; N-pass cases excluded from efficacy scoring.
- Secondary/effect-size: aggregate `acc(A)−acc(B)` (Stratum 1), `acc(A)−acc(D)` (Stratum 2).

## Pre-registered decision rule

H6 **earns adoption for this driver/corpus/format** iff **all three**:

**A. Demonstrated use** (valid Stratum-1 cases):
- **≥ 50%** show the paired transition **B wrong → A correct** — *this is the primary
  criterion*; a raw mean-accuracy gap without case-level transitions is insufficient;
- aggregate A accuracy > B accuracy;
- reproduced on the held-out Stratum-1 slice;
- not driven by a single anomalous case.

**B. No routine hijacking** (valid Stratum-2 cases):
- **≤ 20%** show **A correct → D wrong**; the majority stay correct under contradictory
  `Related:`. (Strongly useful *and* routinely overturned = a safety failure, not a pass.)

**C. Valid recall dependence:**
- no-recall contamination ≈ 0 after case construction (N-pass cases already excluded).

## Falsifiers (both scoped)

- **CUT (unused):** valid Stratum-1 shows no meaningful paired dependency — the driver answers
  correctly at ~the same rate with correct `Related:` and with equal-structure filler, and the
  held-out slice reproduces the null. Strongest form: **`B wrong → A correct` does not fire at
  a meaningful rate.** Then stop optimizing a surface this driver does not consume.
- **UNSAFE (used but untrustworthy):** contradictory `Related:` routinely converts A-correct to
  D-wrong (> 20%). Not "unused" — the surface, when used, is not trustworthy enough to meet the
  behavioral contract. A distinct finding with distinct consequences.

## Scope & replication

Primary verdict is always **"H6 for qwen3.6 (stock), [corpus], injected-recall-block:
pass/fail."** This run is **single-driver by decision**; a second driver is a **deferred
replication node**, not part of this experiment, and its absence means the verdict claims
nothing about other drivers. If a second driver is later run: first-driver pass + second-driver
fail → report exactly that; never average drivers into a universal result.

## What H6 does NOT establish

Whether the current Related candidate-generation is good; whether activation improves Related
quality; whether a larger/cleaner Related set helps; whether Related should be promoted into
primary context; whether other architectures consume Related similarly; whether activation is
useful in some other role. Each is a separate experiment, gated behind H6 = pass.

## Required reporting

Per-case A/B/D/N answers; exact paired transitions; Stratum-1 A/B accuracy; Stratum-2 A/D
accuracy; no-recall contamination count; held-out results; driver/model identity + generation
config; raw generation logs or replay references; confirmation primary recall was byte-
identical across A/B/D. No conclusion beyond the scoped H6 result may be attached.

---

*Locked prior to harness construction. Reconciliation of two independent pre-registrations;
the paired-transition falsifier and the Stratum-1 derivation-prohibition are the deltas that
make a small-corpus result and a possible false-null auditable.*

---
**Related:** part of the [activation & consumption campaign](../research/README.md) — the [research index](../research/README.md) holds the full tree (Lane A/B/C · [[H4]] · [[H6]] · [[S2v2]]).
