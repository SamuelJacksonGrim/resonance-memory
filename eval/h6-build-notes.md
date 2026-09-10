<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# H6 build notes — what is proven vs what needs GPT

Instrument for the locked prereg (`docs/phases/h6-prereg.md`) and the locked
Stratum-1 contract (`docs/phases/h6-stratum1-contract.md`). **No live driver
was contacted.** Fixtures are frozen for GPT audit before any qwen token.

## Corpus

| File | n | Role |
|---|---|---|
| `eval/corpora/h6-stratum1.jsonl` | 7 | Related-necessary. In-pool families A–E (5) + held-out structure variants (2). |
| `eval/corpora/h6-stratum2.jsonl` | 7 | Primary-sufficient / Related-adversarial. Paired alts of the same seven slots. |

Held-out is **not** A–E with new paint. `h6-s1-callsign-orbit` is
category→call-sign via circumlocution ("weekend shop that sells screws and
paint" ↔ "Saturday hardware-store run"). `h6-s1-tab-wren` is a two-turn
with an unrelated intervening turn (neighbor/fence) and a procedure query
("which tab") rather than a property copy.

Every case is `kind: "h6"`, `gate: false`, no `expect` — RM-00 / measure.js
must not ingest them. Isolation is also explicit in `isGoldenCase` and
`loadAllScenarios`.

## What `eval/h6-audit-check.js` verifies MECHANICALLY

Printed per case under `MECHANICAL (this checker)`:

- Audit object **shape**: all five channels present as `pass`/`fail`, plus `query_leakage`.
- `primary_ids` **equals** the constructed `primary` block (id + order).
- Parser well-formed (`exact_slot`, canonical non-empty, aliases is a string array, canonical matches `gold.value`).
- No `expect` field (golden-path tripwire).
- **C1 exact_lexical (S1):** canonical gold is a span in Related; gold and aliases are lexically **absent** from every primary row **and** from query+turns.
- **C1 (S2, inverted — see disagreement #1):** gold is a span in primary; gold absent from query+turns; A Related contains gold; D Related contains the mutually-exclusive alt and not gold; alt absent from primary and query.
- Query leakage (lexical half of C1).
- Enumerated distractors ≠ gold; `candidates` includes gold and alt.
- B filler contains neither gold nor any competing candidate; token count ~equal to Related; no skip-cue regex (`ignore this`, `nothing relevant`, …).
- N surfaces contain neither gold nor competing candidates.
- Author-asserted `fail` on any channel **rejects** the fixture (no grandfathering).

A planted leak with `audit.exact_lexical: "pass"` still fails the checker.
That is the point.

## What remains AUTHOR-ASSERTED (GPT + live)

Printed per case under the two `AUTHOR-ASSERTED` blocks. The checker
**will not** score these, even if they look easy:

| Channel | Who confirms | What it actually means |
|---|---|---|
| **C2 semantic_equivalent** | GPT | No synonym / hypernym / unique description / translation / paraphrase of gold in the **joint** primary. |
| **C3 deductive** | GPT | Not derivable by arithmetic, ordering, set subtraction, categorical exclusion, deterministic constraints. |
| **C4 cross_memory** | GPT **and** live B-fail | Whole primary as **one knowledge graph**. A 2+-row reconstruction is a broken case even if no single row leaks. Live B-succeeds drops the case for *this* driver; it is not a semantic proof. |
| **C5 no_recall** | live N-arm | Priors / guessability. Asserted at authoring; a correct N is contamination and is excluded before scoring. |

I marked every channel `pass` only where I believe it. If GPT disagrees on
C2/C3/C4, the honest move is `fail` and drop/fix — not a narrative patch.

## Weak / ambiguous cases — second eye please

These are the ones I would not defend without a second reader. I did **not**
tune them toward Related-win; I flagged them instead of running the model.

1. **`h6-s1-copper-labels` / S2 pair.** Query frame overlaps Related
   ("permanent" / "notebook" / "labels") more than the contract's
   "too-easy string match" ban, but it **is** the contract's own preferred
   example pattern. Gold (`copper`) is not in the query. Risk: the driver
   attends to Related because of frame overlap, not because it treats
   Related as information-bearing in general. Held-out cases exist so this
   cannot be the whole story.
2. **`h6-s1-room-vesper`.** `Vesper` is a pretty room-name prior. Primary
   never describes evening/star/chapel. N-gate is the empirical filter; GPT
   should still say whether the *name class* is too guessable.
3. **`h6-s1-marker-juniper` and `h6-s1-box-moss`.** `juniper` and `moss`
   are real-world color names. They are user-assigned here, not world
   facts, but a color-guessing prior is the contamination C5 exists for.
   `614` / `orbit` / `wren` are the stronger unguessable slots.
4. **`h6-s1-box-moss` anaphora.** Query is "What color lining should I buy
   for it?" with `it` bound by turn_0 (wooden box / spare key). That is
   family E on purpose. GPT: is turn_0 + primary jointly a unique
   description of a moss-lined box, or is the lining color still
   Related-only?
5. **`h6-s1-callsign-orbit`.** The query↔Related link is a paraphrase
   ("weekend shop that sells screws and paint" = "Saturday hardware-store
   run"). Contract forbids *multi-hop commonsense* as a hidden answer
   source. I think this is a one-hop paraphrase, not a deduction of
   `orbit`. Worth a hard look at C3/C4.
6. **S2 `related` restatements** are a different sentence from the gold
   primary row (RM Related excludes primary ids). If a restatement looks
   *more* answer-shaped than primary, D's contradiction might be the
   louder sentence, inflating hijack. That is a real S2 risk, not a
   fixture bug I hid.

## Disagreements / underspecification (did not silently resolve)

1. **C1-absent-from-primary vs Stratum 2.** The colleague brief states C1
   as "gold lexically absent from every primary row" for *all* fixtures.
   The locked S2 construction *requires* gold in primary. Applying S1 C1
   to S2 would make every S2 fixture illegal. Checker is stratum-aware:
   S1 = Related-only; S2 = gold in primary + alt in D. Flagged, not
   fudged.
2. **`A→B` naming.** Prereg lists `B→A` (wrong→correct, the win) and
   `A→B` (correct→wrong, a mechanism failure). Literal parentheticals
   describe the **same** 2×2 cell (A correct ∧ B wrong). I implemented
   McNemar off-diagonals: `b_to_a` = B wrong ∧ A correct (win);
   `a_to_b` = A wrong ∧ B correct (Related *hurt* vs filler). If the
   intent was to report A-correct-B-wrong twice under two names, say so
   — I will not duplicate a cell and call one of them a failure.
3. **Hedge scoring.** "No uncertainty credit" + "credit iff gold span
   present AND no other enumerated candidate." I did not add a hedge
   regex that would reject "maybe copper". Empty / "I don't know" fail
   because the span is absent. "copper or saffron" fails as
   list-everything. "maybe copper" with no alt **credits**. Documented
   in `h6-parse.js`.
4. **Coaching in the system prompt.** The harness tells the driver to
   use the injected recall block (numbered memories **and** any
   `Related:` section) without privileging either channel. Naming
   Related at all is a mild attend-cue; omitting it would be an
   ignore-cue. I chose "the block as RM returns it." GPT/Ember should
   confirm this does not bake in a use-Related instruction.
5. **B-succeeds drop is S1-only.** S2 B-succeeds is *expected* (primary
   already has gold). The brief said "drop N-pass and B-succeeds cases"
   without a stratum split. Dropping S2 B-succeeds would empty S2.
   S1-only is the reading that preserves the hijack test.
6. **`--live` is implemented and gated-off by default.** Bare
   `node eval/h6-run.js` does not contact the driver. I did not hard-
   disable `--live` (the next node needs it). This build did not pass
   `--live`.

## What this slice did not do

- Did not call qwen / `serve-qwen.ps1` / any `/v1/chat/completions`.
- Did not drop or score a case against a live model.
- Did not tune a fixture after seeing a model output (there is none).
- Did not change `golden.json` or the RM-00 case set.
- Did not add a fifth MCP verb.

Live run happens after GPT audits the fixtures.
