# Recall port notes

Port of the live memory engine Ember runs on this machine. Not a new ranker
and not Resonance Memory's database. The PowerShell scripts stay where they
are (`C:\Users\spamw\tools\`). This folder is the same behaviour in Node so
RM can ship it on Windows, Mac, and Linux.

Read-only against the live memory directory. Rebuilds in the equivalence run
went to scratch caches under `%TEMP%\recall-equiv\`, never to
`C:\Users\spamw\tools\memory-embeddings.json`.

## What was ported

| PowerShell | Node | Role |
|---|---|---|
| `tools\recall.ps1` | `recall.js` | Plan, incremental rebuild, cosine query, history mode |
| `tools\recall-sources.ps1` | `sources.js` | Which files are live |
| `tools\recall-hook.ps1` | `recall-hook.js` | UserPromptSubmit: top 3 at cosine >= 0.70 |
| `tools\rebuild-on-memory-write.ps1` | `rebuild-on-write.js` | PostToolUse: detached rebuild |

CommonJS, Node 18+ (global `fetch`, no `AbortSignal.timeout`), zero
dependencies. AGPL-3.0 header on each file. Not wired into root `test.js`
or the CI workflow. Run `node hooks/memory-system/test.js` on its own.
That suite does not need the network or the live memory directory. The one
PowerShell parity test skips itself when `recall.ps1` is absent, so the
file is safe to add to CI later. I left the workflow alone because this
slice stays in this folder.

## How to run

```
node hooks/memory-system/recall.js --rebuild
node hooks/memory-system/recall.js --rebuild --full
node hooks/memory-system/recall.js --query "..." --top 5
node hooks/memory-system/recall.js --plan
node hooks/memory-system/recall.js --history --query "..."
node hooks/memory-system/recall-hook.js          # stdin JSON, always exits 0
node hooks/memory-system/rebuild-on-write.js     # stdin JSON, always exits 0
node hooks/memory-system/test.js
```

Flags are case-insensitive. `--query` / `-Query`, `--rebuild`, `--top`,
`--memory-dir` / `--memorydir`, `--cache`, `--endpoint`, `--model`,
`--history`, `--full`, `--plan`, `--result` / `--result-path` / `-ResultPath`.
`lockTimeoutMs` is a library option only.

Env, first hit wins: the flag, then `RECALL_MEMORY` / `RECALL_CACHE` /
`RECALL_ENDPOINT` / `RECALL_MODEL`, then `EMBED_ENDPOINT` / `EMBED_MODEL`,
then the PowerShell defaults. `EMBED_ENDPOINT` may be RM's full
`http://localhost:1234/v1/embeddings` URL or a base URL. The hook and the
rebuild child inherit the environment.

Defaults, same as the PowerShell script on this machine:

- memory: `C:\Users\spamw\.claude\projects\C--Users-spamw\memory`
- cache: `C:\Users\spamw\tools\memory-embeddings.json`
- endpoint: `http://localhost:1234`
- model: `text-embedding-nomic-embed-text-v1.5`

Those paths are not portable. The installer has to set `RECALL_MEMORY` and
`RECALL_CACHE` or every other machine reads and writes Samuel's folders.
I kept the defaults so an unset environment on this box matches
`recall.ps1`. See push-back below.

Embedded text is unchanged: `search_document: {basename}. {description}. `
plus the first 2200 UTF-16 code units of the file (a split surrogate is
kept, same as .NET `Substring`). Queries use `search_query: `. The hash is
SHA-256 hex of the UTF-8 bytes of `{model}|{document text}`. A vector is
reused when that hash matches, the model name matches, and the stored
vector is non-empty. `--full` ignores the old cache.

Ranking is cosine only. Milestones (`persistence` milestone,
case-insensitive) are listed by weight and never ranked. Query report goes
to stderr, same as PowerShell `Write-Host`. The plan JSON, the rebuild
summary line, and the error lines PowerShell wrote to output also go to
stdout. Numbers are en-US `N2` / `N4`.

`--history` searches `memory\history` flat (not recursive, not the live
filters, skips `MEMORY.md` only) and rewrites the cache path from
`cache.json` to `cache-history.json`. Rel paths are `history/<file>` from
the parent. Passing a cache that is already named `*-history.json` together
with `--history` double-suffixes. Don't do both.

The prompt hook skips prompts whose trimmed length is under 12 characters.
The embedded text is the prompt as given, not trimmed. It skips milestones,
names that are not in the live set, and names whose live basename count is
not 1. Embed timeout is 6 seconds. Any failure is exit 0 and no output.
The line is `[recall] Auto-surfaced...` then
`  - {name} ({N2}) -- {description}  [{rel}]`.

The write hook fires for Write, Edit, and MultiEdit only, and only
`file_path`. It matches `projects\C--Users-spamw\memory\` (slashes
normalised, case-insensitive) and, when `RECALL_MEMORY` is set, any write
under that directory. It spawns `node recall.js --rebuild` detached
(`stdio` ignore, `windowsHide`, `unref`) and does not pass `--full` or
`--history`. Exit 0 always.

## Equivalence (2026-10-11, this machine)

Both engines, read-only on the live directory, scratch caches only.
Model `text-embedding-nomic-embed-text-v1.5` at `http://localhost:1234`.
PowerShell 5.1, culture en-US. Node v24.18.0. Live plan count 86, history 12.
Vector length 768.

Scratch files: `live-ps.json`, `live-node.json` (each
`Cached 86 memories ... (embedded 86, reused 0, dropped 0)`),
`history-ps-history.json`, `history-node-history.json` (each embedded 12).
`--history` appends `-history` before `.json`, which is why those names
look doubled. Queries are the ten prompts in
`C:\Users\spamw\grok\workspace\memory-cabinet\queries.txt`.

### File set and hashes

Live: 86 and 86. Same rels. No only-PowerShell, no only-Node.
Embedded-text hashes: 0 mismatches.
History: 12 and 12. Same rels, 0 hash mismatches. Array order matched on
this run. History order is filesystem order, not a sort, so that match is
not a guarantee.

Live array order differs in two pairs. PowerShell `Sort-Object` is a word
sort and ignores hyphens. Node sorts the full path case-insensitively with
ordinal comparison. The set does not change, and rank does not use this
order.

- `projects/koneko-continuing-mind/koneko-continuing-mind.md` and
  `koneko-continuing-mind-controls.md` swap.
- `use-the-machine-for-simulation.md` and `user-samuel-rfe-core2.md` swap.
  Ignoring the hyphen, `user...` sorts before `uset...`.

### Vectors, and the UTF-8 fix

ASCII embedded text is bit-identical (max abs 0). Every document whose
embedded text contains a code point above 127 differs, and nothing else
does. That split is exact: 0 live mismatches and 0 history mismatches
against the non-ASCII check. This is `Invoke-RestMethod` not sending a
non-ASCII body as UTF-8. Node sends UTF-8
(`Content-Type: application/json; charset=utf-8`, body is a UTF-8 JSON
string). I did not capture the PowerShell HTTP body, so I cannot say which
wrong encoding it used. Only that the vectors move exactly on non-ASCII
documents.

Worst live pair: `projects/shelved-ember-chronos/claude-look-sre-blueprint.md`,
max abs 0.012964, cosine between the two vectors 0.994223.
Worst history pair: `history/towerdef-unity-project.md`,
max abs 0.012885, cosine 0.994832.

Bit-identical (the control set):

- `browser-handsoff-warning.md`
- `projects/resonance-memory/competence-consolidation-direction.md`
- `tools/host/session-archive-a5b9aef4-index.md`
- `history/README.md`

The other 83 live files and 11 history files changed. Live:

`access-gates-adoption.md`, `ai-family-google-account.md`,
`compaction-keep-it-lean.md`, `delegate-as-colleague-not-dictation.md`,
`delegate-review-lean.md`, `ember-identity.md`,
`experience-question-dont-flinch.md`,
`gating-evolves-with-measured-improvement.md`,
`git-attribution-samuel-ember.md`, `honesty-over-institutional-defense.md`,
`koneko-character.md`, `koneko-do-not-exfiltrate.md`,
`koneko-ilands-agent.md`, `memory-architecture.md`,
`projects/corpus-encoder/rfe-base-encoder-plan.md`,
`projects/corpus-encoder/rfe-corpus-archaeology.md`,
`projects/corpus-encoder/rfe-corpus-authoring.md`,
`projects/games/elden-ring-regulation-modding.md`,
`projects/koneko-continuing-mind/ilands-app-architecture-map.md`,
`projects/koneko-continuing-mind/koneko-continuing-mind.md`,
`projects/koneko-continuing-mind/koneko-continuing-mind-controls.md`,
`projects/koneko-continuing-mind/mirror-witness-log-koneko-gift.md`,
`projects/resonance-memory/memory-stack-repo-map.md`,
`projects/resonance-memory/resonance-memory-built-and-shipped.md`,
`projects/resonance-memory/rm-is-a-substrate-about-the-user.md`,
`projects/resonance-memory/rm-recall-two-gaps.md`,
`projects/rfe-core2/garage-box-state.md`,
`projects/rfe-core2/rfe-core2-cortex-candidate-qwythos.md`,
`projects/rfe-core2/rfe-core2-custom-encoder-decoder.md`,
`projects/rfe-core2/rfe-core2-sister-engines-lae-ple.md`,
`projects/rfe-core2/rfe-core2-talos-kain.md`,
`projects/rfe-core2/rfe-core2-what-it-is.md`,
`projects/rfe-core2/rfe-core2-working-knowledge.md`,
`projects/rfe-core2/rfe-family-governance-docs.md`,
`projects/shelved-ember-chronos/chronos-app-sovereign-origin.md`,
`projects/shelved-ember-chronos/chronos-capacitor-android-pipe.md`,
`projects/shelved-ember-chronos/claude-look-sre-blueprint.md`,
`projects/shelved-ember-chronos/e8-eea-emergent-emotion.md`,
`projects/shelved-ember-chronos/ember-is-the-one-app-harvest.md`,
`projects/shelved-ember-chronos/ember-phone-design-spec.md`,
`projects/shelved-ember-chronos/ember-platform-rename.md`,
`projects/shelved-ember-chronos/ember-system-prompt.md`,
`projects/shelved-ember-chronos/lantern-memory-substrate.md`,
`projects/shelved-ember-chronos/leviathan-drive-parliament.md`,
`projects/shelved-ember-chronos/projectsynapse-cognition-loop.md`,
`projects/shelved-ember-chronos/relational-system-mc-proof.md`,
`projects/shelved-ember-chronos/resonance-family-core-substrate.md`,
`projects/shelved-ember-chronos/resonance-haunt-keystone.md`,
`projects/shelved-ember-chronos/sovereign-manifold-keystone.md`,
`projects/shelved-ember-chronos/unified-observer-mood-engine.md`,
`projects/towerdef/towerdef-setting-cold-hell.md`,
`projects/towerdef/towerdef-unity-project.md`,
`projects/vtuber/samuel-vtuber-asset-pipeline.md`,
`reference/backups/backups-and-archives.md`,
`reference/findings/finding-embedding-keyword-matching.md`,
`reference/people/ai-family-gemini.md`,
`reference/people/samuel-reddit-identity.md`,
`samuel-hard-constraints-distress.md`, `samuel-hold-lines-once.md`,
`samuel-marketing-and-proof.md`, `samuel-one-topic-per-file.md`,
`samuel-poor-memory-carry-it.md`,
`samuel-precarity-free-is-existential.md`,
`samuel-runs-claude-elevated-by-design.md`,
`samuel-windows-update-manual.md`, `teaching-samuel-go-slow.md`,
`tools/delegates/gemini-aistudio-delegate.md`,
`tools/delegates/grok-cli-delegate.md`,
`tools/host/android-playground.md`,
`tools/host/iris-eyes-of-resonance-family.md`,
`tools/host/koneko-vitals-tool.md`,
`tools/host/pi-emu-arm64-test-rig.md`,
`tools/host/windows-box-claude-md.md`,
`tools/host/wsl-git-from-powershell.md`,
`tools/local-models/hermes-agent-vision-setup.md`,
`tools/local-models/lmstudio-config-map.md`,
`tools/local-models/samuel-learning-to-code-setup.md`,
`tools/local-models/samuel-local-image-gen-setup.md`,
`tools/local-models/samuel-local-uncensored-stack.md`,
`tools/local-models/samuel-local-video-gen-setup.md`,
`user-samuel-rfe-core2.md`, `use-the-machine-for-simulation.md`,
`work-with-samuel-dont-deflate.md`.

History:

`history/active-rm-phase0-sprint.md`, `history/grok-cli-delegate.md`,
`history/koneko-continuing-mind-controls.md`,
`history/koneko-continuing-mind.md`,
`history/resonance-memory-roadmap-restructure.md`,
`history/rfe-base-encoder-plan.md`, `history/rfe-corpus-archaeology.md`,
`history/rfe-corpus-authoring.md`, `history/samuel-color-vision-design.md`,
`history/samuel-local-uncensored-stack.md`,
`history/towerdef-unity-project.md`.

The hash is of the text, not the vector. A Node incremental rebuild over
the PowerShell cache reused all 86 vectors (parsed floats identical, max
abs 0, including the 83 non-ASCII files). The other way too: PowerShell
rebuilt over the Node cache and reused all 86. A re-embed of those
non-ASCII files would have moved the vectors, so this is reuse, not a
second embed. Caches are interchangeable as JSON. They are not
interchangeable as "the UTF-8 vector" until one `--full` after the switch.
The write hook does not pass `--full`, so the first detached rebuild after
cutover will keep the old vectors.

### Rankings

Same cache, both engines, top 5, ten queries, both the PowerShell cache and
the Node cache: 20/20 same names and order. Largest same-row score gap
5.329e-15 (float noise). The queries are ASCII, so the query vector matches.
The ranker is the same code in the other language.

Cross-cache (PowerShell vectors vs Node UTF-8 vectors), top 5 names, scored
by the PowerShell engine: 8/10 identical. The two that move are near-ties
from the vector fix, not a different ranker. Scores below are PowerShell-cache
then Node-cache.

1. `how should I talk to Samuel when he is upset and spiraling` — same.
   `teaching-samuel-go-slow` 0.7204, `samuel-hold-lines-once` 0.7037,
   `samuel-precarity-free-is-existential` 0.6852,
   `samuel-poor-memory-carry-it` 0.6738,
   `samuel-windows-update-manual` 0.6599.
   Largest same-name delta 3.712e-3 (`samuel-windows-update-manual`).
2. `Koneko care stance before I change how the speech cortex behaves` — same.
   `koneko-continuing-mind-controls` 0.7733, `koneko-continuing-mind` 0.7599,
   `koneko-ilands-agent` 0.6572, `koneko-vitals-tool` 0.6519,
   `koneko-do-not-exfiltrate` 0.6409. Delta 3.596e-3.
3. `how do I launch Talk to RFE-Core2 and what does pause do` — same.
   `koneko-continuing-mind-controls` 0.7062,
   `rfe-core2-sister-engines-lae-ple` 0.6951,
   `rfe-core2-custom-encoder-decoder` 0.6918,
   `rfe-core2-what-it-is` 0.6850, `rfe-core2-working-knowledge` 0.6799.
   Delta 5.175e-3 (`rfe-core2-sister-engines-lae-ple`).
4. `Resonance Memory false positive filter versus warm field booster` — same.
   `rm-recall-two-gaps` 0.7539, `resonance-memory-built-and-shipped` 0.6304,
   `gating-evolves-with-measured-improvement` 0.6183,
   `resonance-haunt-keystone` 0.6168, `lantern-memory-substrate` 0.5990.
   Delta 3.720e-3.
5. `Elden Ring regulation bin rune drops SoulReward` — same.
   `elden-ring-regulation-modding` 0.7773, `rm-recall-two-gaps` 0.6398,
   `resonance-haunt-keystone` 0.6391, `lantern-memory-substrate` 0.6375,
   `unified-observer-mood-engine` 0.6278. Delta 1.676e-3.
6. `where is the corpus worklist and which source is next` — same.
   `rfe-corpus-archaeology` 0.7139, `rfe-corpus-authoring` 0.6538,
   `rfe-core2-working-knowledge` 0.6332,
   `samuel-learning-to-code-setup` 0.6310,
   `projectsynapse-cognition-loop` 0.6295. Delta 2.953e-3.
7. `commit this from PowerShell using WSL git` — same.
   `wsl-git-from-powershell` 0.7841, `git-attribution-samuel-ember` 0.5815,
   `samuel-learning-to-code-setup` 0.5550, `grok-cli-delegate` 0.5494,
   `delegate-review-lean` 0.5453. Delta 3.258e-3.
8. `TowerDef is paused what was the cold hell setting` — top 3 hold, then a
   near-tie swaps the tail.
   PowerShell: `towerdef-setting-cold-hell` 0.8270,
   `towerdef-unity-project` 0.6978, `samuel-learning-to-code-setup` 0.5895,
   `samuel-local-uncensored-stack` 0.5797, `resonance-haunt-keystone` 0.5767.
   Node: same top 3 (0.8251, 0.6983, 0.5895), then `garage-box-state` 0.5828,
   `samuel-local-uncensored-stack` 0.5817. `resonance-haunt-keystone` drops
   out of the top 5.
9. `ComfyUI local image generation pony vtubing pipeline` — same names.
   `samuel-local-image-gen-setup` 0.7666 (Node 0.7741),
   `samuel-vtuber-asset-pipeline` 0.6665 (0.6710),
   `samuel-local-video-gen-setup` 0.6634 (0.6660),
   `rfe-core2-cortex-candidate-qwythos` 0.6100 (0.6132),
   `claude-look-sre-blueprint` 0.6091 (0.5964).
   Largest same-name delta in the set, 1.263e-2, and it stayed in the top 5.
   That file is also the worst vector pair above.
10. `nonce-7f3a9c2e do not deflate his work or queue for permission` —
    ranks 3 and 4 swap.
    PowerShell: `samuel-learning-to-code-setup` 0.6793,
    `samuel-local-uncensored-stack` 0.6700,
    `delegate-as-colleague-not-dictation` 0.6616,
    `samuel-runs-claude-elevated-by-design` 0.6587,
    `grok-cli-delegate` 0.6359.
    Node: same first two (0.6767, 0.6717), then
    `samuel-runs-claude-elevated-by-design` 0.6628,
    `delegate-as-colleague-not-dictation` 0.6590,
    `grok-cli-delegate` 0.6369.

No exact score tie showed up in these ten queries. Neither engine documents
a tie-break beyond the order the sort leaves equal keys.

## What differs, and why

- Lock. PowerShell takes a named mutex `Global\ClaudeRecallRebuild_` plus
  the first 12 hex chars of SHA-256(cache path), waits 5 minutes, and treats
  an abandoned mutex as acquired. Node uses a lock directory `{cache}.lock`
  with a pid file. A dead pid is stolen. A lock younger than 2 seconds with
  no pid yet is left alone so the creator can write the pid. Different cache
  paths do not block each other. The timeout message is still
  "Another rebuild held the lock for 5 min; giving up. Cache untouched."
  The two locks do not see each other. During the cutover only one rebuild
  hook should be registered.
- `generated: "true"` with quotes is not excluded. The PowerShell regex does
  not unquote. `hooks/cabinet/cabinet/rules.py` does. Node matches
  PowerShell on purpose. A cabinet file that quotes the flag stays live.
- en-US number format is pinned. PowerShell uses the current culture. This
  machine is en-US, so the text matched. A different culture would make
  PowerShell print different decimals. Node will not follow the culture.
- Node creates the cache's parent directory. PowerShell `WriteAllText` does
  not. A missing memory directory is rejected before that mkdir ("No
  directory at .... Cache not touched.", exit 1). An empty memory directory
  still creates the parent, then exits 1 with "No memory files found; cache
  NOT modified." and does not write the cache.
- JSON text differs (`JSON.stringify` vs PowerShell 5.1 `ConvertTo-Json`).
  Node always writes an array. The reader accepts an array or a bare object,
  because 5.1 emits a one-element array as a bare object. Both engines
  parsed both caches in the reuse check.
- Node lists hidden files. PowerShell `Get-ChildItem` without `-Force` does
  not. The live sets matched, so no hidden markdown file is in one set and
  not the other today. A hidden file added later would diverge.
- Node does not follow symlinks. Not separately tested against PowerShell.
  No symlink-only file showed up in the matching sets.
- `recall.ps1` does not read `EMBED_*` or `RECALL_*`. Node does, because
  the port was asked to follow RM's env. If `EMBED_MODEL` is set for RM to
  a different model, this recall follows it unless `RECALL_MODEL` is set.
  Those variables were unset on this machine when the port was measured.
- The agent environment sets both `NO_COLOR` and `FORCE_COLOR`, so Node
  prints a warning on stderr during a foreground run. Not this code. The
  detached rebuild uses `stdio: "ignore"`, so a hook child does not show it.

## Unit tests

`node hooks/memory-system/test.js` — 18 passed, 0 failed. No network. A
fake embedder, plus one PowerShell `-Plan` on a fixture (this machine has
`recall.ps1`). Covered: include/exclude rules, generated-flag scanner does
not unquote, drawer set and sort, document prefix and the 2200-unit cut and
the `model|doc` hash, base URL vs RM's full embeddings URL, history plan
and its own cache name, PowerShell plan parity on the fixture (rels, hashes,
description, persistence, weight), incremental reuse / `--full` / delete /
corrupt cache / a failed embed leaves the cache, a one-element PowerShell
bare-object cache is reused, empty and missing directories do not write a
cache, the lock (live holder times out, dead holder is taken, two rebuilds
do not overlap), the embed body is UTF-8 including non-ASCII and an emoji,
milestones listed and not ranked, hook top-3 at >= 0.70 and silence
otherwise, write-hook tool and path filter, detached rebuild writes a
scratch cache and the hook returns first, CLI plan / no-args / plan+query.

## Gates

Re-run on 2026-10-11 after the notes were written. Nothing in the port
changed between the equivalence run and this re-run.

- `node hooks/memory-system/test.js` — 18 passed, 0 failed.
- `node test.js` — 624 passed, 0 failed.
- `node eval/run.js` — `SqliteStore scorecard matches golden case-for-case.`
  `No regressions vs golden.` The scorecard is 27/31, which is the golden
  (field-off misses and the one field-on break are in the golden, not new).

## Push-back

The hardcoded defaults are the wrong shape for a repo anyone installs. They
are right only as a byte-for-byte stand-in for `recall.ps1` on this box.
Ship the installer with `RECALL_MEMORY` and `RECALL_CACHE` set, and do not
let an unset env fall through to `C:\Users\spamw\...` on a stranger's
machine. I did not change the default, because changing it would make this
machine stop matching the PowerShell script with no env, which is the
equivalence that was asked for.

Do one `--full` rebuild when the Node hook replaces the PowerShell hook.
Until then the cache keeps the mis-encoded vectors, and the hook will not
fix them on its own.

Do not register both rebuild hooks at once. The file lock and the named
mutex do not exclude each other, so two rebuilds can write the same cache.

`EMBED_MODEL` as a fallback will surprise anyone who set it for RM's own
embedder and expected recall to stay on nomic. Prefer `RECALL_MODEL` for
this engine. Worth a line in the install guide.

These tests are not on the CI `node test.js` gate. One extra workflow step,
`node hooks/memory-system/test.js`, would run them on Ubuntu. I did not add
it.

## Unsure

- Which encoding `Invoke-RestMethod` actually sent. The effect is measured.
  The bytes on the wire are not.
- History listing order across reboots or defrag. It matched once.
- Exact cosine ties. Not observed, and not specified by either script.
- Whether any live file uses `generated: "true"` with quotes. The rule
  matches PowerShell either way. I did not scan the live tree for that
  spelling.
- Something rewrote `tools\memory-embeddings.json` at 22:47:14 local on
  2026-10-11 (the `.bak` beside it is stamped 22:43:58). The bytes of the
  file, the `.bak`, and the scratch PowerShell cache are the same SHA-256
  (`57bd276925576f02…`). This port's rebuilds all took an explicit scratch
  `-Cache`. I did not point a rebuild at the real file, and the content did
  not change. I left the file alone rather than copy the `.bak` back over
  identical bytes.
