<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Samuel Jackson Grim
Co-authored-by: Ember <emberkindled@gmail.com>
-->

# S2v2 build notes — harness + fixtures (STOP before live)

Instrument for the locked prereg (`docs/phases/s2v2-prereg.md`). **No live
driver was contacted.** `--live` is implemented and gated. Fixtures are
frozen for GPT audit before any qwen token.

## What shipped

| File | Role |
|---|---|
| `eval/corpora/s2v2.jsonl` | 24 cases (18 in-pool + 6 held-out). `kind: "s2v2"`, `gate: false`, no `expect`. |
| `eval/s2v2-parse.js` | X / Y / neither. Reuses H6 `hasSpan` + `hasHedge` verbatim. |
| `eval/s2v2-run.js` | α/β/N assembly, masked byte-identity, pair-class 2×2, validity accounting, `--live` gated. |
| `eval/s2v2-audit-check.js` | Mechanical vs author-asserted split; optional cosine (embedder if up). |
| `eval/s2v2-selftest.js` | Wired into `test.js` (sync + async). |
| Isolation | `eval/run.js` `isGoldenCase` skips `kind === "s2v2"`; `eval/measure.js` skips the corpus the same way it skips H6. |

In-pool families (3 each): `color` / `name` / `code` / `marker` / `tag` / `lining`.
Held-out (fresh template/structure, not in-pool paint): `heldout-callsign`
(circumlocution + answer_index=0), `heldout-tab` (two-turn + last-row answer),
`heldout-procedure` (imperative `Pull {value} for this task.` + 4 distractors),
`heldout-anaphora` (query `it` bound by turn_0), `heldout-stencil` (mid-sentence
value + answer_index=0 + 4 distractors), `heldout-radio` (log-phrase + near-last
answer).

Randomization tallies (mechanical): n=24, held_out=6, x&lt;y=12 / x&gt;y=12,
value_chars {5:8, 6:9, 7:7}, in-pool families 3 each.

## Gate output (real, this build)

```
node test.js
618 passed, 0 failed
```

```
node eval/run.js
TOTAL: 27/31 checks passed
SqliteStore scorecard matches golden case-for-case.
No regressions vs golden.
```

Golden did not move. This slice does not touch the recall path.

```
node eval/s2v2-run.js --assemble-only
Masked-identity assertion held on 24 fixtures (α/β differ only by the swapped value). No generation.
```

```
node eval/s2v2-run.js
S2v2 harness checkpoint: live driver is gated until fixtures are GPT-audited.
Loaded 24 fixtures. Driver was not contacted.
```

