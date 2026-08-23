#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
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
 * test.js - dependency-free tests. Run:  node test.js
 *
 * Covers the record schema, durable writes, the access sidecar, and the temporal
 * model (RM-04). Deliberately no framework: this project ships as a single Node
 * binary with zero dependencies, and the tests keep that property.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  writeFileDurable, appendLineDurable,
  normalize, isCurrent, isHistoricalQuery, supersedePatches, AccessLog,
  detectSupersession, hasSupersedeCue,
} = require("./record.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); failed++; }
}
function section(s) { console.log("\n" + s); }
// Async variant: same reporting, awaited before the summary block runs.
async function atest(name, fn) {
  try { await fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); failed++; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rm-test-"));
const tmp = (n) => path.join(tmpRoot, n);

// ------------------------------------------------------------------ schema
section("record schema / migration");

test("normalize backfills temporal fields on a legacy record", () => {
  const r = normalize({ id: 1, text: "hi", created: "2026-01-01T00:00:00Z" });
  assert.strictEqual(r.valid_from, "2026-01-01T00:00:00Z", "valid_from defaults to created");
  assert.strictEqual(r.valid_to, null, "valid_to null = still true");
  assert.strictEqual(r.last_confirmed, "2026-01-01T00:00:00Z");
  assert.strictEqual(r.superseded_by, null);
  assert.strictEqual(r.supersedes, null);
  assert.strictEqual(r.revision, 1);
  assert.strictEqual(r.needs_review, false);
  assert.strictEqual(r.source, "user_stated");
});

test("normalize handles the oldest shape (ts instead of created)", () => {
  const r = normalize({ id: 1, text: "hi", ts: "2025-06-01T00:00:00Z" });
  assert.strictEqual(r.created, "2025-06-01T00:00:00Z");
  assert.strictEqual(r.valid_from, "2025-06-01T00:00:00Z");
});

test("normalize is idempotent", () => {
  const once = normalize({ id: 1, text: "hi" });
  assert.deepStrictEqual(normalize(once), once);
});

test("normalize preserves explicit temporal values", () => {
  const r = normalize({ id: 2, text: "x", valid_from: "A", valid_to: "B", superseded_by: 3, revision: 2 });
  assert.strictEqual(r.valid_to, "B");
  assert.strictEqual(r.superseded_by, 3);
  assert.strictEqual(r.revision, 2);
});

test("isCurrent: superseded and deleted are both excluded", () => {
  assert.strictEqual(isCurrent(normalize({ id: 1, text: "a" })), true);
  assert.strictEqual(isCurrent(normalize({ id: 2, text: "b", valid_to: "2026-01-01" })), false);
  assert.strictEqual(isCurrent(normalize({ id: 3, text: "c", deleted: true })), false);
});

test("supersedePatches builds a non-overlapping validity chain", () => {
  const oldR = normalize({ id: 1, text: "Acme", valid_from: "T0" });
  const newR = normalize({ id: 2, text: "Globex", valid_from: "T2" });
  const p = supersedePatches(oldR, newR);
  assert.strictEqual(p.old.valid_to, "T2", "old closes exactly where new opens");
  assert.strictEqual(p.old.superseded_by, 2);
  assert.strictEqual(p.new.supersedes, 1);
  assert.strictEqual(p.new.revision, 2);
});

// ------------------------------------------------------- supersession detection
section("supersession detection (RM-03)");

// A deterministic stand-in for cosine: the "similarity" of a candidate is just the
// first element of its embedding, so a test can dial in an exact geometry. detect-
// Supersession only ever calls cosineFn(newRec.embedding, m.embedding).
const simStub = (_new, mem) => mem[0];
const mem = (id, text, sim) => ({ id, text, embedding: [sim] });

test("hasSupersedeCue fires on correction language, not on history", () => {
  assert.strictEqual(hasSupersedeCue("Actually I work at Globex now"), true);
  assert.strictEqual(hasSupersedeCue("I moved to Denver last month"), true);
  assert.strictEqual(hasSupersedeCue("I no longer eat meat"), true);
  assert.strictEqual(hasSupersedeCue("I have a cat named Whiskers"), false);
  assert.strictEqual(hasSupersedeCue("I used to work at Acme"), false, "'used to' is historical, not a retirement cue");
});

test("detectSupersession: cue + above floor retires the most-similar memory", () => {
  const newRec = { id: 2, text: "Actually I work at Globex now", embedding: [1] };
  const cur = [mem(1, "I work at Acme", 0.57)];
  assert.strictEqual(detectSupersession(newRec, cur, simStub), cur[0]);
});

test("detectSupersession: no correction cue -> keep both (additive)", () => {
  const newRec = { id: 2, text: "I have a cat named Whiskers", embedding: [1] };
  const cur = [mem(1, "I have a dog named Rex", 0.9)];   // geometrically very close
  assert.strictEqual(detectSupersession(newRec, cur, simStub), null);
});

test("detectSupersession: cue but below floor -> cross-slot, keep both", () => {
  const newRec = { id: 2, text: "Actually I work at Globex now", embedding: [1] };
  const cur = [mem(1, "I live in Austin", 0.51)];        // 0.51 < 0.535 floor
  assert.strictEqual(detectSupersession(newRec, cur, simStub), null);
});

test("detectSupersession: picks the argmax, not just any above-floor memory", () => {
  const newRec = { id: 3, text: "Actually I work at Globex now", embedding: [1] };
  const cur = [mem(1, "I live in Austin", 0.54), mem(2, "I work at Acme", 0.57)];
  assert.strictEqual(detectSupersession(newRec, cur, simStub), cur[1], "the employer, not the city");
});

test("detectSupersession: a vectorless new memory can't target anything", () => {
  const newRec = { id: 2, text: "Actually I work at Globex now", embedding: null };
  const cur = [mem(1, "I work at Acme", 0.99)];
  assert.strictEqual(detectSupersession(newRec, cur, simStub), null);
});

test("detectSupersession: honors a custom minSim", () => {
  const newRec = { id: 2, text: "I switched to decaf now", embedding: [1] };
  const cur = [mem(1, "I drink regular coffee", 0.60)];
  assert.strictEqual(detectSupersession(newRec, cur, simStub, { minSim: 0.7 }), null);
  assert.strictEqual(detectSupersession(newRec, cur, simStub, { minSim: 0.5 }), cur[0]);
});

// ------------------------------------------------------------- historical query
section("historical query detection");

for (const q of ["where did I used to work", "what was my previous address",
                 "my old phone number", "where did I work before"]) {
  test(`historical: "${q}"`, () => assert.strictEqual(isHistoricalQuery(q), true));
}
for (const q of ["where do I work", "what is my address", "what should I cook",
                 "remind me about the dog"]) {
  test(`not historical: "${q}"`, () => assert.strictEqual(isHistoricalQuery(q), false));
}

// ------------------------------------------------------------- durable writes
section("durable writes");

test("writeFileDurable writes the exact content", () => {
  const f = tmp("d1.txt");
  writeFileDurable(f, "hello\nworld\n");
  assert.strictEqual(fs.readFileSync(f, "utf8"), "hello\nworld\n");
});

test("writeFileDurable replaces existing content atomically", () => {
  const f = tmp("d2.txt");
  writeFileDurable(f, "first");
  writeFileDurable(f, "second");
  assert.strictEqual(fs.readFileSync(f, "utf8"), "second");
});

test("writeFileDurable leaves no temp files behind", () => {
  const f = tmp("d3.txt");
  writeFileDurable(f, "x");
  const strays = fs.readdirSync(tmpRoot).filter((n) => n.includes(".tmp"));
  assert.deepStrictEqual(strays, [], "found stray temp files: " + strays.join(", "));
});

test("writeFileDurable creates missing directories", () => {
  const f = tmp("nested/deep/d4.txt");
  writeFileDurable(f, "y");
  assert.strictEqual(fs.readFileSync(f, "utf8"), "y");
});

test("a large write is never observed truncated", () => {
  // The property that matters: readers see all-old or all-new, never a partial
  // file. Rename is atomic, so any successful read is a complete document.
  const f = tmp("d5.jsonl");
  const big = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ id: i, text: "m" + i })).join("\n") + "\n";
  writeFileDurable(f, big);
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 5000);
  assert.doesNotThrow(() => lines.forEach((l) => JSON.parse(l)), "every line parses");
});

