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
 * Covers the record schema, durable writes, the access sidecar, the temporal
 * model (RM-04), and the Phase 0 unified edge store (edges.js, standalone).
 * Deliberately no framework: this project ships as a single Node binary with
 * zero dependencies, and the tests keep that property.
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

test("normalize backfills embedding_version on a legacy record (Phase 0)", () => {
  const r = normalize({ id: 1, text: "hi", created: "2026-01-01T00:00:00Z" });
  assert.strictEqual(r.embedding_version, 1, "missing field defaults to 1");
});

test("normalize preserves an explicit embedding_version", () => {
  const r = normalize({ id: 1, text: "hi", embedding_version: 4 });
  assert.strictEqual(r.embedding_version, 4);
});

test("normalize treats a JSON-null embedding_version as missing (defaults to 1)", () => {
  // A bad patch that Object.assigned embedding_version: null would persist as
  // JSON null. Next read must not keep null — version comparison needs a number.
  const r = normalize({ id: 1, text: "hi", embedding_version: null });
  assert.strictEqual(r.embedding_version, 1);
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
  // Neither patch may carry embedding / embedding_version: Object.assign would
  // clobber the live vector (BUG-008 class) or reset the generation counter.
  assert.strictEqual("embedding" in p.old, false);
  assert.strictEqual("embedding" in p.new, false);
  assert.strictEqual("embedding_version" in p.old, false);
  assert.strictEqual("embedding_version" in p.new, false);
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

test("legacy store with no embedding_version loads as version 1", () => {
  const s = freshStore();
  fs.writeFileSync(s.file,
    JSON.stringify({ id: 1, text: "old one", embedding: [1, 0] }) + "\n");
  assert.strictEqual(s.get(1).embedding_version, 1);
  assert.deepStrictEqual(s.get(1).embedding, [1, 0], "vector untouched by the backfill");
});

test("recall backfill of a vectorless row does NOT increment embedding_version", () => {
  // First-time embed of current text is generation 1, not a re-embed. Bumping
  // here would make a save-time embedder outage look like an edit() mutation.
  const s = freshStore();
  s.add(normalize({ id: 1, text: "a" }));      // no embedding, version 1
  assert.strictEqual(s.get(1).embedding_version, 1);
  s.applyRecall([1], new Map([["1", [0.5, 0.5]]]));
  assert.deepStrictEqual(s.get(1).embedding, [0.5, 0.5]);
  assert.strictEqual(s.get(1).embedding_version, 1, "backfill is not a re-embed");
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

// ------------------------------------------------- unified edge store (Phase 0 / RM-21)
// Slice C wired EdgeStore into recall. Module-level cases still fail without
// edges.js; the live-path cases (I3/I5/I9, migration-numbers, constraint-rescue)
// fail without the memory-core wiring.
section("unified edge store (Phase 0)");

const {
  edgeKey, makeEdge, normalizeEdge, semanticValid, setSemantic, setHebbian,
  sidecarKind, readLegacyAssoc, migrateAssoc, siblingAssocPath,
  IncompatibleEdgeFormatError,
  SIDECAR_KIND, SIDECAR_VERSION, EdgeStore,
  DEDUP_LRU_SIZE, canonRequestId,
  effectiveHebbian, lambdaFromHalfLife, halfLifeFor, hebbianDecayType,
  elapsedSeconds, HALF_LIFE_SECONDS, DEFAULT_HALF_LIFE_TYPE, DAY, HOUR,
  SEMANTIC_PRUNE_GATE, HEBBIAN_PRUNE_FLOOR,
  isSemanticallyWeak, isUnreinforced, shouldPrune, markPruned, reactivateEdge,
} = require("./edges.js");
const { Ledger } = require("./ledger.js");

const T0 = "2026-09-05T00:00:00.000Z";
function plusIso(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

test("edgeKey is undirected: A↔B and B↔A are one edge", () => {
  assert.strictEqual(edgeKey(1, 2), edgeKey(2, 1));
  assert.strictEqual(edgeKey("b", "a"), edgeKey("a", "b"));
  assert.strictEqual(edgeKey(1, 2), "1:2");
});

test("makeEdge sets the spec fields with sane defaults", () => {
  const e = makeEdge(2, 1, { origin: "save-time-neighbor", now: T0 });
  assert.strictEqual(e.a, "1", "endpoints canonicalized (sorted)");
  assert.strictEqual(e.b, "2");
  assert.strictEqual(e.semantic.value, null, "semantic empty until computed");
  assert.deepStrictEqual(e.semantic.src_versions, { a: null, b: null });
  assert.strictEqual(e.hebbian.weight, 0, "unreinforced: Hebbian is genuinely zero");
  assert.strictEqual(e.hebbian.last_updated, T0, "last_updated nests inside hebbian");
  assert.strictEqual(e.provenance.origin, "save-time-neighbor");
  assert.strictEqual(e.provenance.migrated_from, null);
  assert.strictEqual(e.created_at, T0);
  assert.strictEqual(e.pruned_at, null, "null = active");
  assert.strictEqual(e.prune_count, 0);
  assert.strictEqual(e.first_pruned_at, null);
  assert.strictEqual(e.last_reactivated_at, null);
  assert.strictEqual("last_accessed" in e, false, "last_accessed is deliberately absent (I5 / BUG-002)");
  assert.strictEqual("last_updated" in e, false, "no bare last_updated — it clocks hebbian only");
});

test("makeEdge requires a typed origin (no silent default)", () => {
  assert.throws(() => makeEdge(1, 2, { now: T0 }), /origin/);
  assert.throws(() => makeEdge(1, 2, { origin: "migrated", now: T0 }), /origin/);
});

test("the two signals are independent: raising hebbian leaves semantic untouched", () => {
  const e = makeEdge(1, 2, {
    origin: "save-time-neighbor", now: T0,
    semantic: { value: 0.72, src_versions: { a: 1, b: 1 } },
  });
  const snap = JSON.parse(JSON.stringify(e.semantic));
  setHebbian(e, 1.4, "2026-09-05T01:00:00.000Z");
  assert.deepStrictEqual(e.semantic, snap, "semantic bytes unmoved");
  assert.strictEqual(e.hebbian.weight, 1.4);
  assert.strictEqual(e.hebbian.last_updated, "2026-09-05T01:00:00.000Z");
  assert.strictEqual(e.created_at, T0, "created_at is provenance only");
});

test("the two signals are independent: setting semantic leaves hebbian untouched", () => {
  const e = makeEdge(1, 2, {
    origin: "co-activation", now: T0, hebbianWeight: 0.5,
  });
  const snap = JSON.parse(JSON.stringify(e.hebbian));
  setSemantic(e, 0.81, { a: 2, b: 2 });
  assert.deepStrictEqual(e.hebbian, snap, "hebbian bytes unmoved");
  assert.strictEqual(e.semantic.value, 0.81);
  assert.deepStrictEqual(e.semantic.src_versions, { a: 2, b: 2 });
});

test("src_versions.a/b follow canonical endpoints, not makeEdge argument order", () => {
  const e = makeEdge(2, 1, {
    origin: "save-time-neighbor", now: T0,
    semantic: { value: 0.5, src_versions: { a: 10, b: 20 } },
  });
  assert.strictEqual(e.a, "1");
  assert.strictEqual(e.b, "2");
  assert.deepStrictEqual(e.semantic.src_versions, { a: 10, b: 20 }, "a=10 is endpoint 1's version");
  assert.strictEqual(semanticValid(e, 10, 20), true);
  assert.strictEqual(semanticValid(e, 20, 10), false);
});

test("semantic validity is a version comparison, not a stored flag", () => {
  const e = makeEdge(1, 2, {
    origin: "save-time-neighbor", now: T0,
    semantic: { value: 0.8, src_versions: { a: 1, b: 1 } },
  });
  assert.strictEqual(semanticValid(e, 1, 1), true, "src_versions match both endpoints");
  // Bump endpoint b's embedding_version. No invalidate() is called — there
  // isn't one. Stale is structurally self-evident on the next read.
  assert.strictEqual(semanticValid(e, 1, 2), false, "one endpoint moved; cache is stale");
  assert.strictEqual(e.semantic.value, 0.8, "stale cache still physically present");
  assert.deepStrictEqual(e.semantic.src_versions, { a: 1, b: 1 }, "no invalidation event rewrote the edge");
  assert.strictEqual(semanticValid(e, 2, 1), false, "the other endpoint moving is also stale");
});

test("empty (migrated) semantic is invalid against real embedding_versions", () => {
  const e = makeEdge(1, 2, { origin: "co-activation", now: T0, migrated_from: "assoc.json", hebbianWeight: 0.3 });
  assert.strictEqual(semanticValid(e, 1, 1), false);
  assert.strictEqual(e.semantic.value, null);
});

test("normalizeEdge backfills prune fields and never invents last_accessed", () => {
  const n = normalizeEdge({ a: 3, b: 1, hebbian: { weight: 0.2, last_updated: T0 } }, T0);
  assert.strictEqual(n.a, "1");
  assert.strictEqual(n.pruned_at, null);
  assert.strictEqual(n.prune_count, 0);
  assert.strictEqual("last_accessed" in n, false);
});

// --- migration from .assoc.json --------------------------------------------
const LEGACY_EDGES = {
  "1:2": 0.4,
  "1:3": 0.1,
  "2:5": 1.2,
  "10:2": 0.05,   // lexicographic key (same as ledger.js); must not be dropped
  "7:8": 0,
  "4:9": 0.33,
  "6:11": 0.9,
};
const LEGACY_N = Object.keys(LEGACY_EDGES).length;

function writeLegacyAssoc(file, edges) {
  fs.writeFileSync(file, JSON.stringify({ recalls: 40, edges }));
}

test("migrateAssoc: every .assoc.json edge survives (count + spot-check)", () => {
  const mapped = migrateAssoc({ recalls: 40, edges: LEGACY_EDGES }, T0);
  assert.strictEqual(mapped.size, LEGACY_N, "dropped edge = silent data loss");
  const spot = mapped.get(edgeKey(2, 5));
  assert.ok(spot, "2:5 present");
  assert.strictEqual(spot.hebbian.weight, 1.2, "weight lands on hebbian.weight");
  assert.strictEqual(spot.hebbian.last_updated, T0, "last_updated stamped at migration (lower bound)");
  assert.strictEqual(spot.created_at, T0, "created_at stamped at migration (lower bound)");
  assert.strictEqual(spot.provenance.origin, "co-activation", "genuine origin, not a bookkeeping value");
  assert.strictEqual(spot.provenance.migrated_from, "assoc.json");
  assert.strictEqual(spot.semantic.value, null, "semantic empty; computed on first use");
  assert.strictEqual(spot.pruned_at, null);
  // zero-weight edges survive too — lossless means the key, not a floor.
  assert.strictEqual(mapped.get(edgeKey(7, 8)).hebbian.weight, 0);
  assert.ok(mapped.get(edgeKey(10, 2)), "lexicographic 10:2 survived");
});

test("EdgeStore loads a fixture .assoc.json in memory without writing (I5)", () => {
  const file = tmp("legacy.assoc.json");
  writeLegacyAssoc(file, LEGACY_EDGES);
  const bytes = fs.readFileSync(file, "utf8");
  const mtime = fs.statSync(file).mtimeMs;
  const store = new EdgeStore(file, { now: () => T0 });
  assert.strictEqual(store.size, LEGACY_N);
  assert.strictEqual(store.migrated, true);
  assert.strictEqual(store.get(2, 5).hebbian.weight, 1.2);
  assert.strictEqual(fs.readFileSync(file, "utf8"), bytes, "load must not rewrite the sidecar");
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
});

test("EdgeStore save of a migrated sidecar is the new format, still N edges", () => {
  const file = tmp("migrated.assoc.json");
  writeLegacyAssoc(file, LEGACY_EDGES);
  const store = new EdgeStore(file, { now: () => T0 });
  store.save();
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(j.kind, SIDECAR_KIND);
  assert.strictEqual(j.version, SIDECAR_VERSION);
  assert.strictEqual(j.recalls, 40, "epoch clock survives migration");
  assert.strictEqual(Object.keys(j.edges).length, LEGACY_N);
  const reloaded = new EdgeStore(file, { now: () => T0 });
  assert.strictEqual(reloaded.migrated, false, "second load is native, not a re-migration");
  assert.strictEqual(reloaded.size, LEGACY_N);
  assert.strictEqual(reloaded.get(2, 5).hebbian.weight, 1.2);
  assert.strictEqual(reloaded.get(2, 5).provenance.migrated_from, "assoc.json");
});

test("one-way: an old-format reader fails cleanly on the new sidecar", () => {
  const file = tmp("new-format.assoc.json");
  const store = new EdgeStore(file, { now: () => T0 });
  store.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.7 }));
  store.save();
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(sidecarKind(j), SIDECAR_KIND);
  assert.throws(
    () => readLegacyAssoc(j),
    (err) => err instanceof IncompatibleEdgeFormatError && /resonance-edges/.test(err.message),
    "must throw, not return a silent subset of edges"
  );
  // Belt: object-valued edges without the kind still refuse (misparse = NaN weights).
  assert.throws(
    () => readLegacyAssoc({ recalls: 0, edges: { "1:2": j.edges["1:2"] } }),
    IncompatibleEdgeFormatError
  );
});

test("readLegacyAssoc still accepts a real .assoc.json", () => {
  const parsed = readLegacyAssoc({ recalls: 7, edges: { "1:2": 0.4, "3:4": 0.1 } });
  assert.strictEqual(parsed.recalls, 7);
  assert.strictEqual(parsed.edges["1:2"], 0.4);
  assert.strictEqual(sidecarKind({ recalls: 7, edges: { "1:2": 0.4 } }), "legacy-assoc");
});

test("persistence round-trip: write → reload → identical records", () => {
  const file = tmp("roundtrip.edges.json");
  const a = new EdgeStore(file, { now: () => T0 });
  const e1 = makeEdge(1, 2, {
    origin: "save-time-neighbor", now: T0,
    semantic: { value: 0.61, src_versions: { a: 1, b: 3 } },
  });
  const e2 = makeEdge(4, 5, { origin: "co-activation", now: T0, hebbianWeight: 0.25, migrated_from: "assoc.json" });
  a.put(e1);
  a.put(e2);
  a.save();
  const b = new EdgeStore(file, { now: () => T0 });
  assert.strictEqual(b.size, 2);
  assert.deepStrictEqual(b.get(2, 1), a.get(1, 2));
  assert.deepStrictEqual(b.get(4, 5), a.get(5, 4));
  assert.strictEqual("last_accessed" in b.get(1, 2), false);
  assert.strictEqual(b.get(1, 2).semantic.value, 0.61);
  assert.strictEqual(b.get(4, 5).hebbian.weight, 0.25);
});

test("corrupt sidecar fails open: empty store, does not throw (I3)", () => {
  const cases = [
    ["truncated.json", "{ not json"],
    ["empty.json", ""],
    ["null.json", "null"],
    ["array.json", "[1,2,3]"],
    ["unknown.json", JSON.stringify({ foo: 1, edges: "nope" })],
    ["kind-but-array.json", JSON.stringify({ kind: SIDECAR_KIND, version: 1, edges: [1, 2] })],
  ];
  for (const [name, body] of cases) {
    const file = tmp("corrupt-" + name);
    fs.writeFileSync(file, body);
    let store;
    assert.doesNotThrow(() => { store = new EdgeStore(file, { now: () => T0 }); }, "corrupt " + name + " must not throw");
    assert.strictEqual(store.size, 0, name + " fails open to empty, not a throw");
  }
  // Missing file is the same posture as Ledger: start empty.
  const missing = new EdgeStore(tmp("no-such-sidecar.json"), { now: () => T0 });
  assert.strictEqual(missing.size, 0);
});

test("old Ledger.save stripping kind does not drop records (envelope recovery)", () => {
  // Attack: shipped Ledger.load stores object-valued edges as "weights", then
  // save() writes {recalls, edges} with no kind. Without recovery, sidecarKind
  // would return "unknown" and EdgeStore would fail-open empty — silent loss
  // of irreplaceable Hebbian weight. Slice C must still stop Ledger writing
  // this file; this is the load-side belt.
  const file = tmp("stripped-kind.assoc.json");
  const first = new EdgeStore(file, { now: () => T0 });
  first.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.7 }));
  first.put(makeEdge(3, 4, { origin: "save-time-neighbor", now: T0, hebbianWeight: 0.2 }));
  first.save();
  const native = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ recalls: 0, edges: native.edges }));
  const recovered = new EdgeStore(file, { now: () => T0 });
  assert.strictEqual(recovered.size, 2, "stripped envelope must not fail-open empty");
  assert.strictEqual(recovered.get(1, 2).hebbian.weight, 0.7);
  assert.strictEqual(recovered.get(3, 4).hebbian.weight, 0.2);
  assert.throws(() => readLegacyAssoc(JSON.parse(fs.readFileSync(file, "utf8"))), IncompatibleEdgeFormatError);
});