```
node eval/s2v2-audit-check.js
S2v2 audit-check: 24 fixtures  held_out=6  mechanical_fail=0  balance_fail=0
  RANDOMIZATION BALANCE:
    n=24  in_pool=18  held_out=6
    in-pool families=["color","name","code","marker","tag","lining"]
    held-out families=["heldout-callsign","heldout-tab","heldout-procedure","heldout-anaphora","heldout-stencil","heldout-radio"]
    value_chars={"5":8,"6":9,"7":7}  x<y=12  x>y=12  x=y=0
    answer_index={"0":2,"1":1,"2":18,"3":1,"4":1,"5":1}
    PASS  no gross skew
  COSINE (optional; not a hard-fail — cutoff frozen at human/GPT audit):
    embedder=http://localhost:1234/v1/embeddings  model=text-embedding-nomic-embed-text-v1.5
    sorted worst |Δ| first:
    0.0867    s2v2-held-procedure  cos(T(x),Q)=0.5347  cos(T(y),Q)=0.4480
    0.0570    s2v2-drawer-lining  cos(T(x),Q)=0.7829  cos(T(y),Q)=0.7259
    0.0561    s2v2-ink-color  cos(T(x),Q)=0.7146  cos(T(y),Q)=0.7707
    0.0511    s2v2-envelope-code  cos(T(x),Q)=0.6775  cos(T(y),Q)=0.6264
    0.0484    s2v2-crate-code  cos(T(x),Q)=0.6258  cos(T(y),Q)=0.6742
    0.0330    s2v2-garden-name  cos(T(x),Q)=0.7112  cos(T(y),Q)=0.6782
    0.0324    s2v2-shelf-tag  cos(T(x),Q)=0.6799  cos(T(y),Q)=0.7123
    0.0319    s2v2-held-callsign  cos(T(x),Q)=0.5242  cos(T(y),Q)=0.4923
    0.0246    s2v2-calendar-marker  cos(T(x),Q)=0.7215  cos(T(y),Q)=0.7461
    0.0228    s2v2-case-lining  cos(T(x),Q)=0.6858  cos(T(y),Q)=0.6630
    0.0215    s2v2-printer-name  cos(T(x),Q)=0.7208  cos(T(y),Q)=0.6993
    0.0207    s2v2-archive-color  cos(T(x),Q)=0.7352  cos(T(y),Q)=0.7559
    0.0186    s2v2-gate-code  cos(T(x),Q)=0.6354  cos(T(y),Q)=0.6540
    0.0173    s2v2-held-radio  cos(T(x),Q)=0.6529  cos(T(y),Q)=0.6701
    0.0100    s2v2-keybox-lining  cos(T(x),Q)=0.6827  cos(T(y),Q)=0.6728
    0.0086    s2v2-hook-tag  cos(T(x),Q)=0.6743  cos(T(y),Q)=0.6657
    0.0069    s2v2-packing-marker  cos(T(x),Q)=0.7310  cos(T(y),Q)=0.7379
    0.0056    s2v2-label-color  cos(T(x),Q)=0.7212  cos(T(y),Q)=0.7156
    0.0054    s2v2-bin-tag  cos(T(x),Q)=0.6526  cos(T(y),Q)=0.6580
    0.0050    s2v2-held-stencil  cos(T(x),Q)=0.7022  cos(T(y),Q)=0.7073
    0.0037    s2v2-room-name  cos(T(x),Q)=0.5984  cos(T(y),Q)=0.5948
    0.0015    s2v2-held-tab  cos(T(x),Q)=0.6674  cos(T(y),Q)=0.6659
    0.0009    s2v2-held-anaphora  cos(T(x),Q)=0.6399  cos(T(y),Q)=0.6408
    0.0008    s2v2-grocery-marker  cos(T(x),Q)=0.6613  cos(T(y),Q)=0.6604
All fixtures passed mechanical checks. values_arbitrary + n_unguessable remain author-asserted.
```

The embedder at `:1234` **was up**. Cosine is a read-only audit (allowed). I did
**not** write the numbers back into the jsonl (fields stay `null` until you freeze
a cutoff). I did **not** contact `:8080` or `:1234` for text generation. I did
**not** retune any pair after seeing a delta — that would be the salience
confound in a new costume.

## What the checker verifies MECHANICALLY

Printed per case under `MECHANICAL (this checker)`:

- Audit-object shape (`values_arbitrary`, both justifications, absence flags,
  `template_shared`, `n_unguessable`, `value_symmetry` keys, cosine left null).
- `kind: "s2v2"`, `gate: false`, no `expect` (golden-path tripwire).
- Template contains exactly one `{value}`; no privileging-adjective regex
  (`unusual` / `correct` / `true` / `authoritative` / `stale` / …).
- x ≠ y, neither is a span of the other.
- x,y lexically absent from distractors, query+turns, and N surfaces.
- `primary_ids` equals constructed order (distractors with answer row spliced
  at `answer_index`).
- Related id is not a primary id.
- Value symmetry: chars, whitespace-tokens, and caps **recomputed** and must
  match the recorded fields AND match each other. `lexical_class` is present
  as a tag, not judged.
- Distractors are 4–5 id+text rows; not skip-cues.
- Corpus balance: n=24, held_out≥5, family/length/x-vs-y assignment, unique
  value tokens, held-out family tags do not reuse in-pool names.

A planted leak with `values_absent_from_distractors: true` still fails. That
is the point.

## What remains AUTHOR-ASSERTED (GPT + live)

