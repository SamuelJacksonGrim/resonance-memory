#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/*
 * build-demo-seed.js - generates demo-seed.jsonl: a small, 100% SYNTHETIC memory set
 * (fictional person "Alex Rivera") pre-embedded with the nomic embedder, so the demo
 * graph lights up on first launch with NO endpoint and NO real data.
 *
 * The set is built to show what RM actually wins on, not just "a bunch of notes":
 *   - semantic recall over keyword: "Kind of Blue" / "problem isn't a typing
 *     problem" has no debug/music/jazz words a keyword search would need
 *   - supersession of a corrected fact: the itch.io date slipped; the old row
 *     stays (valid_to + superseded_by) and the graph draws it dimmed. Uses
 *     supersedePatches() so the seed cannot fork the live write path
 *   - associative pull that does not restate its trigger: Nightfall's detective
 *     is named Coltrane; the vinyl memory is Coltrane's Blue Train. Neither
 *     restates the other's cluster (no "jazz" in the game note, no "Nightfall"
 *     in the vinyl note). The graph bridges them. One explicit cross-link
 *     (Biscuit's bark in Nightfall) stays so the constellation still has a
 *     thick, readable bridge
 *
 * Clusters (game / running / jazz / dog) plus those bridges — a small sharp
 * set, not a dump. View-only; never written to the user store.
 *
 * Run once with LM Studio + the embedding model up:  node build-demo-seed.js
 * Never contains real memories. Safe to ship in a public repo.
 */
const path = require("path");
const { normalize, writeFileDurable, supersedePatches } = require("./record.js");

const EMBED_URL = process.env.EMBED_ENDPOINT || "http://localhost:1234/v1/embeddings";
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-nomic-embed-text-v1.5";
const OUT = path.join(__dirname, "demo-seed.jsonl");

// { id, text, replaces? } — replaces: this row is the correction of that id.
const MEMORIES = [
  // --- Nightfall (the game) ---
  { id: 1000, text: "I'm building an indie game called Nightfall, a moody detective RPG set in a rain-soaked city." },
  { id: 1001, text: "Nightfall's combat system keeps crashing whenever the third act loads." },
  { id: 1002, text: "I decided to rewrite Nightfall's save system in Rust because the old one corrupts files." },
  { id: 1003, text: "Nightfall's art style is hand-painted watercolor backgrounds — slow to make but it sells the mood." },
  { id: 1004, text: "I'm making Nightfall completely solo, so I wear every hat: code, art, writing, and sound." },
  // Supersession beat: old ship date stays on disk; recall answers from the correction.
  { id: 1005, text: "The Nightfall playable demo goes up on itch.io next month for public playtesting." },
  { id: 1006, text: "Nightfall's itch.io demo slipped to next quarter — the third-act crash has to ship first.", replaces: 1005 },
  // Associative beat: names Coltrane, does not say "jazz".
  { id: 1007, text: "Nightfall's detective is named Coltrane." },
  { id: 1008, text: "I read Chandler and Hammett detective novels to get Nightfall's dialogue pacing right." },
  // --- running / knee / health ---
  { id: 1009, text: "I go for a 5am run along the river most mornings to clear my head before work." },
  { id: 1010, text: "My left knee flares up if I run more than 10k, so I'm keeping my distances short this month." },
  // Does not restate Nightfall; "ideas on the river path" is the silent bridge to the crash / Kind of Blue.
  { id: 1011, text: "My best ideas arrive on the river path — never at the desk." },
  { id: 1012, text: "Cold mornings make my knee ache, so I stretch for ten minutes before any run now." },
  { id: 1013, text: "I got a standing desk after a year of solo coding wrecked my lower back." },
  // --- jazz / music ---
  // Associative beat: Coltrane's Blue Train, does not say "Nightfall".
  { id: 1014, text: "I collect jazz vinyl; Coltrane's Blue Train is my most-played record by far." },
  { id: 1015, text: "I always code to jazz. Something about it keeps me in flow for hours." },
  { id: 1016, text: "I taught myself basic piano so I could write Nightfall's soundtrack myself." },
  // Semantic beat: no "debug" / "music" / "jazz" — keyword search for those misses it.
  { id: 1017, text: "I put on Kind of Blue when the problem isn't a typing problem." },
  // --- Biscuit (the dog) ---
  { id: 1018, text: "My dog Biscuit, a scruffy little terrier, sleeps under my desk while I work." },
  { id: 1019, text: "Biscuit needs a long walk at lunch or he chews through my controller cables." },
  { id: 1020, text: "The vet says Biscuit needs to lose a pound, so our lunchtime walks got longer." },
  // Explicit cross-link so the graph has one thick, readable game↔dog bridge.
  { id: 1021, text: "I recorded Biscuit's bark and hid it in Nightfall as a little easter egg." },
  // --- deadline ---
  { id: 1022, text: "I switched to decaf after 2pm — otherwise my sleep falls apart the week before a deadline." },
];

async function embed(texts) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error("embed HTTP " + res.status + " - is the embedding model loaded?");
  const body = await res.json();
  if (!body.data || !body.data.length) throw new Error("no vectors returned");
  return body.data.map((d) => d.embedding);
}

(async () => {
  console.log("Embedding " + MEMORIES.length + " synthetic demo memories via " + EMBED_MODEL + " ...");
  const vecs = await embed(MEMORIES.map((m) => m.text));
  // Two clocks so the correction is visibly later than the world it revises.
  const t0 = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const t1 = new Date().toISOString();
  const recs = MEMORIES.map((m, i) => {
    const when = m.replaces != null ? t1 : t0;
    return normalize({
      id: m.id, created: when, modified: when, text: m.text,
      embedding: vecs[i], valid_from: when, last_confirmed: when, source: "user_stated",
    });
  });
  const byId = new Map(recs.map((r) => [r.id, r]));
  for (const m of MEMORIES) {
    if (m.replaces == null) continue;
    const old = byId.get(m.replaces);
    const neu = byId.get(m.id);
    if (!old || !neu) throw new Error("replaces id missing: " + m.replaces + " -> " + m.id);
    const p = supersedePatches(old, neu, t1);
    Object.assign(old, p.old);
    Object.assign(neu, p.new);
  }
  const lines = recs.map((r) => JSON.stringify(r));
  writeFileDurable(OUT, lines.join("\n") + "\n");
  const nSuper = recs.filter((r) => r.superseded_by != null).length;
  console.log("Wrote " + recs.length + " demo memories (" + nSuper + " superseded) -> " + OUT +
    "  (" + (vecs[0] ? vecs[0].length : 0) + "-dim vectors)");
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