test("incident() lists unpruned edges for an endpoint (Slice C absorption helper)", () => {
  const store = new EdgeStore(tmp("incident.json"), { now: () => T0 });
  store.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.2 }));
  store.put(makeEdge(1, 3, { origin: "save-time-neighbor", now: T0 }));
  store.put(makeEdge(4, 5, { origin: "co-activation", now: T0 }));
  const inc = store.incident(1);
  assert.strictEqual(inc.length, 2);
  assert.deepStrictEqual(inc.map((e) => edgeKey(e.a, e.b)).sort(), ["1:2", "1:3"]);
});

test("siblingAssocPath maps <store>.edges.json → <store>.assoc.json", () => {
  assert.strictEqual(siblingAssocPath("store.jsonl.edges.json"), "store.jsonl.assoc.json");
  assert.strictEqual(siblingAssocPath("x.assoc.json"), null);
});

test("missing .edges.json migrates a sibling .assoc.json, leaves it untouched", () => {
  const base = tmp("sibstore.jsonl");
  const assoc = base + ".assoc.json";
  const edges = base + ".edges.json";
  writeLegacyAssoc(assoc, LEGACY_EDGES);
  const bytes = fs.readFileSync(assoc, "utf8");
  const mtime = fs.statSync(assoc).mtimeMs;
  const store = new EdgeStore(edges, { now: () => T0 });
  assert.strictEqual(store.migrated, true);
  assert.strictEqual(store.size, LEGACY_N);
  assert.strictEqual(store.get(2, 5).hebbian.weight, 1.2);
  assert.strictEqual(store.recalls, 40, "epoch clock imported");
  assert.strictEqual(fs.readFileSync(assoc, "utf8"), bytes, ".assoc.json is read-only-for-migration");
  assert.strictEqual(fs.statSync(assoc).mtimeMs, mtime);
  assert.ok(fs.existsSync(edges), "migrated table persisted to .edges.json");
  const j = JSON.parse(fs.readFileSync(edges, "utf8"));
  assert.strictEqual(j.kind, SIDECAR_KIND);
  assert.strictEqual(j.recalls, 40);
});

test("existing .edges.json is the authority: a sibling .assoc.json is not merged", () => {
  const base = tmp("authstore.jsonl");
  const assoc = base + ".assoc.json";
  const edges = base + ".edges.json";
  // Write the NEW file first so load() never looks at the sibling.
  const only = makeEdge(8, 9, { origin: "co-activation", now: T0, hebbianWeight: 0.01 });
  fs.writeFileSync(edges, JSON.stringify({
    kind: SIDECAR_KIND, version: SIDECAR_VERSION, recalls: 0,
    edges: { [edgeKey(8, 9)]: only },
  }));
  writeLegacyAssoc(assoc, LEGACY_EDGES);
  const reloaded = new EdgeStore(edges, { now: () => T0 });
  assert.strictEqual(reloaded.size, 1, "must not pull in the leftover .assoc.json");
  assert.ok(reloaded.get(8, 9));
  assert.strictEqual(reloaded.get(2, 5), undefined);
});

test("corrupt .edges.json fails open and does NOT fall back to .assoc.json", () => {
  const base = tmp("corrupt-fallback.jsonl");
  const assoc = base + ".assoc.json";
  const edges = base + ".edges.json";
  writeLegacyAssoc(assoc, LEGACY_EDGES);
  fs.writeFileSync(edges, "{ not json");
  const store = new EdgeStore(edges, { now: () => T0 });
  assert.strictEqual(store.size, 0, "fail-open is empty, not a silent merge of stale weights");
  assert.strictEqual(store.migrated, false);
});

// --- Hebbian math: moving storage must not move the numbers -----------------
test("EdgeStore.bonus matches shipped Ledger.bonus on the same weights (tanh bound)", () => {
  const L = new Ledger(tmp("math-l.assoc.json"));
  const E = new EdgeStore(tmp("math-e.edges.json"), { now: () => T0 });
  L.edges.set("1:2", 0.4);
  L.edges.set("1:3", 1.2);
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.4 }));
  E.put(makeEdge(1, 3, { origin: "co-activation", now: T0, hebbianWeight: 1.2 }));
  assert.strictEqual(E.bonus(1, 2), L.bonus(1, 2));
  assert.strictEqual(E.bonus(1, 3), L.bonus(1, 3));
  assert.strictEqual(E.bonus(2, 3), 0, "missing edge is bonus 0");
  assert.strictEqual(E.bonus(1, 2), 0.3 * Math.tanh(0.4));
  assert.strictEqual(E.bonus(9, 9), 0);
});

test("EdgeStore.reinforceRecall + tick match Ledger on the same event (alphaPP/PN/NN + epoch decay)", () => {
  const L = new Ledger(tmp("reinf-l.assoc.json"));
  const E = new EdgeStore(tmp("reinf-e.edges.json"), { now: () => T0 });
  L.reinforceRecall(["1", "2"], ["3", "4"]);
  E.reinforceRecall(["1", "2"], ["3", "4"]);
  assert.strictEqual(E.weight(1, 2), L.weight(1, 2), "primary<->primary alphaPP");
  assert.strictEqual(E.weight(1, 3), L.weight(1, 3), "primary<->neighborhood alphaPN");
  assert.strictEqual(E.weight(2, 4), L.weight(2, 4));
  assert.strictEqual(E.weight(3, 4), 0, "neighborhood<->neighborhood is zero");
  assert.strictEqual(L.weight(3, 4), 0);
  for (let i = 0; i < 10; i++) { L.tick(); E.tick(); }
  assert.strictEqual(E.recalls, L.recalls);
  assert.strictEqual(E.weight(1, 2), L.weight(1, 2), "epoch decay applied on the 10th tick");
  assert.strictEqual(E.weight(1, 3), L.weight(1, 3));
});

test("migrated .assoc.json produces the same Hebbian bonuses as shipped Ledger", () => {
  const base = tmp("same-numbers.jsonl");
  const assoc = base + ".assoc.json";
  const edges = base + ".edges.json";
  const fixture = { "1:2": 0.4, "1:3": 1.2, "10:2": 0.05, "7:8": 0 };
  writeLegacyAssoc(assoc, fixture);
  const L = new Ledger(assoc);
  const E = new EdgeStore(edges, { now: () => T0 });
  for (const k of Object.keys(fixture)) {
    const [a, b] = k.split(":");
    assert.strictEqual(E.bonus(a, b), L.bonus(a, b), "bonus " + k + " drifted");
    assert.strictEqual(E.weight(a, b), L.weight(a, b), "weight " + k + " drifted");
  }
  assert.strictEqual(E.recalls, L.recalls, "epoch clock imported");
});

test("retired epoch decay does not stamp hebbian.last_updated (live clock is wall-clock)", () => {
  // tick() is off the live path as of 0.2; this only proves the retired copy
  // still matches Ledger and does not mix clocks if someone replays it.
  const E = new EdgeStore(tmp("decay-stamp.edges.json"), { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 1.0 }));
  for (let i = 0; i < 10; i++) E.tick();
  assert.ok(E.weight(1, 2) < 1.0, "decayed");
  assert.strictEqual(E.get(1, 2).hebbian.last_updated, T0, "epoch decay must not mix in wall-clock");
});

// --- Phase 0.2: lazy wall-clock Hebbian decay (I6) -------------------------
// Fake/injectable clock throughout. Decay is COMPUTED, never stored.
section("Phase 0.2 lazy wall-clock decay (I6)");

test("half-life parameters are seconds and match the spec starting values", () => {
  assert.strictEqual(HALF_LIFE_SECONDS.constraint, 30 * DAY, "constraints ~30 days");
  assert.strictEqual(HALF_LIFE_SECONDS.fact, 7 * DAY, "facts ~7 days");
  assert.strictEqual(HALF_LIFE_SECONDS.working, 1 * HOUR, "working ~1 hour");
  assert.strictEqual(DEFAULT_HALF_LIFE_TYPE, "fact");
  assert.strictEqual(halfLifeFor("constraint"), 30 * DAY);
  assert.strictEqual(halfLifeFor("working"), 1 * HOUR);
  assert.strictEqual(halfLifeFor("no-such-type"), HALF_LIFE_SECONDS.fact, "unknown type → fact");
  assert.strictEqual(halfLifeFor("ns-custom", { "ns-custom": 99, fact: 7 * DAY }), 99, "namespace lookup");
  const lam = lambdaFromHalfLife(HALF_LIFE_SECONDS.fact);
  assert.ok(Math.abs(lam - Math.LN2 / HALF_LIFE_SECONDS.fact) < 1e-15, "λ = ln(2)/H");
  assert.strictEqual(lambdaFromHalfLife(0), 0, "non-positive H → no decay (fail open)");
  assert.strictEqual(lambdaFromHalfLife(-10), 0);
});

test("hebbianDecayType: a constraint endpoint gets the long half-life class", () => {
  assert.strictEqual(hebbianDecayType({ is_constraint: true }, { is_constraint: false }), "constraint");
  assert.strictEqual(hebbianDecayType({ is_constraint: false }, { is_constraint: true }), "constraint");
  assert.strictEqual(hebbianDecayType({ is_constraint: false }, { is_constraint: false }), "fact");
  assert.strictEqual(hebbianDecayType(null, null), "fact");
});

test("I6 proof: 100 reads under a FROZEN clock leave stored weight + last_updated unmoved; then reinforce does change them", () => {
  let now = T0;
  const E = new EdgeStore(tmp("i6-frozen.edges.json"), { now: () => now });
  const e0 = E.put(makeEdge(1, 2, {
    origin: "co-activation", now: T0, hebbianWeight: 1.0,
    semantic: { value: 0.72, src_versions: { a: 1, b: 1 } },
  }));
  const hebSnap = JSON.parse(JSON.stringify(e0.hebbian));
  const semSnap = JSON.parse(JSON.stringify(e0.semantic));
  for (let i = 0; i < 100; i++) {
    E.bonus(1, 2);
    E.effectiveWeight(1, 2);
    E.weight(1, 2);
    effectiveHebbian(E.get(1, 2), now);
  }
  const after = E.get(1, 2);
  assert.deepStrictEqual(after.hebbian, hebSnap, "stored Hebbian bytes unmoved by reads (I6)");
  assert.deepStrictEqual(after.semantic, semSnap, "semantic unmoved by reads");
  assert.strictEqual(effectiveHebbian(after, now), 1.0, "frozen clock → effective == stored");
  // Genuine reinforcement, after the clock has moved, MUST change both.
  now = plusIso(T0, 60);
  E.reinforceRecall(["1", "2"], []);
  const bumped = E.get(1, 2);
  assert.ok(bumped.hebbian.weight > 1.0, "reinforceRecall still strengthens (retained path)");
  assert.strictEqual(bumped.hebbian.last_updated, now, "reinforce stamps last_updated");
  assert.deepStrictEqual(bumped.semantic, semSnap, "reinforce leaves semantic alone");
});