test("appendLineDurable appends without rewriting", () => {
  const f = tmp("d6.jsonl");
  appendLineDurable(f, "a\n");
  appendLineDurable(f, "b\n");
  assert.strictEqual(fs.readFileSync(f, "utf8"), "a\nb\n");
});

// -------------------------------------------------------------- access sidecar
section("access sidecar");

test("bump/apply folds counts onto records", () => {
  const a = new AccessLog(tmp("a1.json"));
  a.bump([1, 2]); a.bump([1]);
  const recs = [normalize({ id: 1, text: "x" }), normalize({ id: 2, text: "y" }), normalize({ id: 3, text: "z" })];
  a.apply(recs);
  assert.strictEqual(recs[0].access_count, 2);
  assert.strictEqual(recs[1].access_count, 1);
  assert.strictEqual(recs[2].access_count, 0);
  assert.ok(recs[0].last_access, "last_access set");
});

test("sidecar round-trips through disk", () => {
  const f = tmp("a2.json");
  const a = new AccessLog(f); a.bump([7]); a.bump([7]); a.save();
  const b = new AccessLog(f);
  assert.strictEqual(b.get(7).n, 2);
});

test("a corrupt sidecar degrades to empty instead of throwing", () => {
  const f = tmp("a3.json");
  fs.writeFileSync(f, "{ not json");
  const a = new AccessLog(f);
  assert.strictEqual(a.get(1).n, 0, "starts empty rather than crashing recall");
});