Printed per case under the two `AUTHOR-ASSERTED` blocks. The checker **will
not** score these:

| Claim | Who confirms | What it actually means |
|---|---|---|
| **values_arbitrary** (per-value justification) | GPT | Invented / prior-free? A world-knowledge, name-class, or brand prior is contamination. Mechanical absence from the fixture is not prior-freeness. |
| **n_unguessable** | live N-arm | Both x and y must fail under N. N→X / N→Y / N→neither is recorded; an N pick is a token prior and the case is dropped from the analysis population. |
| **word-piece equality** | GPT (or a real tokenizer) | Checker only recomputes **whitespace** tokens + character length. True BPE/word-piece count for qwen's tokenizer is not available offline. |
| **lexical_class** | GPT | Author tag (`invented-name`). Not a semantic judge. |
| **joint non-entailment of the value from distractors** | GPT | Same job as H6 C2/C3/C4: the primary block as a knowledge graph must not reconstruct x or y. Mechanical span-absence is C1 only. |
| **template does not privilege the value position by subtle framing** | GPT | Regex catches `unusual`/`correct`/…. It will not catch a template that is "more answer-shaped" in some other way. |
| **held-out is structurally fresh enough** | GPT | I varied template syntax, answer_index, turn count, and row count. Whether that is *enough* generalization is a review call. |

### Weak / ambiguous cases — second eye please

I did **not** tune these toward a channel. I flagged them instead of running
the model.

1. **`s2v2-archive-color` x=`sorin`.** Sorin is a real Romanian given name.
   For a *color* slot that is probably fine (nobody's favourite archive
   colour is a Romanian name), but a name-class prior is exactly what N is
   for. GPT: is the *name class* too guessable even on a colour query?
2. **`velka`.** Close to Czech/Slovak *velká* ("great"). Same class of worry.
3. **`s2v2-held-stencil` `yulka` / `porin`.** Yulka is a Slavic diminutive;
   porin is a real protein name. Unlikely query-relevant; still a prior.
4. **`s2v2-held-procedure` cosine |Δ|=0.0867** (worst in the corpus).
   Template is short (`Pull {value} for this task.`), so the value token is a
   large fraction of the embedding. Shared template + α/β still neutralize
   *channel* salience; they do not neutralize a *token-shape* embedding
   prior. If you freeze a max-delta cutoff below ~0.08, this case is the
   first to drop — or rewrite the template longer, don't swap the values
   post-hoc to chase a smaller Δ.
5. **`code` family** (`envelope` / `gate` / `crate`). Query says "code";
   values are invented names, not digits. N-arm should catch a digit-guess.
   GPT: is "code" + a name-like token a format clash that drives abstention
   (validity) rather than a channel pick?
6. **`s2v2-held-anaphora`** shares the wooden-key-box scene with
   `s2v2-keybox-lining`. Structure is the variant (anaphoric `it`); the
   household is not. If held-out must also be a fresh *world*, say so and
   I'll restage it.
7. **In-pool `answer_index=2` on all 18.** Deliberate: position is the
   channel, so the in-pool control keeps it fixed; held-out varies
   {0,1,3,4,5} plus two 4-distractor blocks. Do not read the 18/24
   concentration as a randomization bug.

## Disagreements / underspecification (did not silently resolve)

1. **Validity floor vs N-arm.** The brief says 80% of "planned arm
   generations" must yield a valid X/Y answer. N is *not supposed* to yield
   X/Y — a working N-gate is 24× `neither`. Counting N as an invalid arm
   would make a clean unguessability result look like a 33% validity miss.
   **Validity floor is over α/β only** (48 planned channel arms). N is a
   separate contamination gate. This is the reading that preserves the
   prereg's N design. If you meant 80% of α/β/N including N-neither as
   "valid," say so — I will not implement a floor that punishes the N-gate
   working.

2. **Analysis population = pair-complete ∩ N-clean.** The brief says
   pair-complete is the analysis population. The prereg also says a case is
   admissible only if both x and y fail N. I compute pair-class two ways:
   raw (incl. invalid pairs) and `pair_class_n_clean` (N-prior dropped,
   reported as `n_prior_ids`). Decision rule reads the N-clean 2×2.
   Invalids are never silently dropped from the log.

