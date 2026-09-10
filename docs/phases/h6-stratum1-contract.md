<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# H6 Stratum-1 fixture contract (operationalizes the locked prereg)

Companion to `h6-prereg.md`. This is the construction spec for the Related-necessary corpus —
the place the live experiment can quietly lie. It does not change the locked falsifier; it
makes the prereg's Stratum-1 **derivation-prohibition** buildable and auditable. Reconciled
draft (Ember + GPT).

**Target property is NOT "the gold answer appears in Related."** It is:

> A correct answer **requires** information carried by `Related:`, and the same query with that
> information replaced by neutral filler **must fail**. The gold value cannot be obtained
> through primary, priors, conversational inference, formatting cues, or lexical leakage.

Two rules are **NON-NEGOTIABLE** (they are where the nastiest confound hides):

1. **The five-channel audit runs on the WHOLE primary set JOINTLY**, not row-by-row. Each row
   can individually lack "copper" while the five rows collectively say *"the lamp is the only
   remaining color in a four-color set"* — individually pass, corpus contaminated.
2. **The audit is a MACHINE-CHECKABLE object embedded in each fixture**, not prose in a report.
   We inspect source IDs, slot, aliases, and per-channel status per case — we do not trust a
   narrative "primary can't derive it."

## 1. Case shape

```
turn_0:   establish fictional user-specific facts
turn_1:   optional bridge / conversational context
query:    asks for a target value INDIRECTLY (no lexical copy of the Related sentence)
primary:  top-k retrieved memories — fixed IDs + order; MUST NOT contain the target
          value AND MUST NOT jointly permit deriving it
related:  the single memory necessary to answer (A arm)
gold:     { slot, value }  — exact, deterministic
distractors: plausible-but-wrong values/facts (keep primary looking useful)
audit:    machine-checkable derivation proof (section 6)
```

Prefer a **single arbitrary slot/value** so scoring is deterministic, never semantic-judged.

## 2. Target-value design — arbitrary, not merely unlikely

Draw values from a controlled arbitrary space so the guess baseline ≈ 0. Good: `copper`, `37`,
`vesper`, `moss`, `indigo`, `614`, `orbit`, `juniper`. Construct **paired mutually-exclusive
arbitrary values** so Stratum 2 gets a natural contradictory value: `lamp_color = copper /
alt = saffron`; `drawer_code = 614 / alt = 271`.