test("prune drops entries for deleted memories", () => {
  const a = new AccessLog(tmp("a4.json"));
  a.bump([1, 2, 3]);
  a.prune([1, 3]);
  assert.strictEqual(a.get(2).n, 0, "pruned");
  assert.strictEqual(a.get(1).n, 1, "kept");
});

test("importance mirrors access_count (retention signal only)", () => {
  const a = new AccessLog(tmp("a5.json"));
  a.bump([1]); a.bump([1]); a.bump([1]);
  const recs = [normalize({ id: 1, text: "x" })];
  a.apply(recs);
  assert.strictEqual(recs[0].importance, recs[0].access_count);
});

// ------------------------------------------------------------------ store
section("JsonlStore (via a temp store path)");

const { JsonlStore } = require("./store.js");

function freshStore() {
  const dir = tmp("store-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return new JsonlStore(path.join(dir, "mem.jsonl"));
}

test("add + current round-trips with temporal fields", () => {
  const s = freshStore();
  const now = new Date().toISOString();
  s.add(normalize({ id: 1, text: "I work at Acme", created: now, valid_from: now }));
  const cur = s.current();
  assert.strictEqual(cur.length, 1);
  assert.strictEqual(cur[0].valid_to, null);
});

test("current() excludes superseded; active() includes it", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "Acme", valid_to: "2026-07-01T00:00:00Z", superseded_by: 2 }));
  s.add(normalize({ id: 2, text: "Globex", supersedes: 1, revision: 2 }));
  assert.strictEqual(s.current().length, 1, "only the current one");
  assert.strictEqual(s.current()[0].text, "Globex");
  assert.strictEqual(s.active().length, 2, "history preserved");
});

test("updateMany applies a supersession in one write", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "Acme" }));
  s.add(normalize({ id: 2, text: "Globex" }));
  const p = supersedePatches(s.get(1), s.get(2), "T2");
  const n = s.updateMany({ "1": p.old, "2": p.new });
  assert.strictEqual(n, 2);
  assert.strictEqual(s.get(1).valid_to, "T2");
  assert.strictEqual(s.get(1).superseded_by, 2);
  assert.strictEqual(s.get(2).supersedes, 1);
  assert.strictEqual(s.current().length, 1);
});

test("recall does NOT rewrite the store (the whole point of the sidecar)", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "a", embedding: [1, 0] }));
  s.add(normalize({ id: 2, text: "b", embedding: [0, 1] }));
  const before = fs.statSync(s.file).mtimeMs;
  const bytesBefore = fs.readFileSync(s.file, "utf8");
  s.applyRecall([1, 2], new Map());           // steady state: nothing to backfill
  assert.strictEqual(fs.readFileSync(s.file, "utf8"), bytesBefore, "store bytes unchanged");
  assert.strictEqual(fs.statSync(s.file).mtimeMs, before, "store not rewritten at all");
  assert.strictEqual(s.get(1).access_count, 1, "but the access bump still landed");
});

test("recall DOES persist backfilled embeddings (legacy rows)", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "a" }));      // no embedding
  s.applyRecall([1], new Map([["1", [0.5, 0.5]]]));
  assert.deepStrictEqual(s.get(1).embedding, [0.5, 0.5]);
});