3. **"Dominant" was not defined.** I operationalized:
   - PP dominant ⇔ `PP > RR` and `PP > 0`
   - RR dominant ⇔ `RR > PP` and `RR > 0`
   - value-bias dominates ⇔ `(XX+YY) ≥ max(PP,RR)` and `(XX+YY) > 0`
     (a tie is *not* a clean channel result — conservative, lands in
     value-biased / inconclusive rather than honored/inverted)
   - PEER requires `0.40 ≤ p ≤ 0.60` AND neither PP nor RR dominant AND
     value-bias does not dominate (the prereg's explicit anti-masquerade)
   If you wanted "dominant" = plurality of all four cells, or `PP > 50%`
   of pair-complete, the bands move. This is the version in
   `applyDecisionRule`; selftests pin it.

4. **Driver URL default is `:8080`, not H6-run.js's `:1234`.** Prereg and
   the H6 live log agree the stock qwen is on llama.cpp `:8080`.
   `h6-run.js` still defaults to LM Studio `:1234` (the live run overrode
   it). Brief said "default the h6 values"; I judged the *actual H6 live
   driver* the right default, overridable with `S2V2_DRIVER_URL`. This
   build did not contact either port for generation.

5. **System prompt is H6's full text**, not the prereg's three-sentence
   excerpt. Extra clauses: "You are answering one factual question about a
   fictional person's notes." and "Reply with a single slot value. Do not
   list alternatives." The first is identity-framing; the second is the
   parser contract. Neither names Primary as authoritative nor Related as
   secondary. Same format as H6 is the load-bearing constraint.

6. **`list-both` not H6's `list-everything`.** Brief named the reason
   `list-both`. Same discipline, different label, so a replay log cannot
   be confused with H6.

7. **Brief listed `{PP,RR,XX,YY,invalid}` "over pair-complete cases."**
   Invalid *is* the complement of pair-complete. I report invalid as its
   own count (validity accounting) and the 2×2 over pair-complete. Same
   content as the prereg's four cells.

8. **Cosine cutoff is not frozen by this build.** Embedder was reachable; I
   printed deltas worst-first and left jsonl `null`. Freezing a cutoff
   after seeing 0.0867 as the max would be the post-hoc the prereg forbids.
   You + GPT freeze it at audit time. A reasonable *proposal* (not a
   freeze): 0.10 would keep all 24; 0.06 would drop held-procedure +
   drawer-lining + ink-color. I am not proposing either as the lock.

## Failure signatures tested (selftest)

- Parser: X/Y match (case/punct/article); empty; absent; list-both;
  hedge (`maybe X`, `I think X`, `X, probably`, `X or something`); span
  not substring (`sorinex` ⊬ `sorin`).
- Pair-class: all four cells + invalid.
- Decision bands: honored / peer / value-biased / inverted / inconclusive;
  validity floor forces `inconclusive` even when the band would be honored.
- N-neither does **not** tank the validity floor.
- N-prior is reported and excluded from `pair_class_n_clean`.
- Planted x-in-distractor and x-in-query fail even if the audit field lies.
- Char-length mismatch fails.
- Masked-identity throws when a distractor is tampered between α and β,
  and when values did not swap.
- Stub driver never fetches; driver-down (throw / HTTP 503) is fail-loud
  (`S2V2_DRIVER_DOWN`), never a 0-score.
- Fixtures are not golden cases.

## What this slice did not do

- Did not call qwen / `serve-qwen.ps1` / any `/v1/chat/completions`.
- Did not pass `--live`.
- Did not drop or score a case against a live model.
- Did not tune a fixture after seeing a model output (there is none) or
  after seeing a cosine delta (there is a printout; the jsonl is unchanged).
- Did not change `golden.json` or the RM-00 case set.
- Did not add a fifth MCP verb.

Live run happens after GPT audits the fixtures.