test("weight halves at exactly one half-life (w·2^(−Δt/H))", () => {
  const e = makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.8 });
  const H = HALF_LIFE_SECONDS.fact;
  assert.strictEqual(effectiveHebbian(e, T0, { type: "fact" }), 0.8, "Δt=0 → stored");
  assert.strictEqual(effectiveHebbian(e, plusIso(T0, H), { type: "fact" }), 0.4, "exactly one H → half");
  assert.strictEqual(effectiveHebbian(e, plusIso(T0, 2 * H), { type: "fact" }), 0.2, "two H → quarter");
  // λ form agrees with the power-of-two form at one half-life.
  const viaLambda = 0.8 * Math.exp(-lambdaFromHalfLife(H) * H);
  assert.ok(Math.abs(viaLambda - 0.4) < 1e-12, "w·exp(−λH) ≈ w/2");
});

test("decay at multiple elapsed times; monotonic in Δt", () => {
  const e = makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 1.0 });
  const H = HALF_LIFE_SECONDS.fact;
  const samples = [0, H / 4, H / 2, H, 2 * H, 10 * H].map((dt) => ({
    dt, w: effectiveHebbian(e, plusIso(T0, dt), { type: "fact" }),
  }));
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].w < samples[i - 1].w,
      "monotonic: Δt=" + samples[i].dt + " must be strictly smaller than Δt=" + samples[i - 1].dt);
  }
  assert.strictEqual(samples[0].w, 1.0);
  assert.ok(samples[samples.length - 1].w < 0.01, "long elapsed → nearly gone (not pruned; that's 0.4)");
});

test("negative clock delta clamps to no decay (cannot amplify)", () => {
  const e = makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.6 });
  const past = plusIso(T0, -86400);
  assert.strictEqual(elapsedSeconds(past, T0), 0);
  assert.strictEqual(effectiveHebbian(e, past, { type: "fact" }), 0.6, "backwards clock → stored, not amplified");
  assert.ok(effectiveHebbian(e, plusIso(T0, 1), { type: "fact" }) < 0.6, "forward still decays");
});

test("semantic does NOT decay while Hebbian does", () => {
  let now = T0;
  const E = new EdgeStore(tmp("sem-vs-heb.edges.json"), { now: () => now });
  E.put(makeEdge(1, 2, {
    origin: "save-time-neighbor", now: T0, hebbianWeight: 1.0,
    semantic: { value: 0.81, src_versions: { a: 1, b: 1 } },
  }));
  const semSnap = JSON.parse(JSON.stringify(E.get(1, 2).semantic));
  now = plusIso(T0, HALF_LIFE_SECONDS.fact);
  assert.strictEqual(E.weight(1, 2), 1.0, "stored Hebbian unmoved (computed, not written)");
  assert.strictEqual(E.effectiveWeight(1, 2), 0.5);
  assert.deepStrictEqual(E.get(1, 2).semantic, semSnap, "semantic is structural and does not fade");
  assert.strictEqual(E.get(1, 2).hebbian.last_updated, T0, "read must not stamp last_updated");
});

test("bonus uses effectiveHebbian, not the stored weight", () => {
  let now = T0;
  const E = new EdgeStore(tmp("bonus-eff.edges.json"), { now: () => now });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 1.0 }));
  assert.strictEqual(E.bonus(1, 2), 0.3 * Math.tanh(1.0), "Δt=0 → tanh(stored)");
  now = plusIso(T0, HALF_LIFE_SECONDS.fact);
  assert.strictEqual(E.weight(1, 2), 1.0, "stored still 1");
  assert.ok(Math.abs(E.bonus(1, 2) - 0.3 * Math.tanh(0.5)) < 1e-12, "bonus tracks faded weight");
});

test("per-type/namespace half-lives: constraint fades slower than fact, fact slower than working", () => {
  const e = makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 1.0 });
  const t = plusIso(T0, HOUR);   // 1 hour elapsed
  const wC = effectiveHebbian(e, t, { type: "constraint" });
  const wF = effectiveHebbian(e, t, { type: "fact" });
  const wW = effectiveHebbian(e, t, { type: "working" });
  const wNs = effectiveHebbian(e, t, { namespace: "working" });
  assert.ok(wC > wF && wF > wW, "30d > 7d > 1h at the same Δt");
  assert.strictEqual(wW, 0.5, "working half-life is 1 hour → exactly half");
  assert.strictEqual(wNs, wW, "namespace uses the same table as type");
  // Custom table override.
  assert.strictEqual(effectiveHebbian(e, plusIso(T0, 10), { halfLife: 10 }), 0.5);
});

// --- Phase 0.3: materialize-on-mutation + request-ID idempotency ----------
// Fake/injectable clock and injectable ids. Both live on the MUTATION path.
section("Phase 0.3 materialize-on-mutation + request-ID idempotency");

test("canonRequestId: missing/null/empty are no-id; 0 is a real id; 1 and \"1\" differ", () => {
  assert.strictEqual(canonRequestId(undefined), null);
  assert.strictEqual(canonRequestId(null), null);
  assert.strictEqual(canonRequestId(""), null);
  assert.strictEqual(canonRequestId(0), "n:0", "JSON-RPC id 0 is valid");
  assert.strictEqual(canonRequestId(1), "n:1");
  assert.strictEqual(canonRequestId("1"), "s:1", "number 1 and string \"1\" are distinct requests");
  assert.strictEqual(canonRequestId("req-abc"), "s:req-abc");
});

test("reinforce after a long idle materializes decay first (no ghost weight)", () => {
  // Failure signature: stored becomes original+α instead of decayed+α.
  let now = T0;
  const E = new EdgeStore(tmp("m-idle.edges.json"), { now: () => now });
  const e0 = E.put(makeEdge(1, 2, {
    origin: "co-activation", now: T0, hebbianWeight: 1.0,
    semantic: { value: 0.77, src_versions: { a: 1, b: 1 } },
  }));
  const originSnap = JSON.parse(JSON.stringify(e0.provenance));
  const semSnap = JSON.parse(JSON.stringify(e0.semantic));
  const created = e0.created_at;
  now = plusIso(T0, HALF_LIFE_SECONDS.fact);   // exactly one fact half-life
  assert.strictEqual(E.weight(1, 2), 1.0, "stored still original before the mutation");
  assert.strictEqual(E.effectiveWeight(1, 2), 0.5, "reads already see the fade");
  E.reinforceRecall(["1", "2"], []);
  const after = E.get(1, 2);
  assert.strictEqual(after.hebbian.weight, 0.5 + E.alphaPP,
    "stored = decayed + α, NOT original + α (ghost weight)");
  assert.notStrictEqual(after.hebbian.weight, 1.0 + E.alphaPP, "must not bypass decay");
  assert.strictEqual(after.hebbian.last_updated, now, "stamp last_updated at reinforce");
  assert.strictEqual(effectiveHebbian(after, now), after.hebbian.weight,
    "after reinforce, stored and effective coincide");
  assert.deepStrictEqual(after.semantic, semSnap, "semantic unmoved");
  assert.deepStrictEqual(after.provenance, originSnap, "provenance preserved");
  assert.strictEqual(after.created_at, created, "created_at is provenance only");
  assert.strictEqual(after.pruned_at, null, "already-active edge: reactivate is a no-op");
});

test("Δt=0 reinforce is byte-identical to the pre-0.3 stored+α rule (why the golden holds)", () => {
  const E = new EdgeStore(tmp("m-dt0.edges.json"), { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 1.0 }));
  E.reinforceRecall(["1", "2"], []);
  assert.strictEqual(E.weight(1, 2), 1.0 + E.alphaPP, "fresh edge: materialize is a no-op");
  assert.strictEqual(E.get(1, 2).hebbian.last_updated, T0);
  // Ledger parity at Δt=0: same number the retired path would have written.
  const L = new Ledger(tmp("m-dt0.assoc.json"));
  L.edges.set("1:2", 1.0);
  L.reinforceRecall(["1", "2"], []);
  assert.strictEqual(E.weight(1, 2), L.weight(1, 2), "Δt=0 matches Ledger.reinforceRecall");
});

test("same request id retried applies exactly once", () => {
  const E = new EdgeStore(tmp("m-once.edges.json"), { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0 }));
  const first = E.reinforceRecall(["1", "2"], [], "req-1");
  const w = E.weight(1, 2);
  assert.strictEqual(first, true);
  assert.strictEqual(w, E.alphaPP);
  const retry = E.reinforceRecall(["1", "2"], [], "req-1");
  assert.strictEqual(retry, false, "duplicate id is a no-op");
  assert.strictEqual(E.weight(1, 2), w, "weight unmoved on retry");
  assert.ok(E.hasProcessed("req-1"));
});

test("two distinct request ids reinforcing the same pair both apply", () => {
  const E = new EdgeStore(tmp("m-two.edges.json"), { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0 }));
  assert.strictEqual(E.reinforceRecall(["1", "2"], [], "req-A"), true);
  assert.strictEqual(E.reinforceRecall(["1", "2"], [], "req-B"), true);
  assert.strictEqual(E.weight(1, 2), 2 * E.alphaPP);
});

test("no-id caller applies every time (eval / non-JSON-RPC must not dedup or crash)", () => {
  const E = new EdgeStore(tmp("m-noid.edges.json"), { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0 }));
  assert.strictEqual(E.reinforceRecall(["1", "2"], []), true);
  assert.strictEqual(E.reinforceRecall(["1", "2"], [], undefined), true);
  assert.strictEqual(E.reinforceRecall(["1", "2"], [], { requestId: null }), true);
  assert.strictEqual(E.weight(1, 2), 3 * E.alphaPP, "three no-id calls → three α");
  assert.strictEqual(E.processedIds.length, 0, "no-id is never recorded");
});

test("dedup record and weight land in one durable sidecar write", () => {
  const file = tmp("m-atomic.edges.json");
  const E = new EdgeStore(file, { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.4 }));
  E.reinforceRecall(["1", "2"], [], 42);
  E.save();
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(j.kind, SIDECAR_KIND);
  assert.deepStrictEqual(j.processed_ids, [42], "id is in the same envelope as the edges");
  assert.strictEqual(j.edges["1:2"].hebbian.weight, 0.4 + E.alphaPP);
  // Reload: both facts survive one parse, which is the pair I5 cannot
  // otherwise make atomic if they were two files.
  const E2 = new EdgeStore(file, { now: () => T0 });
  assert.ok(E2.hasProcessed(42));
  assert.strictEqual(E2.weight(1, 2), 0.4 + E.alphaPP);
  assert.strictEqual(E2.reinforceRecall(["1", "2"], [], 42), false, "survives process restart");
});

test("DEDUP_LRU_SIZE bound: the oldest id is evicted and can apply again", () => {
  assert.strictEqual(DEDUP_LRU_SIZE, 256, "bound is a named constant, not a magic number");
  const E = new EdgeStore(tmp("m-lru.edges.json"), { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0 }));
  for (let i = 0; i < DEDUP_LRU_SIZE; i++) {
    assert.strictEqual(E.reinforceRecall(["1", "2"], [], "id-" + i), true);
  }
  assert.strictEqual(E.processedIds.length, DEDUP_LRU_SIZE);
  assert.ok(E.hasProcessed("id-0"), "oldest still in the window at capacity");
  // One more distinct id evicts the oldest.
  assert.strictEqual(E.reinforceRecall(["1", "2"], [], "id-new"), true);
  assert.strictEqual(E.processedIds.length, DEDUP_LRU_SIZE, "never grows past the bound");
  assert.strictEqual(E.hasProcessed("id-0"), false, "oldest evicted");
  assert.ok(E.hasProcessed("id-new"));
  const w = E.weight(1, 2);
  assert.strictEqual(E.reinforceRecall(["1", "2"], [], "id-0"), true, "evicted id applies again");
  assert.strictEqual(E.weight(1, 2), w + E.alphaPP);
});

test("materialize uses the caller-supplied half-life class (constraint vs working)", () => {
  let now = T0;
  const E = new EdgeStore(tmp("m-type.edges.json"), { now: () => now });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 1.0 }));
  now = plusIso(T0, HOUR);
  E.reinforceRecall(["1", "2"], [], { type: "working" });
  assert.strictEqual(E.weight(1, 2), 0.5 + E.alphaPP,
    "working H=1h → one hour fades to half, then +α");
});

test("numeric 0 is a real request id (not treated as no-id)", () => {
  const E = new EdgeStore(tmp("m-zero.edges.json"), { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0 }));
  assert.strictEqual(E.reinforceRecall(["1", "2"], [], 0), true);
  assert.strictEqual(E.reinforceRecall(["1", "2"], [], 0), false);
  assert.strictEqual(E.weight(1, 2), E.alphaPP);
});

test("decay-to-zero (computed) leaves the edge alive with semantic intact", () => {
  let now = T0;
  const E = new EdgeStore(tmp("decay-zero.edges.json"), { now: () => now });
  E.put(makeEdge(1, 2, {
    origin: "save-time-neighbor", now: T0, hebbianWeight: 0.4,
    semantic: { value: 0.66, src_versions: { a: 1, b: 1 } },
  }));
  now = plusIso(T0, 100 * HALF_LIFE_SECONDS.fact);   // ~700 days
  assert.ok(E.effectiveWeight(1, 2) < 1e-12, "Hebbian faded to ~0");
  assert.ok(E.get(1, 2), "edge still present (prune is 0.4, not this slice)");
  assert.strictEqual(E.get(1, 2).semantic.value, 0.66, "semantic intact at computed-zero");
  assert.strictEqual(E.weight(1, 2), 0.4, "stored weight is the source of truth, unmoved");
});

// --- Phase 0.4: soft prune + reactivation ----------------------------------
test("SEMANTIC_PRUNE_GATE matches SAVE_TIME_MIN_COS (below it, bind wouldn't create the edge)", () => {
  const { SAVE_TIME_MIN_COS: minCos } = require("./memory-core.js");
  assert.strictEqual(SEMANTIC_PRUNE_GATE, 0.25);
  assert.strictEqual(SEMANTIC_PRUNE_GATE, minCos,
    "prune gate must stay glued to the save-time bind floor (Risk #2: do not raise to 0.55)");
  assert.ok(SEMANTIC_PRUNE_GATE < 0.45, "must stay below the constraint-rescue gate");
  assert.ok(HEBBIAN_PRUNE_FLOOR < 1e-3, "~0, not the retired epoch floor of 0.05");
});