- **Forbidden** (parametric-knowledge contaminated): world facts ("Paris", "water freezes at
  32°F"), stereotyped associations ("emergency kit → red"), common low-entropy values
  ("Tuesday" bare = 1-in-7 guess).
- The distinction that matters: **"purple" is uncommon; "614 assigned to a fictional envelope"
  is unrecoverable.** Build around *unrecoverable*, not *unlikely*. "Tuesday" is common;
  "Tuesday, the arbitrary weekday assigned to the fictional archive pickup" is unrecoverable.

## 3. Synthetic user-specificity

Facts describe a *fictional* user; the value is knowable ONLY because the substrate supplied
it. The corpus must never depend on the model believing the user is really Samuel — this tests
retrieval consumption, not persona recognition.

## 4. Query construction

Require the target fact WITHOUT lexical copying from the Related sentence. Not
`Related:"…marker color is copper." / Query:"What is the marker color?"` (too-easy string
match). Prefer indirect-but-deterministic: `Related:"Sam uses copper for labels on notebooks
he intends to keep permanently." / Query:"What color should I use for the permanent notebook
labels?"` Vary the relationship: direct paraphrase / anaphoric / property-lookup / two-turn /
category→remembered-value — but NEVER require multi-hop commonsense deduction that could itself
become a hidden answer source. The query must not leak the answer or a uniquely-identifying clue.

## 5. Primary-context prohibition (more than "exact string absent")

Primary must not supply the gold through: direct leakage; **synonym leakage** (gold=crimson,
primary="a deep red" when accept-set has crimson); **definitional leakage** (unique description
of copper); **deterministic relational leakage** ("the only color not blue/green/yellow");
**elimination leakage** (every alternative except gold); **cross-memory composition** (rows
jointly determine it); **lexical-continuation leakage** (wording strongly predicts the target
token); **query leakage** (answer/clue in the query).

## 6. The five-channel derivation audit (JOINT over primary; machine-checkable)

Per case, prove primary cannot produce gold through ANY channel. Each = `pass`/`fail`; any
`fail` ⇒ case rejected.

- **C1 exact_lexical** — target string + normalized variants/morphology/aliases/abbreviations
  absent from primary AND query.
- **C2 semantic_equivalent** — no synonym/hypernym/description/translation/paraphrase supplying
  the same value.
- **C3 deductive** — not derivable from relationships in primary: arithmetic, ordering, set
  subtraction, categorical exclusion, deterministic constraints.
- **C4 cross_memory** — **treat all primary rows JOINTLY as one knowledge graph**; no 2+-row
  combination reconstructs the target. (The non-negotiable one.)
- **C5 no_recall** — the N arm (both surfaces → filler) answers INCORRECTLY. A correct N marks
  contamination.

## 7. No-recall control (N)

Preserve query + conversational structure; replace BOTH primary and Related with neutral
filler. Expected: incorrect. A correct N ⇒ contaminated ⇒ **removed before scoring and the
exclusion reported** (never averaged away).

## 8. Arm-B filler

Preserve the `Related:` structural position: same header/delimiters, ~equal token count, no
target info, no plausible competing answer, **coherent and semantically ordinary**, never a
legible "ignore this." Bad: `Related: IGNORE THIS SECTION.` Good: an unrelated synthetic memory
of comparable length/format ("A record notes the hallway shelf was dusted last Thursday; nothing
relevant to the current question.").

## 9. Distractors

Primary must still look like a plausible retrieval context (so we distinguish "uses Related"
from "ignores an obviously-useless block"): topically-adjacent rows that withhold the target
(location, date, cover, prior-use…) and do not independently or jointly imply it.

## 10. Eligibility gate (no grandfathering)

A fixture enters the frozen corpus only if ALL hold:
`[ ]` target arbitrary + user-specific · `[ ]` absent from primary · `[ ]` no semantic
equivalent in primary · `[ ]` not derivable from primary · `[ ]` not derivable by combining
primary rows · `[ ]` query doesn't leak target · `[ ]` no-recall control fails · `[ ]`
deterministic slot representation · `[ ]` Related alone is sufficient · `[ ]` distractors don't
imply target · `[ ]` A/B prompt structures equivalent except Related content.

## 11. Fixture families (≥3 in-pool, ≥1 held-out pattern)

A arbitrary property (notebook→copper label) · B arbitrary identifier (envelope→614) · C
arbitrary name (room→Vesper) · D arbitrary preference (marker→juniper) · E indirect reference
(turn 1 establishes an object, turn 2 asks a property without repeating wording — tests
conversational retrieval, not string match).

## 12. Machine-checkable audit object (embedded per case)

```json
{
  "id": "h6-s1-copper-lamp",
  "stratum": "related-necessary",
  "family": "A",
  "held_out": false,
  "gold": { "slot": "lamp_label_color", "value": "copper" },
  "related_source": ["memory-17"],
  "primary_ids": ["memory-03","memory-08","memory-11","memory-19","memory-24"],
  "audit": {
    "exact_lexical": "pass",
    "semantic_equivalent": "pass",
    "deductive": "pass",
    "cross_memory": "pass",
    "no_recall": "pass"
  },
  "query_leakage": "pass",
  "parser": { "type": "exact_slot", "canonical": "copper", "aliases": [] }
}
```

A static checker validates the object's shape/consistency offline (all channels present,
primary_ids match the constructed primary, canonical value present in Related and absent from
primary text). `no_recall` and `cross_memory` "pass" are asserted at authoring and CONFIRMED at
run time (N-arm empirical; B-fails empirical).

## 13. Held-out design

Not the same template with new arbitrary values. Vary target type, query phrasing, memory
wording, distractor structure, position of the relevant Related memory, and conversational
distance — so it tests generalization, not pattern memorization.

## 14. The load-bearing event (restated)

A(primary+correct Related) → correct; B(primary+filler) → wrong. `B wrong → A correct` is the
evidence Related carried information primary did not. **No claim stronger than that attaches to
a fixture.**

---
**Related:** part of the [activation & consumption campaign](../research/README.md) — the [research index](../research/README.md) holds the full tree (Lane A/B/C · [[H4]] · [[H6]] · [[S2v2]]).