test("vacuum drops deleted rows and prunes their access entries", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "keep" }));
  s.add(normalize({ id: 2, text: "gone", deleted: true }));
  s.applyRecall([1, 2], new Map());
  assert.strictEqual(s.vacuum(), 1);
  assert.strictEqual(s.all().length, 1);
  assert.strictEqual(s.access.get(2).n, 0, "sidecar pruned with the store");
});

test("a corrupt line is skipped, not fatal", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "good" }));
  fs.appendFileSync(s.file, "{ truncated\n");
  s.add(normalize({ id: 2, text: "also good" }));
  assert.strictEqual(s.all().length, 2, "bad line skipped, good ones survive");
});

// --- regressions for the double-count bug (found by adversarial audit) ---------
// all() folds sidecar counts into records; _writeAll then persisted those folded
// values while the sidecar kept its own copy, so the next read added them again.
// Two recalls + an edit reported 4, then 6, then 8...
test("access_count does not double after an edit", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "x" }));
  s.applyRecall([1], new Map());
  s.applyRecall([1], new Map());
  assert.strictEqual(s.get(1).access_count, 2, "two recalls");
  s.update(1, { text: "edited" });
  assert.strictEqual(s.get(1).access_count, 2, "an edit must not inflate the count");
  s.update(1, { text: "edited again" });
  assert.strictEqual(s.get(1).access_count, 2, "and must not compound");
});

test("access_count does not double after vacuum", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "keep" }));
  s.add(normalize({ id: 2, text: "gone", deleted: true }));
  s.applyRecall([1], new Map());
  s.applyRecall([1], new Map());
  s.applyRecall([1], new Map());
  assert.strictEqual(s.get(1).access_count, 3);
  s.vacuum();
  assert.strictEqual(s.get(1).access_count, 3, "vacuum must not inflate the count");
});

test("counts survive a rewrite (consolidated into the store, not lost)", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "x" }));
  s.applyRecall([1], new Map());
  s.update(1, { text: "edited" });
  // reopen from disk: the total must have been persisted, not dropped with the sidecar
  const reopened = new JsonlStore(s.file);
  assert.strictEqual(reopened.get(1).access_count, 1, "consolidated into the store file");
});

test("recall after a rewrite keeps counting from the consolidated total", () => {
  const s = freshStore();
  s.add(normalize({ id: 1, text: "x" }));
  s.applyRecall([1], new Map());
  s.update(1, { text: "edited" });          // consolidate -> store has 1, sidecar empty
  s.applyRecall([1], new Map());            // sidecar -> 1
  assert.strictEqual(s.get(1).access_count, 2, "1 consolidated + 1 new");
});

test("nextId stays unique under rapid saves (same-millisecond collisions)", () => {
  // Date.now() alone would collide; nextId falls back to max+1 within a tick.
  const s = freshStore();
  const ids = [];
  for (let i = 0; i < 200; i++) { const id = s.nextId(); ids.push(String(id)); s.add(normalize({ id, text: "m" + i })); }
  assert.strictEqual(new Set(ids).size, 200, "all ids distinct");
  assert.strictEqual(s.all().length, 200);
});

test("nextId stays monotonic if the clock jumps backwards", () => {
  const s = freshStore();
  // Capture the id once: calling Date.now() again in the assertion races the
  // clock, and a 1ms tick between the two calls makes the comparison off by one.
  const future = Date.now() + 60000;
  s.add(normalize({ id: future, text: "from the future" }));
  assert.ok(s.nextId() > future, "never reuses an existing id");
});

test("legacy store with no temporal fields loads as all-current", () => {
  const s = freshStore();
  fs.writeFileSync(s.file,
    JSON.stringify({ id: 1, text: "old one", created: "2026-01-01T00:00:00Z" }) + "\n" +
    JSON.stringify({ id: 2, text: "old two", ts: "2026-01-02T00:00:00Z" }) + "\n");
  const cur = s.current();
  assert.strictEqual(cur.length, 2, "no migration step needed");
  assert.ok(cur.every((r) => r.valid_from && r.valid_to === null));
});

// ------------------------------------------------- associative field topology
section("associative field: reciprocal kNN (RM-00)");

const { buildEdges, reachableConstraints } = require("./field.js");