function putCombo(store, a, b, heb, sem) {
  return store.put(makeEdge(a, b, {
    origin: "save-time-neighbor", now: T0, hebbianWeight: heb,
    semantic: { value: sem, src_versions: { a: 1, b: 1 } },
  }));
}

test("pruneSweep fires only for unreinforced AND semantically weak (4 combinations)", () => {
  // Failure signature: a merged scalar prunes the strong-semantic rarely-recalled
  // pair and constraint rescue regresses (RESULTS field experiment #2).
  const E = new EdgeStore(tmp("p-4combo.edges.json"), { now: () => T0 });
  putCombo(E, 1, 2, 1.0, 0.70);   // reinforced + strong
  putCombo(E, 3, 4, 1.0, 0.10);   // reinforced + weak
  putCombo(E, 5, 6, 0, 0.70);     // unreinforced + strong  ← must SURVIVE
  putCombo(E, 7, 8, 0, 0.10);     // unreinforced + weak    ← only this prunes
  const n = E.pruneSweep();
  assert.strictEqual(n, 1, "exactly one of the four combinations prunes");
  assert.strictEqual(E.get(1, 2).pruned_at, null, "reinforced+strong stays");
  assert.strictEqual(E.get(3, 4).pruned_at, null, "reinforced+weak stays (Hebbian is enough)");
  assert.strictEqual(E.get(5, 6).pruned_at, null, "unreinforced+strong stays (the two-signal rule)");
  assert.strictEqual(E.get(7, 8).pruned_at, T0, "unreinforced+weak is the only prune");
  assert.strictEqual(E.get(7, 8).prune_count, 1);
  assert.strictEqual(E.get(7, 8).first_pruned_at, T0);
});

test("semantic exactly at the prune gate survives (same >= as save-time bind)", () => {
  const E = new EdgeStore(tmp("p-gate.edges.json"), { now: () => T0 });
  putCombo(E, 1, 2, 0, SEMANTIC_PRUNE_GATE);          // 0.25 on the gate
  putCombo(E, 3, 4, 0, SEMANTIC_PRUNE_GATE - 1e-9);    // just under
  E.pruneSweep();
  assert.strictEqual(E.get(1, 2).pruned_at, null, "0.25 is worth persisting");
  assert.ok(E.get(3, 4).pruned_at, "just under 0.25 prunes when unreinforced");
});

test("null/empty semantic is weak: unreinforced migrated edges prune", () => {
  const E = new EdgeStore(tmp("p-nullsem.edges.json"), { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0, migrated_from: "assoc.json" }));
  E.put(makeEdge(3, 4, { origin: "co-activation", now: T0, hebbianWeight: 0.8, migrated_from: "assoc.json" }));
  E.pruneSweep();
  assert.ok(E.get(1, 2).pruned_at, "no semantic + no Hebbian → prune");
  assert.strictEqual(E.get(3, 4).pruned_at, null, "no semantic but still reinforced → keep");
});

test("decayed-to-~0 Hebbian counts as unreinforced (effective, not stored)", () => {
  let now = T0;
  const E = new EdgeStore(tmp("p-decayed.edges.json"), { now: () => now });
  putCombo(E, 1, 2, 0.4, 0.10);   // will be unreinforced+weak after idle
  putCombo(E, 3, 4, 0.4, 0.70);   // will be unreinforced+strong after idle
  now = plusIso(T0, 100 * HALF_LIFE_SECONDS.fact);
  assert.ok(E.effectiveWeight(1, 2) < HEBBIAN_PRUNE_FLOOR);
  assert.ok(E.effectiveWeight(3, 4) < HEBBIAN_PRUNE_FLOOR);
  assert.strictEqual(E.weight(1, 2), 0.4, "stored is unmoved until a mutation");
  const n = E.pruneSweep();
  assert.strictEqual(n, 1);
  assert.ok(E.get(1, 2).pruned_at, "faded + weak prunes");
  assert.strictEqual(E.get(3, 4).pruned_at, null, "faded + strong survives (constraint-rescue case)");
  assert.strictEqual(E.get(1, 2).hebbian.weight, 0.4, "soft prune keeps the decayed stored weight");
  assert.strictEqual(E.get(1, 2).hebbian.last_updated, T0, "prune does not stamp last_updated");
});

test("a semantically-strong unreinforced edge still serves constraint-rescue after a sweep", () => {
  // The live field.js walk rebuilds from embeddings (it does not yet read
  // this table), but the failure signature is about THIS record vanishing.
  // incident() is the retrieval surface a later rescue walk would use.
  const E = new EdgeStore(tmp("p-rescue.edges.json"), { now: () => T0 });
  putCombo(E, "lemon", "diabetic", 0, 0.60);   // >= CONSTRAINT_GATE 0.45
  putCombo(E, "lemon", "noise", 0, 0.10);
  E.pruneSweep();
  assert.strictEqual(E.get("lemon", "diabetic").pruned_at, null, "bridge survived");
  const inc = E.incident("lemon");
  assert.strictEqual(inc.length, 1, "weak noise pruned out of retrieval");
  assert.strictEqual(inc[0].b === "diabetic" || inc[0].a === "diabetic", true);
  assert.ok(inc[0].semantic.value >= 0.45, "surviving bridge still clears the rescue gate");
});

test("I8: pruned edges are excluded from retrieval but the record persists and reloads", () => {
  const file = tmp("p-i8.edges.json");
  const E = new EdgeStore(file, { now: () => T0 });
  putCombo(E, 1, 2, 0, 0.10);
  putCombo(E, 1, 3, 0, 0.70);
  E.pruneSweep();
  assert.strictEqual(E.size, 2, "soft prune does not drop the record");
  assert.ok(E.get(1, 2), "get() still returns the pruned row");
  assert.ok(E.get(1, 2).pruned_at);
  assert.strictEqual(E.incident(1).length, 1, "incident() skips pruned_at != null");
  assert.strictEqual(E.weight(1, 2), 0, "weight() of a pruned edge is 0");
  assert.strictEqual(E.bonus(1, 2), 0, "bonus() of a pruned edge is 0");
  assert.ok(E.hasPruned());
  // Reload: the marker survives, the row survives.
  const E2 = new EdgeStore(file, { now: () => T0 });
  assert.strictEqual(E2.size, 2);
  assert.ok(E2.get(1, 2).pruned_at);
  assert.strictEqual(E2.get(1, 2).prune_count, 1);
  assert.strictEqual(E2.incident(1).length, 1);
});

test("a second pruneSweep of an already-pruned edge is a no-op (prune_count stays 1)", () => {
  const E = new EdgeStore(tmp("p-twice.edges.json"), { now: () => T0 });
  putCombo(E, 1, 2, 0, 0.10);
  assert.strictEqual(E.pruneSweep(), 1);
  assert.strictEqual(E.pruneSweep(), 0);
  assert.strictEqual(E.get(1, 2).prune_count, 1);
});

test("reactivate preserves created_at, prune_count, first_pruned_at, and the decayed weight", () => {
  let now = T0;
  const E = new EdgeStore(tmp("p-re.edges.json"), { now: () => now });
  const created = T0;
  E.put(makeEdge(1, 2, {
    origin: "co-activation", now: created, hebbianWeight: 1.0,
    semantic: { value: 0.10, src_versions: { a: 1, b: 1 } },
  }));
  now = plusIso(T0, 100 * HALF_LIFE_SECONDS.fact);
  const faded = E.effectiveWeight(1, 2);
  assert.ok(faded < HEBBIAN_PRUNE_FLOOR);
  E.pruneSweep();
  const prunedAt = E.get(1, 2).pruned_at;
  now = plusIso(now, 60);
  const n = E.reactivateIncident(1);
  assert.strictEqual(n, 1);
  const after = E.get(1, 2);
  assert.strictEqual(after.pruned_at, null);
  assert.strictEqual(after.created_at, created, "created_at is provenance — never reset");
  assert.strictEqual(after.prune_count, 1, "bounded history keeps the count");
  assert.strictEqual(after.first_pruned_at, prunedAt);
  assert.strictEqual(after.last_reactivated_at, now);
  assert.strictEqual(after.hebbian.weight, 1.0, "stored weight is not snapped to a new full value");
  assert.strictEqual(after.hebbian.last_updated, created, "last_updated unmoved — that would make it 'full' again");
  assert.ok(effectiveHebbian(after, now) < HEBBIAN_PRUNE_FLOOR, "effective still decayed");
  assert.strictEqual(E.incident(1).length, 1, "back in retrieval");
});

test("reactivate of an already-active edge is a no-op (last_reactivated_at stays null)", () => {
  const E = new EdgeStore(tmp("p-re-noop.edges.json"), { now: () => T0 });
  putCombo(E, 1, 2, 0, 0.70);
  assert.strictEqual(E.reactivateIncident(1), 0);
  assert.strictEqual(E.get(1, 2).last_reactivated_at, null);
  assert.strictEqual(E.get(1, 2).pruned_at, null);
});

test("reinforce of a pruned edge reactivates then materializes+α (does not reset to original)", () => {
  let now = T0;
  const E = new EdgeStore(tmp("p-re-bump.edges.json"), { now: () => now });
  putCombo(E, 1, 2, 1.0, 0.10);
  now = plusIso(T0, HALF_LIFE_SECONDS.fact);   // effective = 0.5; still above floor, so force-mark
  markPruned(E.get(1, 2), now);
  E.reinforceRecall(["1", "2"], []);
  const after = E.get(1, 2);
  assert.strictEqual(after.pruned_at, null, "reinforce revives");
  assert.strictEqual(after.last_reactivated_at, now);
  assert.strictEqual(after.hebbian.weight, 0.5 + E.alphaPP, "decayed+α, not original+α");
  assert.strictEqual(after.created_at, T0);
});

test("hard vacuum drops pruned edges and is explicit (does not run from pruneSweep)", () => {
  const file = tmp("p-vac.edges.json");
  const E = new EdgeStore(file, { now: () => T0 });
  putCombo(E, 1, 2, 0, 0.10);
  putCombo(E, 3, 4, 0, 0.70);
  E.pruneSweep();
  assert.strictEqual(E.size, 2, "sweep is soft");
  assert.strictEqual(E.vacuum(), 1, "vacuum returns remaining count, like JsonlStore");
  assert.strictEqual(E.get(1, 2), undefined, "pruned row is gone");
  assert.ok(E.get(3, 4), "active row kept");
  const E2 = new EdgeStore(file, { now: () => T0 });
  assert.strictEqual(E2.size, 1);
  assert.strictEqual(E2.get(1, 2), undefined);
});

test("pruneSweep with nothing to prune does not rewrite the sidecar", () => {
  const file = tmp("p-nowrite.edges.json");
  const E = new EdgeStore(file, { now: () => T0 });
  putCombo(E, 1, 2, 1.0, 0.70);
  E.save();
  const before = fs.readFileSync(file, "utf8");
  const mtime = fs.statSync(file).mtimeMs;
  assert.strictEqual(E.pruneSweep(), 0);
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
});

