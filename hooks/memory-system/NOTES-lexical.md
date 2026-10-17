# Lexical recall fallback

Measured 2026-10-17 against Samuel's live memory folder (92 files) and the
live nomic embedder on `:1234`. Read-only on the folder. Query vectors
only — the document cache at `C:\Users\spamw\tools\memory-embeddings.json`
was reused, not rewritten.

Re-run: `node hooks/memory-system/eval-lexical.js`

## Why this exists

The semantic hook is quiet unless cosine >= 0.70. On a machine with no
local embedder that means silent on every message, so the memory system
looks dead. A tiny bundled embedder (transformers.js + MiniLM) is tens of
MB and an npm dependency; both are load-bearing no's for this repo. BM25
over the files themselves is the fallback that still ships as zero-dep
CommonJS. It is **not** mixed into cosine. Ranking stays cosine-only when
the embedder answers.

## Gate (locked in `lexical.js`)

Raw BM25 is not comparable across queries. The hook uses three relative
tests, not a magnitude cutoff:

1. At least two query terms match. A one-term query may fire only if that
   term is rare (df <= 2) **and** sits in the filename/description.
   Without this, "How's the process going?" dumped three Ember files
   because "process" is a title word (norm 1.78 on a single common term).
2. Length-normalised BM25 (`score / sum of query IDF`) >= **0.50**.
   At average document length the saturation of one occurrence is ~1, so
   this is roughly "half the query's IDF mass recovered". Title repeats
   can push a named file above 1 — that is the signal.
3. A 2nd/3rd hit must also clear **55%** of the top hit's raw score, so a
   dominant filename match is not padded with weak cousins.

YAML frontmatter is stripped from the body (keys like `name` /
`description` / `modified` otherwise sit in every file and collapse IDF).
The description still goes through the title field. CamelCase identifiers
keep both forms (`SoulReward` → `soul`, `reward`, `soulreward`).

## Numbers

90 prompts: the 10 held queries from the recall.js equivalence set, plus
80 unique user messages sampled (seed 20261017) from
`C:\Users\spamw\.claude\projects\C--Users-spamw\*.jsonl`. Skip tool
results, system reminders, slash/resume commands, and anything under 12
or over 1200 characters. 1791 eligible unique prompts in that folder.

Semantic hook fired on 34/90 (37.8%) at cosine >= 0.70.

Sweep excerpt (matched / norm / coverage → noise vs semantic-silent,
miss vs semantic-fired, top-1 / top-3 overlap when both fire):

| matched | norm | cov | noise | miss | both | top-1 | top-3 |
|---|---|---|---|---|---|---|---|
| 2 | 0.50 | 0.35 | 0/56 (0%) | 24/34 (70.6%) | 10 | 80% | 100% |
| 2 | 0.50 | 0.00 | **1/56 (1.8%)** | **24/34 (70.6%)** | **10** | **80%** | **100%** |
| 2 | 0.45 | 0.00 | 4/56 (7.1%) | 23/34 (67.6%) | 11 | 73% | 92% |
| 2 | 0.32 | 0.00 | 16/51* | — | — | — | — |

\*0.32 was the first candidate, measured before the one-term rare-df
rule and frontmatter strip; it injected on 31% of semantic-silent
prompts, including the wrong file on "how should I talk to Samuel when
he is upset and spiraling". Silence beats that.

**Shipped: matched=2, norm=0.50, coverage=0, relative=0.55.** Coverage
0.35 zeros the remaining 1 "noise", but that one is a real keyword catch
("open tab in chrome" → `browser-handsoff-warning`, norm 0.80) that
cosine left under 0.70. Keeping it is the point of a lexical fallback.
The other three 0.45-fires were a nonce distractor (0.48), a "never
updated" aside, and a copilot anecdote — all gone at 0.50.

Miss rate ~70% looks bad until you read the misses: they are paraphrases
with no lexical overlap (`upset`/`spiraling` are df=0 in the live
folder; `teaching-samuel-go-slow` is the semantic hit). Lexical cannot
invent those. Injecting the wrong file on that prompt was worse; the
gate now stays silent, which is what the product asked for.

When both fired, top-1 agreed 8/10 (80%) and every semantic name sat in
the lexical top 3 (100% overlap).

## Held queries (the equivalence set)

At the shipped gate:

| query | semantic | lexical |
|---|---|---|
| talk to Samuel when upset and spiraling | teaching-samuel-go-slow, hold-lines | silent (paraphrase; top lexical norm 0.30) |
| Koneko care stance / speech cortex | continuing-mind-controls, continuing-mind | same two |
| launch Talk to RFE-Core2 / pause | continuing-mind-controls | same, only that one (relative dropped the tail) |
| Resonance Memory false positive / warm field | rm-recall-two-gaps | same |
| Elden Ring regulation bin SoulReward | elden-ring-regulation-modding | same (norm 1.21 vs 0.21) |
| corpus worklist / which source | rfe-corpus-archaeology | encoder-plan then archaeology |
| commit from PowerShell using WSL git | wsl-git-from-powershell | same only (pi-emu was 0.86 vs 1.89) |
| TowerDef cold hell setting | towerdef-setting-cold-hell | that plus towerdef-unity-project |
| ComfyUI pony vtubing pipeline | local-image-gen | image-gen, vtuber, video-gen |
| nonce-7f3a9c2e do not deflate… | silent | silent at 0.50 (was 0.48 on windows-box) |

Keyword queries work. Paraphrase queries stay quiet. That is the
fallback we can defend.

## Hybrid (not shipped)

RRF of the semantic-gated names with BM25 top-10 (k=60) agreed with
semantic top-1 on 28/34 fires (82.4%). Cosine already picked that top-1.
Fusion cannot beat the ranker we are measuring against, and mixing it
in would violate ranking=cosine-only. Reported as a number, not a
ranker. Promote only on a measured A/B win, same rule as `proposed/0003`.

## Probe

Connection-refused is fast. A hung endpoint is not: the hook's embed
timeout is 6 s. Before embedding we GET `/v1/models` with a 400 ms
abort. Any HTTP response means the process is alive; hang or refused
means down. A down marker next to the vector cache (`*.embedder-down`)
skips the probe for 30 s so a dead LM Studio does not tax every
message. Injected embedders in tests skip the probe.

## Index cache

`{vector-cache}.lexical.json`, keyed by each live file's mtime + size
plus a format version. Missing cache, missing vector file, or a changed
file rebuilds from the markdown. Not written into the memory folder.

## What I did not change

- Cosine ranking, the 0.70 threshold, milestone skipping, unique
  basename, fail-silent exit 0.
- `build-exe.js` `MEMORY_SCRIPT_NAMES`. Hooks run through `entry.js` /
  the exe, which esbuild-bundles `require("./lexical.js")`. The
  installer does not copy these scripts to disk. If a later slice
  starts copying `hooks/memory-system/*.js` out of the SEA blob, add
  `lexical.js` to that list. `eval-lexical.js` and this file should
  stay out.
- `memory-system/template/memory-architecture.md` still says cosine
  >= 0.70 only. Ember's plugin worktree can pick that up.

## Tests

`node hooks/memory-system/test.js` and `npm test` after wiring. The
lexical cases do not need the network or the live folder; the hung-probe
test uses a localhost server that never responds.