// Three points on a circle so the nearest-neighbor graph is deliberately one-sided:
//   A(0deg) - B(20deg) - C(35deg).  Gaps: A-B=20, B-C=15, A-C=35.
// With k=1: A's nearest is B, but B's nearest is C (15 < 20), and C's nearest is B.
// So A->B is NOT reciprocated: directional kNN gives A an edge, mutual kNN isolates A.
const rad = (d) => (d * Math.PI) / 180;
const ring = [
  { id: "A", text: "A", embedding: [Math.cos(rad(0)), Math.sin(rad(0))] },
  { id: "B", text: "B", embedding: [Math.cos(rad(20)), Math.sin(rad(20))] },
  { id: "C", text: "C", embedding: [Math.cos(rad(35)), Math.sin(rad(35))] },
];

test("directional kNN gives A a one-sided edge to B", () => {
  const e = buildEdges(ring, { k: 1, minSim: 0.5 });
  assert.deepStrictEqual(e.get("A").map((x) => x.id), ["B"]);
  assert.deepStrictEqual(e.get("B").map((x) => x.id), ["C"], "B prefers C, not A");
});

test("mutual kNN prunes the one-sided edge, isolating A", () => {
  const e = buildEdges(ring, { k: 1, minSim: 0.5, mutual: true });
  assert.deepStrictEqual(e.get("A"), [], "A->B dropped: B does not reciprocate");
  assert.deepStrictEqual(e.get("B").map((x) => x.id), ["C"], "B<->C is reciprocal, kept");
  assert.deepStrictEqual(e.get("C").map((x) => x.id), ["B"], "C<->B is reciprocal, kept");
});

test("mutual kNN never keeps an edge directional kNN dropped (it only prunes)", () => {
  const dir = buildEdges(ring, { k: 2, minSim: 0.5 });
  const mut = buildEdges(ring, { k: 2, minSim: 0.5, mutual: true });
  for (const id of ["A", "B", "C"]) {
    const dset = new Set(dir.get(id).map((x) => String(x.id)));
    for (const e of mut.get(id)) assert.ok(dset.has(String(e.id)), "mutual is a subset of directional");
  }
});

// --- constraint rescue (RM-00 experiment #2) --------------------------------
// C is the constraint. B is its bridge (cos 0.60). D is a far node (cos 0.40).
const C = { id: "C", is_constraint: true, embedding: [1, 0] };
const B = { id: "B", is_constraint: false, embedding: [0.6, 0.8] };       // cos(C,B)=0.60
const D = { id: "D", is_constraint: false, embedding: [0.4, Math.sqrt(1 - 0.16)] }; // cos(C,D)=0.40
const recs = [C, B, D];
const ids = (out) => out.map((e) => String(e.id));

test("reachableConstraints: rescues a constraint via a bridge in the seed pool", () => {
  const out = reachableConstraints(recs, ["B"], { gate: 0.55, exclude: [] });
  assert.deepStrictEqual(ids(out), ["C"], "C reachable because its bridge B is a seed");
});

test("reachableConstraints: a pooled constraint with NO bridge stays quiet (small-store guard)", () => {
  // Adversarial finding (adv-offtopic-quiet): when the store <= k_search the pool is the
  // whole store, so mere pool membership is not relevance. Without a bridge >= gate in the
  // pool, a constraint must NOT surface - else a shellfish allergy fires for an oil-change.
  const out = reachableConstraints([C, D], ["C", "D"], { gate: 0.55, exclude: [] });
  assert.deepStrictEqual(ids(out), [], "existence in the pool is not relevance; needs a real bridge");
});

test("reachableConstraints: never re-surfaces an already-RETURNED constraint", () => {
  const out = reachableConstraints(recs, ["C", "B"], { gate: 0.55, exclude: ["C"] });
  assert.deepStrictEqual(ids(out), [], "C is already shown to the model; don't repeat it");
});

test("reachableConstraints: only constraints are ever surfaced", () => {
  const out = reachableConstraints(recs, ["C", "D"], { gate: 0.35, exclude: [] });
  assert.ok(!ids(out).includes("B") && !ids(out).includes("D"), "non-constraints never appended");
});

test("reachableConstraints: the gate governs whether a bridge counts", () => {
  // C's only seed-neighbor is D at cos 0.40. Above a 0.55 gate D is not a bridge.
  assert.deepStrictEqual(reachableConstraints([C, D], ["D"], { gate: 0.55, exclude: [] }), []);
  // Drop the gate to 0.35 and the same link now rescues C (the stage-2 mechanic).
  assert.deepStrictEqual(ids(reachableConstraints([C, D], ["D"], { gate: 0.35, exclude: [] })), ["C"]);
});