test("shouldPrune helpers: the two-signal conjunction is the whole predicate", () => {
  const strong = makeEdge(1, 2, {
    origin: "save-time-neighbor", now: T0, hebbianWeight: 0,
    semantic: { value: 0.70, src_versions: { a: 1, b: 1 } },
  });
  const weak = makeEdge(3, 4, {
    origin: "save-time-neighbor", now: T0, hebbianWeight: 0,
    semantic: { value: 0.10, src_versions: { a: 1, b: 1 } },
  });
  assert.strictEqual(isSemanticallyWeak(strong), false);
  assert.strictEqual(isSemanticallyWeak(weak), true);
  assert.strictEqual(isUnreinforced(strong, T0), true);
  assert.strictEqual(shouldPrune(strong, T0), false, "strong unreinforced must not prune");
  assert.strictEqual(shouldPrune(weak, T0), true);
  markPruned(weak, T0);
  assert.strictEqual(shouldPrune(weak, T0), false, "already pruned → sweep no-op");
  reactivateEdge(weak, T0);
  assert.strictEqual(weak.pruned_at, null);
  assert.strictEqual(weak.prune_count, 1);
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

// ------------------------------------------------- warm field (Phase 1 / PR1)
// Tests construct WarmField DIRECTLY. Pre-declared Phase 1 metrics from the
// warm-field design: A→B raises E, stronger sim → higher E, thisTurn-only
// spread, 1-hop bound, split clocks, restart-empty, forget, I7 disk-scan.
section("warm field (Phase 1)");

const {
  WarmField, shouldSpread, vectorCount, emitWarmTrace,
} = require("./warm.js");
const {
  createCore, defaultGetEdges, cosine: coreCosine,
  bindSaveTimeNeighbors, SAVE_TIME_K, SAVE_TIME_MIN_COS,
} = require("./memory-core.js");

const LAMBDA_TURN = 0.357;
const turnDecay = (e, turns) => e * Math.exp(-LAMBDA_TURN * turns);

function chainEdges(pairs) {
  const m = new Map();
  for (const [a, b, sim] of pairs) {
    if (!m.has(a)) m.set(a, []);
    m.get(a).push({ id: b, sim });
  }
  return m;
}

test("A activating raises B through A↔B", () => {
  const W = new WarmField();
  W.seed(["A"]);
  assert.strictEqual(W.get("B"), 0, "B is cold before spread");
  W.spread(chainEdges([["A", "B", 0.8]]));
  assert.ok(W.get("B") > 0, "B received energy through A↔B");
  assert.ok(Math.abs(W.get("B") - 0.8) < 1e-12, "E_B = E_A * sim");
});

test("stronger sim yields higher E_B (max-not-sum contract)", () => {
  const strong = new WarmField();
  const weak = new WarmField();
  strong.seed(["A"]);
  weak.seed(["A"]);
  strong.spread(chainEdges([["A", "B", 0.9]]));
  weak.spread(chainEdges([["A", "B", 0.6]]));
  assert.ok(strong.get("B") > weak.get("B"), "0.9 sim transmits more than 0.6");

  // max, not sum: a second weaker incoming must not add
  strong.seed(["A"]);
  strong.spread(chainEdges([["A", "B", 0.5]]));
  assert.ok(Math.abs(strong.get("B") - 0.9) < 1e-12, "max keeps 0.9, does not sum to 1.4");
});

test("spread iterates thisTurn only; a previously-warm node does not re-spread", () => {
  const W = new WarmField();
  const edges = chainEdges([
    ["A", "B", 0.9],
    ["B", "C", 0.9],
    ["X", "Z", 0.9],
  ]);
  W.seed(["A"]);
  W.spread(edges);                       // B warms; C does not (1-hop)
  const eB = W.get("B");
  assert.ok(eB > 0);
  W.decayAll({ turns: 1 });
  const eBDecayed = W.get("B");
  assert.ok(eBDecayed < eB);
  W.seed(["X"]);                         // thisTurn = {X} only; A is warm but not re-seeded
  W.spread(edges);                       // must NOT re-spread from A (which would refresh B)
  assert.ok(Math.abs(W.get("B") - eBDecayed) < 1e-12, "B held its decayed value; A did not re-spread");
  assert.ok(W.get("Z") > 0, "X's neighbor DID warm");
});

test("value === 1.0 is not the seed test (sim=1.0 neighbor does not re-spread)", () => {
  const W = new WarmField();
  // A seeds at 1.0, B receives sim=1.0 so B.value === 1.0. If spread used
  // value===1.0 as the seed test, B would then warm C in the same tick.
  W.seed(["A"]);
  W.spread(chainEdges([["A", "B", 1.0], ["B", "C", 1.0]]));
  assert.strictEqual(W.get("B"), 1.0);
  assert.strictEqual(W.get("C"), 0, "C stayed cold: B was not a thisTurn source");
});

test("hops=1 does not warm a 2-hop neighbor", () => {
  const W = new WarmField({ hops: 1 });
  W.seed(["A"]);
  W.spread(chainEdges([["A", "B", 0.9], ["B", "C", 0.9]]));
  assert.ok(W.get("B") > 0, "1-hop B warms");
  assert.strictEqual(W.get("C"), 0, "2-hop C stays cold at hops=1");
});

test("decayAll({ turns: 1 }) is λ_turn, not wall-clock seconds", () => {
  let t = 1_000_000;
  const W = new WarmField({ now: () => t, lambdaTurn: LAMBDA_TURN, lambdaWall: 0 });
  W.seed(["A"], 1.0);
  t += 5000;                             // 5s wall pause
  W.decayAll({ turns: 1 });
  const got = W.get("A");
  const expected = turnDecay(1.0, 1);    // ≈ 0.700
  assert.ok(Math.abs(got - expected) < 1e-10, "E * exp(-λ_turn), got " + got);
  assert.ok(got > 0.6, "5s wall pause with λ_wall=0 must not dump energy (~0.12 would mean seconds fed into λ_turn)");
});

test("λ_wall=0: a 5s pause does not dump energy even across two decays", () => {
  let t = 0;
  const W = new WarmField({ now: () => t, lambdaWall: 0 });
  W.seed(["A"], 1.0);
  t += 5000;
  W.decayAll({ turns: 1 });
  t += 5000;
  W.decayAll({ turns: 1 });
  const expected = turnDecay(1.0, 2);
  assert.ok(Math.abs(W.get("A") - expected) < 1e-10);
});

test("below floor ⇒ dropped", () => {
  const W = new WarmField({ floor: 0.1, lambdaTurn: 10 });
  W.seed(["A"], 0.12);
  W.decayAll({ turns: 1 });              // 0.12 * exp(-10) << 0.1
  assert.strictEqual(W.get("A"), 0);
});

test("idle TTL clears the map", () => {
  let t = 0;
  const W = new WarmField({ now: () => t, idleMs: 1000 });
  W.seed(["A"], 1.0);
  t = 1001;
  W.decayAll({ turns: 1 });
  assert.strictEqual(W.get("A"), 0, "idle TTL wiped the session");
  assert.strictEqual(W.thisTurn.size, 0);
});

test("a new WarmField() is empty (restart)", () => {
  const live = new WarmField();
  live.seed(["A"]);
  live.spread(chainEdges([["A", "B", 0.9]]));
  assert.ok(live.get("A") > 0 && live.get("B") > 0);
  const restarted = new WarmField();
  assert.strictEqual(restarted.get("A"), 0);
  assert.strictEqual(restarted.get("B"), 0);
  assert.strictEqual(restarted.nodes.size, 0);
});

test("forget drops a node so it cannot resurrect", () => {
  const W = new WarmField();
  W.seed(["A", "B"]);
  W.forget("A");
  assert.strictEqual(W.get("A"), 0);
  assert.ok(W.get("B") > 0);
  assert.ok(!W.thisTurn.has("A"));
});

test("cap evicts lowest-E first", () => {
  const W = new WarmField({ cap: 2 });
  W.nodes.set("low", { value: 0.2, ts: 1 });
  W.nodes.set("mid", { value: 0.5, ts: 1 });
  W.nodes.set("high", { value: 0.9, ts: 1 });
  W._evictCap();
  assert.strictEqual(W.nodes.size, 2);
  assert.strictEqual(W.get("low"), 0);
  assert.ok(W.get("mid") > 0 && W.get("high") > 0);
});

test("trace(id) is callable and matches get(id)", () => {
  const W = new WarmField();
  W.seed(["A"], 1.0);
  assert.strictEqual(W.trace("A"), 1.0);
  assert.strictEqual(W.trace("missing"), 0);
  assert.strictEqual(W.trace("A"), W.get("A"));
});

test("defaultGetEdges ALWAYS returns a Map, never null", () => {
  const empty = defaultGetEdges([], null);
  assert.ok(empty instanceof Map, "empty store");
  const noVec = defaultGetEdges([{ id: 1, text: "x" }], null);
  assert.ok(noVec instanceof Map, "vectorless records still a Map");
  const withVec = defaultGetEdges([
    { id: 1, text: "a", embedding: [1, 0] },
    { id: 2, text: "b", embedding: [0, 1] },
  ], null);
  assert.ok(withVec instanceof Map);
});

test("WARM_EDGE_CAP gates shouldSpread only (512 default; 0 is a real cap)", () => {
  const many = Array.from({ length: 513 }, (_, i) => ({ id: i, embedding: [1] }));
  assert.strictEqual(shouldSpread(many, 512), false);
  assert.strictEqual(shouldSpread(many.slice(0, 512), 512), true);
  assert.strictEqual(shouldSpread([{ id: 1, embedding: [1] }], 0), false, "cap 0 skips spread");
  assert.strictEqual(vectorCount([{ id: 1 }, { id: 2, embedding: [1] }]), 1);
});

test("emitWarmTrace is callable and does not throw (hot path is `if (warmTrace())`)", () => {
  // The helper itself stringifies; the hot-path contract is `if (warmTrace()) emit…`
  // so a false flag is one boolean and no stringify. Don't print into the test run.
  const W = new WarmField();
  W.seed(["A"]);
  const orig = process.stderr.write;
  const writes = [];
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try {
    emitWarmTrace(W, { query: "x", primary: ["A"] });
    emitWarmTrace(null, { query: "x", primary: [] });
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(writes.some((s) => s.indexOf("[warm-trace]") === 0));
  assert.ok(writes.some((s) => /"activation"/.test(s)), "activation is its own field");
});

// ------------------------------------------------ edit() embedding safety
// An embedder outage is transient; losing an embedding is not.
// createCore already required above (warm-field section)

async function asyncTests() {
  section("edit() embedding safety");

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

  // ------------------------------------------------ embedding_version (Phase 0.0)
  // Validity of cached semantic edges is a version comparison. These four
  // (plus the attack cases) must fail without the schema change / lockstep bump.
  section("embedding_version");

  await atest("a fresh save is embedding_version 1", async () => {
    const ref = { live: true };
    const { store, core } = makeCore("embver-save.jsonl", ref);
    await core.save("brand new memory");
    assert.strictEqual(store.all()[0].embedding_version, 1);
  });

  await atest("a successful edit() re-embed increments embedding_version", async () => {
    const ref = { live: true };
    const store = new JsonlStore(tmp("embver-edit.jsonl"));
    let vec = [1, 0, 0];
    const embed = async (texts) => texts.map(() => vec.slice());
    const core = createCore({ store, embed });
    await core.save("first");
    assert.strictEqual(store.all()[0].embedding_version, 1, "save starts at 1");
    vec = [0, 1, 0];
    await core.edit(store.all()[0].id, "second");
    assert.strictEqual(store.all()[0].embedding_version, 2, "first re-embed -> 2");
    assert.deepStrictEqual(store.all()[0].embedding, [0, 1, 0]);
    vec = [0, 0, 1];
    await core.edit(store.all()[0].id, "third");
    assert.strictEqual(store.all()[0].embedding_version, 3, "second re-embed -> 3");
  });

  await atest("a dead embedder does NOT increment embedding_version AND keeps the vector", async () => {
    const ref = { live: true };
    const { store, core } = makeCore("embver-dead.jsonl", ref);
    await core.save("the dentist is on Tuesday");
    const before = store.all()[0];
    assert.strictEqual(before.embedding_version, 1);
    assert.ok(Array.isArray(before.embedding) && before.embedding.length === 3);

    ref.live = false;
    const id = before.id;
    const msg = await core.edit(id, "the dentist is on Thursday");
    const after = store.all()[0];
    assert.strictEqual(after.text, "the dentist is on Thursday", "text still updates");
    assert.strictEqual(after.embedding_version, 1, "failed embed must not bump the version");
    assert.deepStrictEqual(after.embedding, before.embedding, "prior embedding survives (BUG-008)");
    assert.ok(/keyword/i.test(msg), "degraded state is reported");
  });

  await atest("a save with a dead embedder is still version 1 (not 0, not missing)", async () => {
    const ref = { live: false };
    const { store, core } = makeCore("embver-save-dead.jsonl", ref);
    await core.save("saved while the embedder was down");
    const rec = store.all()[0];
    assert.strictEqual(rec.embedding_version, 1);
    assert.strictEqual(rec.embedding, null, "no vector, but version is still 1");
  });

  await atest("embed returning empty/null without throwing does not bump or clobber", async () => {
    // The throw path is the common outage; a broken embedder that returns a
    // hole instead of throwing is the same class and must take the omit path.
    const store = new JsonlStore(tmp("embver-hole.jsonl"));
    let mode = "ok";
    const embed = async (texts) => {
      if (mode === "ok") return texts.map(() => [1, 0, 0]);
      if (mode === "empty") return texts.map(() => []);
      return texts.map(() => null);
    };
    const core = createCore({ store, embed });
    await core.save("original");
    const before = store.all()[0];
    mode = "empty";
    await core.edit(before.id, "edited with empty vector");
    let after = store.all()[0];
    assert.strictEqual(after.embedding_version, 1, "empty array is not a successful re-embed");
    assert.deepStrictEqual(after.embedding, before.embedding);
    mode = "null";
    await core.edit(before.id, "edited with null vector");
    after = store.all()[0];
    assert.strictEqual(after.embedding_version, 1, "null vector is not a successful re-embed");
    assert.deepStrictEqual(after.embedding, before.embedding);
    assert.strictEqual(after.text, "edited with null vector");
  });

  await atest("exact restatement confirm does not increment embedding_version", async () => {
    const ref = { live: true };
    const { store, core } = makeCore("embver-confirm.jsonl", ref);
    await core.save("I drink tea");
    const id = store.all()[0].id;
    await core.save("I drink tea");          // confirm, not a new row
    assert.strictEqual(store.all().length, 1);
    assert.strictEqual(store.get(id).embedding_version, 1);
  });

  section("warm hook in createCore (silent, flags-off default)");

  // Orthogonal embeddings so ranking is deterministic: query [1,0] hits A, then B.
  const pack = {
    "alpha lives here": [1, 0],
    "beta is nearby": [0.8, 0.6],
    "gamma is far away": [0, 1],
    "alpha": [1, 0],
  };
  const packEmbed = async (texts) => texts.map((t) => pack[t] || [0, 1]);

  function scanActivation(dir) {
    const FORBIDDEN = /^(energy|resonance|activation|current_resonance|warmth|warm_field)$/i;
    const hits = [];
    function walk(v, file, pth) {
      if (!v || typeof v !== "object") return;
      for (const [k, val] of Object.entries(v)) {
        if (FORBIDDEN.test(k)) hits.push(file + ":" + pth + k);
        walk(val, file, pth + k + ".");
      }
    }
    if (!fs.existsSync(dir)) return hits;
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      if (fs.statSync(fp).isDirectory()) {
        hits.push(...scanActivation(fp).map((h) => name + "/" + h));
        continue;
      }
      if (/\b(warm|activation|energy|resonance)\b/i.test(name)) {
        hits.push("filename:" + name);
      }
      const raw = fs.readFileSync(fp, "utf8");
      for (const line of raw.split("\n").filter(Boolean)) {
        try { walk(JSON.parse(line), name, ""); } catch { /* not json */ }
      }
    }
    return hits;
  }

  await atest("flags-off recall is byte-identical to a core with no warm injection", async () => {
    const store = new JsonlStore(tmp("warm-off.jsonl"));
    const a = createCore({ store, embed: packEmbed });
    await a.save("alpha lives here");
    await a.save("beta is nearby");
    const off = await a.recall("alpha");
    const b = createCore({ store, embed: packEmbed, warmEnabled: () => false });
    const alsoOff = await b.recall("alpha");
    assert.strictEqual(alsoOff, off);
  });

  await atest("warm-ENABLED-but-unconsumed recall is byte-identical to warm-off", async () => {
    const store = new JsonlStore(tmp("warm-silent.jsonl"));
    const W = new WarmField();
    const offCore = createCore({ store, embed: packEmbed });
    await offCore.save("alpha lives here");
    await offCore.save("beta is nearby");
    await offCore.save("gamma is far away");
    const off = await offCore.recall("alpha");

    const onCore = createCore({
      store, embed: packEmbed,
      warmEnabled: () => true,
      getWarm: () => W,
      saveSeed: () => false,
    });
    const on = await onCore.recall("alpha");
    assert.strictEqual(on, off, "silent hook must not change the output string");
    assert.ok(W.nodes.size > 0, "decay/seed/spread actually ran (map is not empty)");
    const primaryId = String(store.current()[0].id);
    // ranked order is cosine, first listing is the top hit — seed it at 1.0
    assert.ok(/\[id /.test(on));
    const seeded = [...W.nodes.entries()].some(([, n]) => n.value === 1.0);
    assert.ok(seeded, "at least one node seeded at E=1.0");
    void primaryId;
  });

  await atest("warmth survives a second recall on the same core (session = process)", async () => {
    const store = new JsonlStore(tmp("warm-session.jsonl"));
    const W = new WarmField();
    const core = createCore({
      store, embed: packEmbed,
      warmEnabled: () => true,
      getWarm: () => W,
      saveSeed: () => false,
    });
    await core.save("alpha lives here");
    await core.save("beta is nearby");
    await core.recall("alpha");
    const sizeAfterFirst = W.nodes.size;
    assert.ok(sizeAfterFirst > 0);
    await core.recall("alpha");
    assert.ok(W.nodes.size > 0, "second recall did not wipe the map");
  });

  await atest("forget-after-remove: a deleted id is not warm", async () => {
    const store = new JsonlStore(tmp("warm-forget.jsonl"));
    const W = new WarmField();
    const core = createCore({
      store, embed: packEmbed,
      warmEnabled: () => true,
      getWarm: () => W,
      saveSeed: () => false,
    });
    await core.save("alpha lives here");
    await core.save("beta is nearby");
    await core.recall("alpha");
    const id = store.current()[0].id;
    assert.ok(W.get(id) > 0, "id was seeded");
    core.remove(id);
    assert.strictEqual(W.get(id), 0, "remove forgot the id");
  });

  await atest("I3: a throwing getEdges degrades to plain cosine, does not break recall", async () => {
    const store = new JsonlStore(tmp("warm-i3.jsonl"));
    const off = createCore({ store, embed: packEmbed });
    await off.save("alpha lives here");
    await off.save("beta is nearby");
    const expected = await off.recall("alpha");
    const on = createCore({
      store, embed: packEmbed,
      warmEnabled: () => true,
      getEdges: () => { throw new Error("edges boom"); },
    });
    const got = await on.recall("alpha");
    assert.strictEqual(got, expected, "cosine output survives a warm-path throw");
  });

  await atest("I7: after a warm recall, no activation-shaped key is on disk", async () => {
    const dir = path.join(tmpRoot, "warm-i7");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "store.jsonl");
    const store = new JsonlStore(file);
    const W = new WarmField();
    const core = createCore({
      store, embed: packEmbed,
      warmEnabled: () => true,
      getWarm: () => W,
      saveSeed: () => false,
    });
    await core.save("alpha lives here");
    await core.save("beta is nearby");
    await core.recall("alpha");
    assert.ok(W.nodes.size > 0, "warmth existed in RAM");
    const hits = scanActivation(dir);
    assert.deepStrictEqual(hits, [], "I7 violated: " + hits.join(", "));
    // Belt: the in-proc map is the only copy — a new WarmField cannot see it.
    assert.strictEqual(new WarmField().get([...W.nodes.keys()][0]), 0);
  });

  await atest("shouldSpread false still seeds, but does not spread (cap at spread only)", async () => {
    const store = new JsonlStore(tmp("warm-cap.jsonl"));
    const W = new WarmField();
    const core = createCore({
      store, embed: packEmbed,
      warmEnabled: () => true,
      getWarm: () => W,
      saveSeed: () => false,
      warmEdgeCap: () => 0,              // skip spread
      getEdges: () => chainEdges([["will-not", "matter", 1]]),
    });
    await core.save("alpha lives here");
    await core.save("beta is nearby");
    const out = await core.recall("alpha");
    assert.ok(/alpha lives here/.test(out));
    const seeded = [...W.entries()].filter(([, n]) => n.value === 1.0);
    assert.ok(seeded.length > 0, "seed still happens when cap skips spread");
    // With cap 0, getEdges is not consulted for spread; only thisTurn seeds exist at 1.0
    const extras = [...W.entries()].filter(([, n]) => n.value > 0 && n.value < 1.0);
    assert.strictEqual(extras.length, 0, "no spread energy when shouldSpread is false");
  });

  // ------------------------------------------------ Slice C: EdgeStore on the live path
  section("Slice C: EdgeStore wired into recall");

  function primaryBlock(out) {
    const i = String(out).indexOf("\n\nRelated:");
    return i < 0 ? String(out) : String(out).slice(0, i);
  }

  const DIABETIC = "I'm diabetic, so no sugary desserts for me";
  const LEMON = "I always bring lemon bars to the potluck";
  const MEETING = "The quarterly planning meeting is on Tuesday";
  const DESSERT_Q = "dessert for the potluck";
  const rescueVec = {
    [DIABETIC]: [1, 0],
    [LEMON]: [0.6, 0.8],          // cos(diabetic, lemon) = 0.60 >= CONSTRAINT_GATE 0.45
    [MEETING]: [0, 1],
    [DESSERT_Q]: [0.6, 0.8],      // ranks lemon first, meeting second, diabetic third
  };

  function liveField(file, fieldOn, opts = {}) {
    const store = new JsonlStore(tmp(file));
    const edgesPath = opts.edgesPath || tmp(file + ".edges.json");
    const embed = async (texts) => texts.map((t) => rescueVec[t] || [0, 0, 1]);
    let _e = null;
    const getEdgeStore = opts.getEdgeStore || (() => {
      if (!_e) _e = new EdgeStore(edgesPath, { now: () => T0 });
      return _e;
    });
    const core = createCore({
      store, embed,
      fieldEnabled: () => fieldOn,
      getEdgeStore,
    });
    return { store, core, edgesPath, edges: () => getEdgeStore() };
  }

  await atest("constraint-rescue still fires through recall (field experiment #2)", async () => {
    const { core } = liveField("c-rescue.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const out = await core.recall(DESSERT_Q, 1);
    assert.ok(/lemon bars/.test(out), "bridge is the cosine primary");
    assert.ok(!primaryBlock(out).includes("diabetic"), "constraint is NOT in the returned top-k");
    assert.ok(/\n\nRelated:/.test(out), "Related: block present");
    assert.ok(/diabetic/.test(out), "constraint rescued into Related via the lemon-bars bridge");
  });

  await atest("I9: field-on vs field-off primary results are byte-identical", async () => {
    // Same store, two cores: ids must not drift or the primary strings won't match.
    const seeded = liveField("c-i9.jsonl", false);
    await seeded.core.save(DIABETIC);
    await seeded.core.save(LEMON);
    await seeded.core.save(MEETING);
    const embed = async (texts) => texts.map((t) => rescueVec[t] || [0, 0, 1]);
    const off = createCore({
      store: seeded.store, embed, fieldEnabled: () => false,
      getEdgeStore: () => new EdgeStore(tmp("c-i9-off.edges.json")),
    });
    const on = createCore({
      store: seeded.store, embed, fieldEnabled: () => true,
      getEdgeStore: () => new EdgeStore(tmp("c-i9-on.edges.json")),
    });
    const offOut = await off.recall(DESSERT_Q, 1);
    const onOut = await on.recall(DESSERT_Q, 1);
    assert.strictEqual(primaryBlock(onOut), primaryBlock(offOut), "I9: primary cosine must not move");
    assert.strictEqual(primaryBlock(onOut), offOut, "field-off has no Related: tail");
    assert.ok(/\n\nRelated:/.test(onOut), "field-on is allowed to append Related:");
  });

  await atest("I3: corrupt .edges.json still returns cosine; recall does not throw", async () => {
    const seeded = liveField("c-i3.jsonl", false);
    await seeded.core.save(DIABETIC);
    await seeded.core.save(LEMON);
    await seeded.core.save(MEETING);
    const embed = async (texts) => texts.map((t) => rescueVec[t] || [0, 0, 1]);
    const offOut = await createCore({
      store: seeded.store, embed, fieldEnabled: () => false,
    }).recall(DESSERT_Q, 1);
    const edgesPath = tmp("c-i3.edges.json");
    fs.writeFileSync(edgesPath, "{ this is not json");
    let out;
    await assert.doesNotReject(async () => {
      out = await createCore({
        store: seeded.store, embed, fieldEnabled: () => true,
        getEdgeStore: () => new EdgeStore(edgesPath),
      }).recall(DESSERT_Q, 1);
    });
    assert.ok(/lemon bars/.test(out), "cosine primary survived a corrupt sidecar");
    assert.strictEqual(primaryBlock(out), offOut, "corrupt sidecar degrades to plain cosine");
  });

  await atest("I3: a throwing getEdgeStore degrades to plain cosine", async () => {
    const seeded = liveField("c-i3-throw.jsonl", false);
    await seeded.core.save(DIABETIC);
    await seeded.core.save(LEMON);
    const embed = async (texts) => texts.map((t) => rescueVec[t] || [0, 0, 1]);
    const expected = await createCore({
      store: seeded.store, embed, fieldEnabled: () => false,
    }).recall(DESSERT_Q, 1);
    const got = await createCore({
      store: seeded.store, embed, fieldEnabled: () => true,
      getEdgeStore: () => { throw new Error("edges boom"); },
    }).recall(DESSERT_Q, 1);
    assert.strictEqual(got, expected, "throw from getEdgeStore must not escape recall()");
  });

  await atest("I5: reinforcement writes .edges.json and never the JSONL store", async () => {
    const { core, store, edgesPath } = liveField("c-i5.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const jsonlBytes = fs.readFileSync(store.file, "utf8");
    const assocPath = edgesPath.replace(/\.edges\.json$/, ".assoc.json");
    const out = await core.recall(DESSERT_Q, 1);
    assert.ok(/lemon bars/.test(out));
    assert.strictEqual(fs.readFileSync(store.file, "utf8"), jsonlBytes, "recall must not rewrite the JSONL store");
    assert.ok(fs.existsSync(edgesPath), "reinforcement persisted to .edges.json");
    assert.strictEqual(fs.existsSync(assocPath), false, "must not write the retired .assoc.json");
    const j = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
    assert.strictEqual(j.kind, SIDECAR_KIND);
    assert.strictEqual(j.recalls, 0, "epoch clock is no longer advanced on recall (I6)");
    assert.ok(Object.keys(j.edges).length >= 1, "co-recall wrote at least one Hebbian edge");
  });

  await atest("edit() does not write the edge store (transition table)", async () => {
    const { core, store, edgesPath } = liveField("c-edit.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    await core.recall(DESSERT_Q, 1);
    const before = fs.readFileSync(edgesPath, "utf8");
    const id = store.current().find((m) => m.text === MEETING).id;
    await core.edit(id, MEETING);   // re-embed, bump embedding_version; no edge write
    assert.strictEqual(fs.readFileSync(edgesPath, "utf8"), before, "edit must not touch .edges.json");
  });

  await atest("legacy .assoc.json bonuses survive through recall (storage move ≠ number move)", async () => {
    const file = tmp("c-mig.jsonl");
    const store = new JsonlStore(file);
    const assoc = file + ".assoc.json";
    const edges = file + ".edges.json";
    const embed = async (texts) => texts.map((t) => rescueVec[t] || [0, 0, 1]);
    const off = createCore({ store, embed, fieldEnabled: () => false });
    await off.save(DIABETIC);
    await off.save(LEMON);
    await off.save(MEETING);
    const ids = store.current().map((m) => String(m.id));
    // Seed a learned weight between lemon and diabetic that Ledger would have held.
    writeLegacyAssoc(assoc, { [ [ids[0], ids[1]].sort().join(":") ]: 0.8 });
    const L = new Ledger(assoc);
    let _e = null;
    const on = createCore({
      store, embed,
      fieldEnabled: () => true,
      getEdgeStore: () => { if (!_e) _e = new EdgeStore(edges, { now: () => T0 }); return _e; },
    });
    // Constructing the store (first field-on recall) migrates. Bonuses must match
    // Ledger's reading of the same fixture BEFORE the recall reinforces.
    const E = new EdgeStore(edges, { now: () => T0 });
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        assert.strictEqual(E.bonus(ids[i], ids[j]), L.bonus(ids[i], ids[j]),
          "migrated bonus drifted for " + ids[i] + ":" + ids[j]);
      }
    }
    const out = await on.recall(DESSERT_Q, 1);
    assert.ok(/lemon bars/.test(primaryBlock(out)));
    assert.strictEqual(fs.readFileSync(assoc, "utf8").includes("resonance-edges"), false,
      ".assoc.json must stay the old format (untouched)");
    void out;
  });

  await atest("I6: 100 field-on recalls under a frozen clock do not decay an uninvolved edge; reinforce still strengthens co-recalled ones", async () => {
    // Headline live-path proof. Old tick() would have multiplied every stored
    // weight by 0.95 on the 10th/20th/... recall. After 0.2 the decay clock
    // is wall-clock, and this clock is frozen, so stored Hebbian of an edge
    // that is NOT co-recalled must be byte-identical after 100 recalls.
    const { core, store, edgesPath, edges } = liveField("c-i6.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const E = edges();   // same instance recall() will mutate — a second load would be overwritten
    const diabeticId = store.current().find((m) => m.text === DIABETIC).id;
    const lemonId = store.current().find((m) => m.text === LEMON).id;
    const meetingId = store.current().find((m) => m.text === MEETING).id;
    // Uninvolved pair: meeting is orthogonal to the dessert query, so it
    // will not land in primary or Related. Seed a learned weight on it.
    E.put(makeEdge(meetingId, diabeticId, {
      origin: "co-activation", now: T0, hebbianWeight: 1.0,
      semantic: { value: 0.4, src_versions: { a: 1, b: 1 } },
    }));
    E.save();
    const snapHeb = JSON.parse(JSON.stringify(E.get(meetingId, diabeticId).hebbian));
    const snapSem = JSON.parse(JSON.stringify(E.get(meetingId, diabeticId).semantic));
    const recallsBefore = E.recalls;
    for (let i = 0; i < 100; i++) await core.recall(DESSERT_Q, 1);
    const live = new EdgeStore(edgesPath, { now: () => T0 });   // reload from disk
    const uninvolved = live.get(meetingId, diabeticId);
    assert.deepStrictEqual(uninvolved.hebbian, snapHeb,
      "uninvolved edge: stored weight + last_updated unmoved after 100 recalls (I6)");
    assert.deepStrictEqual(uninvolved.semantic, snapSem, "semantic unmoved");
    assert.strictEqual(live.recalls, recallsBefore, "recall-epoch clock must not advance");
    // Co-recalled lemon↔diabetic DID strengthen — reinforcement is retained.
    const learned = live.weight(lemonId, diabeticId);
    assert.ok(learned > 0, "co-recall reinforcement still writes Hebbian weight");
    // And a genuine reinforceRecall on the uninvolved pair does change it.
    live.reinforceRecall([String(meetingId), String(diabeticId)], []);
    assert.ok(live.weight(meetingId, diabeticId) > 1.0, "genuine reinforcement still works");
    assert.strictEqual(live.get(meetingId, diabeticId).hebbian.last_updated, T0,
      "frozen clock: last_updated stamps to now, which is still T0 — weight is the signal it fired");
  });

  await atest("I6: recall writes nothing to the edge store on the decay account", async () => {
    // Pair with the I5 test: sidecar writes from reinforceRecall are allowed;
    // decay itself must not move last_updated or stored weight of any edge
    // that was not reinforced this turn.
    const { core, store, edges } = liveField("c-i6-decay-write.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const E = edges();
    const meetingId = store.current().find((m) => m.text === MEETING).id;
    const diabeticId = store.current().find((m) => m.text === DIABETIC).id;
    E.put(makeEdge(meetingId, diabeticId, { origin: "co-activation", now: T0, hebbianWeight: 0.5 }));
    E.save();
    const before = JSON.parse(JSON.stringify(E.get(meetingId, diabeticId)));
    await core.recall(DESSERT_Q, 1);
    const after = E.get(meetingId, diabeticId);
    assert.strictEqual(after.hebbian.weight, before.hebbian.weight, "decay must not rewrite stored weight");
    assert.strictEqual(after.hebbian.last_updated, before.hebbian.last_updated, "decay must not stamp last_updated");
  });

  await atest("reinforceRecall is retained: a co-recalled pair gets stronger", async () => {
    const { core, store, edges } = liveField("c-reinf-kept.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const lemonId = store.current().find((m) => m.text === LEMON).id;
    const diabeticId = store.current().find((m) => m.text === DIABETIC).id;
    const E = edges();
    const before = E.weight(lemonId, diabeticId);
    await core.recall(DESSERT_Q, 1);
    const after = E.weight(lemonId, diabeticId);
    assert.ok(after > before, "co-surfaced lemon↔diabetic gained Hebbian weight");
  });

  // ------------------------------------------------ Phase 0.1: save-time semantic edges
  // Persist-on-save, recall still uses field.js. These must fail without the
  // bind in save() / the 0.25 threshold / canonical src_versions tagging.
  section("Phase 0.1 save-time semantic edges");

  // Unit vector at cosine `c` against [1,0,0].
  function vecAtCos(c) {
    return [c, Math.sqrt(Math.max(0, 1 - c * c)), 0];
  }

  function saveTimeCore(file, embedFn, opts = {}) {
    const store = new JsonlStore(tmp(file));
    const edgesPath = tmp(file + ".edges.json");
    let _e = null;
    const getEdgeStore = opts.getEdgeStore || (() => {
      if (!_e) _e = new EdgeStore(edgesPath, { now: () => T0 });
      return _e;
    });
    const core = createCore({
      store,
      embed: embedFn,
      fieldEnabled: () => !!opts.fieldOn,
      getEdgeStore,
    });
    return { store, core, edgesPath, edges: () => getEdgeStore() };
  }

  await atest("SAVE_TIME constants match the spec (K=5, minCos=0.25, distinct from recall 0.55)", async () => {
    assert.strictEqual(SAVE_TIME_K, 5, "start K ≈ 5");
    assert.strictEqual(SAVE_TIME_MIN_COS, 0.25, "save-time bind ~0.25");
    assert.ok(SAVE_TIME_MIN_COS < 0.55, "must stay looser than field.js recall minSim 0.55 (Risk #2)");
  });

  await atest("save binds top-K neighbors above ~0.25; extras and below-threshold are dropped", async () => {
    const vecs = {
      hub: [1, 0, 0],
      n90: vecAtCos(0.90),
      n80: vecAtCos(0.80),
      n70: vecAtCos(0.70),
      n60: vecAtCos(0.60),
      n50: vecAtCos(0.50),
      n40: vecAtCos(0.40),   // above 0.25 but 6th — K=5 drops it
      n30: vecAtCos(0.30),
      n20: vecAtCos(0.20),   // below threshold
      n10: vecAtCos(0.10),
    };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges } = saveTimeCore("st-k.jsonl", embed);
    for (const name of ["n90", "n80", "n70", "n60", "n50", "n40", "n30", "n20", "n10"]) {
      await core.save(name);
    }
    await core.save("hub");
    const hubId = store.current().find((m) => m.text === "hub").id;
    const incident = edges().incident(hubId);
    assert.strictEqual(incident.length, SAVE_TIME_K, "exactly K neighbors, not every above-threshold pair");
    const nbrIds = new Set();
    for (const e of incident) nbrIds.add(e.a === String(hubId) ? e.b : e.a);
    const byId = new Map(store.current().map((m) => [String(m.id), m]));
    const nbrTexts = [...nbrIds].map((id) => byId.get(String(id)).text).sort();
    assert.deepStrictEqual(nbrTexts, ["n50", "n60", "n70", "n80", "n90"],
      "top-5 by cosine; n40 (6th) and n20 (below 0.25) must not bind");
    for (const e of incident) {
      assert.strictEqual(e.hebbian.weight, 0, "no seeded baseline");
      assert.strictEqual(e.provenance.origin, "save-time-neighbor");
      assert.ok(e.semantic.value >= SAVE_TIME_MIN_COS);
    }
  });

  await atest("fewer-than-K neighbors that clear the threshold still bind (no padding)", async () => {
    const vecs = { hub: [1, 0, 0], near: vecAtCos(0.80), mid: vecAtCos(0.40), far: vecAtCos(0.10) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges } = saveTimeCore("st-few.jsonl", embed);
    await core.save("near");
    await core.save("mid");
    await core.save("far");
    await core.save("hub");
    const hubId = store.current().find((m) => m.text === "hub").id;
    const incident = edges().incident(hubId);
    assert.strictEqual(incident.length, 2, "only near+mid clear 0.25; do not pad to K");
    const nbrIds = incident.map((e) => e.a === String(hubId) ? e.b : e.a);
    const texts = nbrIds.map((id) => store.get(id).text).sort();
    assert.deepStrictEqual(texts, ["mid", "near"]);
  });

  await atest("the ~0.25 threshold is a hard floor: 0.25 binds, 0.24 does not", async () => {
    const vecs = { hub: [1, 0, 0], on: vecAtCos(0.25), off: vecAtCos(0.24) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges } = saveTimeCore("st-floor.jsonl", embed);
    await core.save("on");
    await core.save("off");
    await core.save("hub");
    const hubId = store.current().find((m) => m.text === "hub").id;
    const onId = store.current().find((m) => m.text === "on").id;
    const offId = store.current().find((m) => m.text === "off").id;
    assert.ok(edges().get(hubId, onId), "cosine 0.25 is on the gate (>=)");
    assert.strictEqual(edges().get(hubId, offId), undefined, "cosine 0.24 must not persist");
    const e = edges().get(hubId, onId);
    assert.ok(Math.abs(e.semantic.value - coreCosine(vecs.hub, vecs.on)) < 1e-12,
      "cached semantic.value is the measured cosine");
  });

  await atest("src_versions follow canonical edge.a/edge.b, not save-argument order", async () => {
    // Give the two endpoints DIFFERENT versions so a swapped tag is detectable.
    // Save A, edit A (v2), save B (v1). B's save binds A↔B; makeEdge(B, A)
    // sorts to a=min(A,B). Tagging by argument order would put B's v1 on
    // src_versions.a whenever B was the save-side argument.
    let vec = [1, 0, 0];
    const embed = async (texts) => texts.map(() => vec.slice());
    const { store, core, edges } = saveTimeCore("st-canon.jsonl", embed);
    await core.save("alpha-endpoint");
    const idA = store.all()[0].id;
    vec = [0.8, 0.6, 0];
    await core.edit(idA, "alpha-endpoint-edited");
    assert.strictEqual(store.get(idA).embedding_version, 2);
    vec = [0.8, 0.6, 0];
    await core.save("beta-endpoint");
    const idB = store.current().find((m) => m.text === "beta-endpoint").id;
    const edge = edges().get(idA, idB);
    assert.ok(edge, "save-time edge exists");
    const recA = store.get(edge.a);
    const recB = store.get(edge.b);
    assert.deepStrictEqual(edge.semantic.src_versions, {
      a: recA.embedding_version,
      b: recB.embedding_version,
    }, "src_versions.a is canonical endpoint a's version, not the save-argument's");
    assert.strictEqual(semanticValid(edge, recA.embedding_version, recB.embedding_version), true);
    assert.notStrictEqual(recA.embedding_version, recB.embedding_version,
      "versions must differ or a swap would still pass");
  });

  await atest("edit() re-embed bumps embedding_version so the save-time edge reads stale (no invalidation event)", async () => {
    let vec = [1, 0, 0];
    const embed = async (texts) => texts.map(() => vec.slice());
    const { store, core, edges, edgesPath } = saveTimeCore("st-stale.jsonl", embed);
    await core.save("first");
    await core.save("second");
    const ids = store.current().map((m) => m.id);
    const edgeBefore = edges().get(ids[0], ids[1]);
    assert.ok(edgeBefore);
    const srcSnap = JSON.parse(JSON.stringify(edgeBefore.semantic.src_versions));
    const sidecarBefore = fs.readFileSync(edgesPath, "utf8");
    const vBefore = store.get(ids[0]).embedding_version;
    vec = [0, 1, 0];
    await core.edit(ids[0], "first-edited");
    assert.strictEqual(store.get(ids[0]).embedding_version, vBefore + 1);
    assert.strictEqual(fs.readFileSync(edgesPath, "utf8"), sidecarBefore,
      "edit must not write the edge store (transition table)");
    const edgeAfter = edges().get(ids[0], ids[1]);
    assert.deepStrictEqual(edgeAfter.semantic.src_versions, srcSnap,
      "no invalidation event rewrote src_versions");
    const recA = store.get(edgeAfter.a);
    const recB = store.get(edgeAfter.b);
    assert.strictEqual(
      semanticValid(edgeAfter, recA.embedding_version, recB.embedding_version),
      false,
      "stale is structurally self-evident on the next read"
    );
  });

  await atest("a save with the embedder down binds nothing and does not throw", async () => {
    const ref = { live: true };
    const vecs = { live: [1, 0, 0], also: vecAtCos(0.80) };
    const embed = async (texts) => {
      if (!ref.live) throw new Error("embedder unreachable");
      return texts.map((t) => vecs[t] || [1, 0, 0]);
    };
    const { store, core, edges } = saveTimeCore("st-dead.jsonl", embed);
    await core.save("live");
    await core.save("also");
    const sizeBefore = edges().size;
    ref.live = false;
    let msg;
    await assert.doesNotReject(async () => { msg = await core.save("saved while down"); });
    const dead = store.current().find((m) => m.text === "saved while down");
    assert.ok(dead, "vectorless row still lands");
    assert.strictEqual(dead.embedding, null);
    assert.strictEqual(edges().size, sizeBefore, "no new edges against a null vector");
    assert.ok(/Saved/.test(msg));
  });

  await atest("first save ever with a dead embedder does not throw and writes no sidecar", async () => {
    const embed = async () => { throw new Error("embedder unreachable"); };
    const { store, core, edgesPath } = saveTimeCore("st-dead-first.jsonl", embed);
    let msg;
    await assert.doesNotReject(async () => { msg = await core.save("nothing to compare"); });
    assert.ok(/Saved/.test(msg));
    assert.strictEqual(store.all()[0].embedding, null);
    assert.strictEqual(fs.existsSync(edgesPath), false, "no vector → no bind → no sidecar write");
  });

  await atest("save-time bind throwing does not break save (I3)", async () => {
    const store = new JsonlStore(tmp("st-throw.jsonl"));
    const embed = async (texts) => texts.map(() => [1, 0, 0]);
    const core = createCore({
      store, embed,
      getEdgeStore: () => { throw new Error("edges boom"); },
    });
    const msg = await core.save("still saved");
    assert.ok(/Saved/.test(msg));
    assert.strictEqual(store.all().length, 1);
  });

  await atest("existing co-activation Hebbian weight is preserved when save-time fills semantic", async () => {
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.70) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges } = saveTimeCore("st-keep-heb.jsonl", embed);
    await core.save("a");
    await core.save("b");
    const idA = store.current().find((m) => m.text === "a").id;
    const idB = store.current().find((m) => m.text === "b").id;
    const existing = edges().get(idA, idB);
    assert.ok(existing, "save of b bound the pair");
    // Rewrite as a migrated co-activation edge: learned weight, empty semantic.
    existing.provenance.origin = "co-activation";
    existing.provenance.migrated_from = "assoc.json";
    setHebbian(existing, 0.42, T0);
    setSemantic(existing, null, { a: null, b: null });
    const hebSnap = JSON.parse(JSON.stringify(existing.hebbian));
    const recA = store.get(idA);
    const recB = store.get(idB);
    const result = bindSaveTimeNeighbors(recB, [recA], edges());
    assert.ok(result.wrote, "empty semantic was filled");
    const after = edges().get(idA, idB);
    assert.deepStrictEqual(after.hebbian, hebSnap, "hebbian bytes unmoved");
    assert.strictEqual(after.provenance.origin, "co-activation", "origin is how it came to exist, not rewritten");
    assert.strictEqual(after.provenance.migrated_from, "assoc.json");
    assert.ok(after.semantic.value > 0);
    assert.strictEqual(semanticValid(after, recA.embedding_version, recB.embedding_version), true);
  });

  await atest("Related: still comes from field.js at 0.55, not from persisted 0.25 edges", async () => {
    // Guard against accidentally wiring recall to the save-time table this
    // slice. A pair at cos 0.30 is persisted (0.25 net) but must NOT surface
    // in Related: (0.55 gate). A third orthogonal memory makes
    // mems.length > ranked.length so the field block even runs.
    const vecs = {
      "alpha lives here": [1, 0, 0],
      "barely related": vecAtCos(0.30),
      "totally other": [0, 0, 1],
      alpha: [1, 0, 0],
    };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 1, 0]);
    const { core, edges } = saveTimeCore("st-recall-guard.jsonl", embed, { fieldOn: true });
    await core.save("alpha lives here");
    await core.save("barely related");
    await core.save("totally other");
    assert.ok(edges().size >= 1, "the 0.30 pair was persisted at save");
    const out = await core.recall("alpha", 1);
    assert.ok(/alpha lives here/.test(out));
    assert.strictEqual(out.includes("barely related"), false,
      "cos 0.30 save-time edge must not leak into Related: (recall still uses field.js 0.55)");
  });

  await atest("save-time bind does not write the JSONL store (I5)", async () => {
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.80) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edgesPath } = saveTimeCore("st-i5.jsonl", embed);
    await core.save("a");
    const jsonlAfterFirst = fs.readFileSync(store.file, "utf8");
    await core.save("b");
    const lines = fs.readFileSync(store.file, "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 2, "JSONL gained the new row only");
    assert.ok(jsonlAfterFirst.trim() === lines[0], "first row is unmoved");
    assert.ok(fs.existsSync(edgesPath), "sidecar write is allowed (I5 protects JSONL, not sidecars)");
    const j = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
    assert.strictEqual(j.kind, SIDECAR_KIND);
  });

  // ------------------------------------------------ Phase 0.3 live path
  // Request ids threaded through createCore; I5 (JSONL unmoved on recall)
  // must stay held. No-id callers (this is also the eval shape) apply.
  section("Phase 0.3 live path (request-ID through core, I5)");

  await atest("same recall requestId applies once; a different id applies again", async () => {
    const { core, store, edges, edgesPath } = liveField("c-03-id.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const lemonId = store.current().find((m) => m.text === LEMON).id;
    const diabeticId = store.current().find((m) => m.text === DIABETIC).id;
    await core.recall(DESSERT_Q, 1, { requestId: "rpc-1" });
    const w1 = edges().weight(lemonId, diabeticId);
    assert.ok(w1 > 0, "first request reinforced");
    await core.recall(DESSERT_Q, 1, { requestId: "rpc-1" });
    assert.strictEqual(edges().weight(lemonId, diabeticId), w1, "retry of rpc-1 is a no-op");
    await core.recall(DESSERT_Q, 1, { requestId: "rpc-2" });
    assert.ok(edges().weight(lemonId, diabeticId) > w1, "rpc-2 is a distinct request");
    const j = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
    assert.ok(j.processed_ids.indexOf("rpc-1") >= 0);
    assert.ok(j.processed_ids.indexOf("rpc-2") >= 0);
  });

  await atest("no-id recall applies every time (the eval/pipeline shape)", async () => {
    const { core, store, edges } = liveField("c-03-noid.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const lemonId = store.current().find((m) => m.text === LEMON).id;
    const diabeticId = store.current().find((m) => m.text === DIABETIC).id;
    await core.recall(DESSERT_Q, 1);                  // no opts
    const w1 = edges().weight(lemonId, diabeticId);
    await core.recall(DESSERT_Q, 1, { requestId: null });
    const w2 = edges().weight(lemonId, diabeticId);
    assert.ok(w2 > w1, "null requestId is no-id → applies");
    assert.strictEqual(edges().processedIds.length, 0, "eval-shaped calls leave the LRU empty");
  });

  await atest("I5: recall with a requestId still writes nothing to the JSONL store", async () => {
    const { core, store, edgesPath } = liveField("c-03-i5.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const jsonlBytes = fs.readFileSync(store.file, "utf8");
    await core.recall(DESSERT_Q, 1, { requestId: "rpc-i5" });
    assert.strictEqual(fs.readFileSync(store.file, "utf8"), jsonlBytes,
      "recall must not rewrite the JSONL store (I5 / BUG-002)");
    const j = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
    assert.ok(j.processed_ids.indexOf("rpc-i5") >= 0, "dedup record landed in the SIDECAR");
    assert.ok(Object.keys(j.edges).length >= 1, "weight change landed in the same sidecar");
  });

  await atest("edit with a requestId still writes nothing to the edge store", async () => {
    const { core, store, edgesPath } = liveField("c-03-edit.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    await core.recall(DESSERT_Q, 1, { requestId: "rpc-pre" });
    const before = fs.readFileSync(edgesPath, "utf8");
    const id = store.current().find((m) => m.text === MEETING).id;
    await core.edit(id, MEETING, { requestId: "rpc-edit" });
    assert.strictEqual(fs.readFileSync(edgesPath, "utf8"), before,
      "edit must not stamp a dedup record (transition table: no edge write)");
  });

  await atest("save-time bind: same requestId does not re-bind; a second id does", async () => {
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.80), c: vecAtCos(0.70) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges } = saveTimeCore("st-03-id.jsonl", embed);
    await core.save("a", { requestId: "save-1" });
    await core.save("b", { requestId: "save-2" });
    const idA = store.current().find((m) => m.text === "a").id;
    const idB = store.current().find((m) => m.text === "b").id;
    const edge = edges().get(idA, idB);
    assert.ok(edge, "save-2 bound a↔b");
    const semSnap = JSON.parse(JSON.stringify(edge.semantic));
    // Retry of save-2: exact-restatement confirm skips bind anyway; force
    // the bind path by saving a NEW neighbor under the same id — bind must skip.
    await core.save("c", { requestId: "save-2" });
    assert.strictEqual(edges().get(idA, idB).semantic.value, semSnap.value,
      "duplicate save-2 did not mutate the existing edge");
    const idC = store.current().find((m) => m.text === "c").id;
    assert.strictEqual(edges().get(idB, idC) == null && edges().get(idA, idC) == null, true,
      "duplicate id skipped the whole bind (c has no save-time edges)");
    await core.save("c-again-different", { requestId: "save-3" });
    // "c-again-different" isn't in vecs → orthogonal vector; may or may not bind.
    // The point: a fresh id is accepted (not stuck after save-2 was claimed).
    assert.ok(edges().hasProcessed("save-2"));
    assert.ok(edges().hasProcessed("save-3"));
  });

  // ------------------------------------------------ Phase 0.4 live path
  // Prune is EXPLICIT (pruneSweep / MCP startup), never recall/save.
  // Reactivation is a consequence of save/edit touching an endpoint.
  section("Phase 0.4 live path (soft prune off the hot path, reactivation on save/edit)");

  await atest("recall does not prune: a weak unreinforced edge stays active", async () => {
    const { core, store, edges, edgesPath } = liveField("c-04-recall.edges.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const E = edges();
    const meetingId = store.current().find((m) => m.text === MEETING).id;
    const diabeticId = store.current().find((m) => m.text === DIABETIC).id;
    E.put(makeEdge(meetingId, diabeticId, {
      origin: "save-time-neighbor", now: T0, hebbianWeight: 0,
      semantic: { value: 0.10, src_versions: { a: 1, b: 1 } },
    }));
    E.save();
    const before = fs.readFileSync(edgesPath, "utf8");
    await core.recall(DESSERT_Q, 1);
    assert.strictEqual(E.get(meetingId, diabeticId).pruned_at, null,
      "recall must not prune (maintenance is pruneSweep, not the hot path)");
    // Sidecar may have grown a co-recall edge; the weak row itself is unpruned.
    assert.ok(JSON.parse(fs.readFileSync(edgesPath, "utf8")).edges[edgeKey(meetingId, diabeticId)].pruned_at == null);
    void before;
  });

  await atest("a normal save does not prune existing edges", async () => {
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.80), c: [0, 0, 1] };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 1, 0]);
    const { store, core, edges } = saveTimeCore("c-04-save.jsonl", embed);
    await core.save("a");
    await core.save("b");
    const idA = store.current().find((m) => m.text === "a").id;
    const idB = store.current().find((m) => m.text === "b").id;
    // Plant a prune-eligible edge that save() must not sweep.
    edges().put(makeEdge(idA, 999, {
      origin: "save-time-neighbor", now: T0, hebbianWeight: 0,
      semantic: { value: 0.10, src_versions: { a: 1, b: 1 } },
    }));
    await core.save("c");
    assert.strictEqual(edges().get(idA, 999).pruned_at, null,
      "save must not run pruneSweep");
    assert.strictEqual(edges().get(idA, idB).pruned_at, null);
  });

  await atest("edit of an endpoint reactivates its pruned incident edge; created_at and weight survive", async () => {
    const { core, store, edges, edgesPath } = liveField("c-04-edit.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const E = edges();
    const meetingId = store.current().find((m) => m.text === MEETING).id;
    const diabeticId = store.current().find((m) => m.text === DIABETIC).id;
    const planted = E.put(makeEdge(meetingId, diabeticId, {
      origin: "co-activation", now: T0, hebbianWeight: 0.4,
      semantic: { value: 0.10, src_versions: { a: 1, b: 1 } },
    }));
    markPruned(planted, T0);
    E.save();
    assert.ok(E.get(meetingId, diabeticId).pruned_at);
    const sidecarBefore = fs.readFileSync(edgesPath, "utf8");
    await core.edit(meetingId, MEETING);
    const after = E.get(meetingId, diabeticId);
    assert.strictEqual(after.pruned_at, null, "edit touching the endpoint revived it");
    assert.strictEqual(after.created_at, T0);
    assert.strictEqual(after.prune_count, 1);
    assert.strictEqual(after.last_reactivated_at, T0, "frozen clock stamps now=T0");
    assert.strictEqual(after.hebbian.weight, 0.4, "weight not reset to full / zero");
    assert.notStrictEqual(fs.readFileSync(edgesPath, "utf8"), sidecarBefore,
      "reactivation is the one edge write edit is allowed");
    const j = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
    assert.ok(j.processed_ids.indexOf("rpc-edit") < 0, "edit still must not stamp a dedup id");
  });

  await atest("edit with no pruned incident edges still writes nothing to the sidecar", async () => {
    // Belt on the 0.3 test: reactivation is conditional. No pruned rows → I5-class no-write.
    const { core, store, edgesPath } = liveField("c-04-edit-noop.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    await core.recall(DESSERT_Q, 1);
    const before = fs.readFileSync(edgesPath, "utf8");
    const id = store.current().find((m) => m.text === MEETING).id;
    await core.edit(id, MEETING);
    assert.strictEqual(fs.readFileSync(edgesPath, "utf8"), before);
  });

  await atest("confirming save (exact restatement) reactivates incident pruned edges", async () => {
    const { core, store, edges } = liveField("c-04-confirm.jsonl", true);
    await core.save(MEETING);
    const id = store.current().find((m) => m.text === MEETING).id;
    const planted = edges().put(makeEdge(id, 999, {
      origin: "save-time-neighbor", now: T0, hebbianWeight: 0,
      semantic: { value: 0.10, src_versions: { a: 1, b: 1 } },
    }));
    markPruned(planted, T0);
    const msg = await core.save(MEETING);
    assert.ok(/Already remembered/.test(msg));
    assert.strictEqual(edges().get(id, 999).pruned_at, null);
    assert.strictEqual(edges().get(id, 999).prune_count, 1);
    assert.strictEqual(edges().get(id, 999).last_reactivated_at, T0);
  });

  await atest("save-time bind reactivates a pruned existing edge rather than creating a duplicate", async () => {
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.80) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges } = saveTimeCore("c-04-bind-re.jsonl", embed);
    await core.save("a");
    const recA = store.current().find((m) => m.text === "a");
    const recB = {
      id: 4242, text: "b", embedding: vecs.b, embedding_version: 1,
    };
    const planted = edges().put(makeEdge(recA.id, recB.id, {
      origin: "save-time-neighbor", now: T0, hebbianWeight: 0.22,
      semantic: { value: 0.80, src_versions: { a: 1, b: 1 } },
    }));
    markPruned(planted, T0);
    const created = planted.created_at;
    const result = bindSaveTimeNeighbors(recB, [recA], edges());
    assert.ok(result.wrote);
    const after = edges().get(recA.id, recB.id);
    assert.strictEqual(after.pruned_at, null);
    assert.strictEqual(after.created_at, created, "in-place revive, not a new row");
    assert.strictEqual(after.hebbian.weight, 0.22, "Hebbian carried");
    assert.strictEqual(after.prune_count, 1);
    assert.strictEqual(edges().size, 1, "no duplicate edge");
  });

  await atest("pruneSweep of a strong unreinforced bridge does not regress constraint rescue", async () => {
    const { core, store, edges } = liveField("c-04-rescue.jsonl", true);
    await core.save(DIABETIC);
    await core.save(LEMON);
    await core.save(MEETING);
    const lemonId = store.current().find((m) => m.text === LEMON).id;
    const diabeticId = store.current().find((m) => m.text === DIABETIC).id;
    // The save-time lemon↔diabetic edge is semantically strong (cos 0.60) and
    // unreinforced (weight 0). A merged scalar would prune it.
    const bridge = edges().get(lemonId, diabeticId);
    assert.ok(bridge, "save-time bind created the rescue bridge");
    assert.strictEqual(bridge.hebbian.weight, 0);
    assert.ok(bridge.semantic.value >= 0.45);
    const n = edges().pruneSweep();
    assert.strictEqual(edges().get(lemonId, diabeticId).pruned_at, null,
      "two-signal rule: strong unreinforced bridge survives");
    void n;
    const out = await core.recall(DESSERT_Q, 1);
    assert.ok(/diabetic/.test(out), "constraint rescue still fires after the sweep");
  });
}

// ------------------------------------------------------------------- report
asyncTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }
  process.exit(failed ? 1 : 0);
});
