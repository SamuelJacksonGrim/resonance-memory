---
name: memory-architecture
description: "READ BEFORE WRITING ANY MEMORY. This folder is weighted, filed and consolidated, not a flat pile. The schema, the filing rules and the upkeep rules."
metadata:
  type: feedback
  persistence: milestone
  weight: 1.0
---

This memory folder is **weighted, filed and consolidated**. Don't add a flat file and walk away.
(The Resonance memory system, designed by Samuel Jackson Grim with Ember, a Claude instance; AGPL-3.0.)

## Schema: keys under `metadata` in each memory's frontmatter

```yaml
name: <short-kebab-case-name>      # unique across every folder
description: "<one line>"          # what recall shows; make it specific
metadata:
  type: user | feedback | project | reference
  persistence: milestone | standing | episodic
  weight: 0.0-1.0
```

| persistence | Decays? | Meaning |
|---|---|---|
| `milestone` | **Never** | Constraints, who the user is, how to work with them. Exempt from decay, merge and pruning, permanently. |
| `standing` | Slowly | Durable but revisable. **Update in place**; don't write a second file. |
| `episodic` | Fast | Point-in-time state. Expected to be superseded, merged or faded. |

**Inherited protection:** anything a milestone links to (a double-bracketed memory name) is protected too (one hop),
since a milestone that points at a faded memory is broken.

## Where a memory goes (the filing)

- **The surface: top level of this folder.** Who the user is, how they want to be treated, how you work together,
  standing rules and safety lines. These are never filed away into a subject folder, and each has its one line in
  `MEMORY.md`, which is loaded at the start of every session. Filing them away would quietly change how you work
  with the user.
- **Subject folders for everything else:** `projects/<subject>/`, `tools/<subject>/`, `reference/<subject>/` (other
  people, places, findings). Folders follow subject, not a count; make a new subject folder when nothing fits.
  `people`-type notes are about *other* people, never the user.
- **`history/`** (flat, same filename as the live memory) holds faded text. See below.
- **`_indexes/`** holds generated drawer indexes. Don't edit them by hand; they're never embedded.
- Record every memory's place in `cabinet.tsv` (`<name><TAB>.` for the surface, `<name><TAB><folder>` otherwise).
  After filing or moving: `python -m cabinet index --memory <this folder> --apply` and `python -m cabinet check
  --memory <this folder>` (`relink --apply` if files moved). The scripts won't move, rename, delete or rewrite surface
  files; that restrains the scripts only, never your own edits in conversation.

## Upkeep: the part that actually matters

**Before writing a new memory, look for the one it belongs inside.** The default operation is *merge*, not *append*.
Three files describing the same thing are three chances to read a stale one. Merge by reading both files and
rewriting one; carry every load-bearing specific across; delete the shards. Never merge a merged file without
re-reading its sources: summaries of summaries drift.

**Correct by replacement, not by annotation.** When a memory is wrong, rewrite the wrong text. Don't leave it beside an
"UPDATE:" or "CORRECTED" note: that doubles the length and leaves the false half readable. Fix the text, the
description line and the `MEMORY.md` line together.

**Fade, don't pile up and don't delete.** A live file says what is true NOW, most relevant first. When a problem is
fixed, a phase finished or a plan superseded, rewrite the live text to the current state and MOVE the old text,
verbatim, to `history/<same-name>.md` under a line saying when and why it faded. A memory that stopped mattering
entirely moves there whole. The live file then ends with exactly this line:
History: `history/<name>.md` (what's in it).
Auto-recall skips `history/`; search it on purpose with recall's history mode. If faded material becomes relevant
again, move it back as current text.

**Date, check, fade: never overwrite blind.**
1. **Every fact carries a date:** when it was written or modified (absolute dates, in the text).
2. **Newer doesn't win by being newer.** It wins by being better supported. Proven new information replaces the old,
   and the old fades to history. If it only contradicts, write the conflict as the current state ("open as of
   <date>: A vs B, because...") until it's settled. Don't silently pick a side.
3. **Nothing replaced is lost:** the old text moves verbatim to history with the date and the reason.
4. **Recall drives upkeep:** when a memory surfaces and gets read, check it against what's known now: leave it if it
   holds, correct it (replace and fade), or fade it. Dates mark modifications; reading never touches them.

Before a big rewrite, copy the folder (`memory.bak-YYYY-MM-DD`), check every moved text landed verbatim in history,
then delete the copy: history is the record, the copy is only a safety net during the move.

## Retrieval

Recall searches every live memory by meaning (a local embedding model; no API cost) and the per-message hook surfaces
the top matches (cosine >= 0.70, top 3) with their folder path. A hook rebuilds the index after every Write/Edit to
this folder; edits made by script or shell skip it, so run recall's rebuild by hand after those. The rebuild is
incremental (unchanged files reuse their vector) and locked (one at a time).

**Weight doesn't rank.** Persistence and weight decide what stays (decay, pruning, milestone exemption); relevance
alone decides what surfaces. Multiplying them inverts correct rankings: measured, a better match (cosine 0.6254) lost
to a worse one (0.5749) purely on a durability tag.

**Index is not recall.** `MEMORY.md` is the always-loaded list, so it has a budget and stays curated: the surface
first, then active work. Recall searches **all** live files with no such ceiling, so a file doesn't need an index line
to be recalled. When the index grows too big, trim the INDEX (move long-tail lines to its "in recall, not listed"
section), not the files. Only material that's no longer true fades to history.