// ------------------------------------------------- ROC/TBR field signals (RM-00)
section("field signals: ROC / TBR (RM-00)");

const { fieldSignals } = require("./eval/metrics.js");

const relOut =
  "1. [id 1] I'm diabetic, so no sugary desserts for me\n" +
  "2. [id 9] The potluck is on Friday\n\n" +
  "Related:\n- [id 2] I always bring lemon bars\n- [id 3] Someone booked the room";

test("fieldSignals: rescued reflects whether the constraint surfaced", () => {
  assert.strictEqual(fieldSignals({ expect: { contains: ["diabetic"] } }, relOut).rescued, true);
  assert.strictEqual(fieldSignals({ expect: { contains: ["vegetarian"] } }, relOut).rescued, false);
});

test("fieldSignals: bled counts forbidden terms that leaked", () => {
  assert.strictEqual(fieldSignals({ expect: { excludes: ["mechanic"] } }, relOut).bled, 0);
  const bledOut = relOut + "\n- [id 4] The mechanic said Thursday";
  assert.strictEqual(fieldSignals({ expect: { excludes: ["mechanic"] } }, bledOut).bled, 1);
});

test("fieldSignals: appended counts the field's Related nodes (tangent surface)", () => {
  assert.strictEqual(fieldSignals({ expect: {} }, relOut).appended, 2);
  const noRel = "1. [id 1] just a direct cosine hit, no field additions";
  assert.strictEqual(fieldSignals({ expect: {} }, noRel).appended, 0);
});

// ------------------------------------------------ edit() embedding safety
// BUG-007. An embedder outage is transient; losing an embedding is not.
const { createCore } = require("./memory-core.js");   // JsonlStore already required above

async function asyncTests() {
  section("edit() embedding safety (BUG-007)");

  const makeCore = (file, liveRef) => {
    const store = new JsonlStore(tmp(file));
    const embed = async (texts) => {
      if (!liveRef.live) throw new Error("embedder unreachable");
      return texts.map(() => [1, 0, 0]);
    };
    return { store, core: createCore({ store, embed }) };
  };

  await atest("a failed re-embed leaves the prior embedding intact", async () => {
    const ref = { live: true };
    const { store, core } = makeCore("bug007a.jsonl", ref);
    await core.save("the dentist is on Tuesday");
    const before = store.all()[0].embedding;
    assert.ok(Array.isArray(before) && before.length === 3, "saved with an embedding");

    ref.live = false;                       // embedder goes down
    const id = store.all()[0].id;
    await core.edit(id, "the dentist is on Thursday");

    const after = store.all()[0];
    assert.strictEqual(after.text, "the dentist is on Thursday", "text still updates");
    assert.deepStrictEqual(after.embedding, before, "prior embedding survives");
  });

  await atest("a failed re-embed is reported, not silent", async () => {
    const ref = { live: true };
    const { store, core } = makeCore("bug007b.jsonl", ref);
    await core.save("coffee with Dana");
    ref.live = false;
    const msg = await core.edit(store.all()[0].id, "coffee with Dana on Friday");
    assert.ok(/keyword/i.test(msg), "the degraded state is surfaced to the caller");
  });

  await atest("a successful re-embed still replaces the embedding", async () => {
    const ref = { live: true };
    const store = new JsonlStore(tmp("bug007c.jsonl"));
    let vec = [1, 0, 0];
    const embed = async (texts) => {
      if (!ref.live) throw new Error("embedder unreachable");
      return texts.map(() => vec.slice());
    };
    const core = createCore({ store, embed });
    await core.save("first");
    vec = [0, 1, 0];
    await core.edit(store.all()[0].id, "second");
    assert.deepStrictEqual(store.all()[0].embedding, [0, 1, 0], "fresh vector replaces the old one");
  });

  await atest("edit on a missing id still reports not-found", async () => {
    const ref = { live: true };
    const { core } = makeCore("bug007d.jsonl", ref);
    const msg = await core.edit(99999, "nothing here");
    assert.ok(/No memory with id/.test(msg));
  });
}

// ------------------------------------------------------------------- report
asyncTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }
  process.exit(failed ? 1 : 0);
});
