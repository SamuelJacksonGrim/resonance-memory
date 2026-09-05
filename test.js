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
 *
 * Phase 0 contract (0.5): section headers are keyed to the sub-phase /
 * invariant they defend. Every edge state-transition row asserts the
 * state change AND the Writes? column (I5). Every pre-declared failure
 * signature has a test that fails if that bug is reintroduced. Timing
 * tests use a fake/injectable clock — never real Date.now().
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  writeFileDurable, appendLineDurable,
  normalize, isCurrent, isHistoricalQuery, supersedePatches, AccessLog,
  detectSupersession, hasSupersedeCue,
  detectNearDuplicate, pickMergeSurvivor,
  normalizeText, splitFacts, guardSecrets, prepareWrite, isStandaloneFact,
  isVector, hasVector,
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

test("normalize DROPS a Float32Array embedding (typed array is not Array.isArray)", () => {
  // Spike trap: SqliteStore stored NULLs for a whole run because normalize()
  // only keeps Array.isArray embeddings. The drop is the schema's job; the
  // store attaches the typed array AFTER. This test fails if someone "fixes"
  // normalize() to accept ArrayLike without updating the store contract.
  const f32 = new Float32Array([1, 0, 0.5]);
  const r = normalize({ id: 1, text: "x", embedding: f32 });
  assert.strictEqual(r.embedding, null, "Float32Array must not survive normalize()");
  const arr = normalize({ id: 2, text: "y", embedding: [1, 0, 0.5] });
  assert.deepStrictEqual(arr.embedding, [1, 0, 0.5], "JSON number[] still kept");
});

test("isVector accepts both JSON number[] and Float32Array", () => {
  assert.strictEqual(isVector([1, 0]), true);
  assert.strictEqual(isVector(new Float32Array([1, 0])), true);
  assert.strictEqual(isVector(null), false);
  assert.strictEqual(isVector([]), false);
  assert.strictEqual(hasVector({ embedding: new Float32Array([0.1, 0.2]) }), true);
  assert.strictEqual(hasVector({ embedding: null }), false);
});

test("detectNearDuplicate sees a Float32Array neighbor (SqliteStore cache form)", () => {
  const incoming = normalize({ id: 99, text: "I prefer tea", embedding: [1, 0] });
  const stored = {
    id: 1, text: "I prefer tea", embedding: new Float32Array([1, 0]),
    deleted: false, valid_to: null,
  };
  const cosineFn = (a, b) => {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };
  const hit = detectNearDuplicate(incoming, [stored], cosineFn, { hi: 0.95, lo: 0.88 });
  assert.ok(hit, "typed-array neighbor must participate");
  assert.strictEqual(hit.action, "restate");
  assert.strictEqual(hit.match.id, 1);
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

// ------------------------------------------------ cosine-banded dedup (RM-02.b)
section("cosine-banded dedup detection (RM-02.b)");

test("detectNearDuplicate: cosine ≥ hi is restatement", () => {
  const newRec = { id: 2, text: "I am allergic to penicillin", embedding: [1] };
  const cur = [mem(1, "I'm allergic to penicillin", 0.96)];
  const d = detectNearDuplicate(newRec, cur, simStub, { hi: 0.95, lo: 0.88 });
  assert.strictEqual(d.action, "restate");
  assert.strictEqual(d.match, cur[0]);
  assert.strictEqual(d.cosine, 0.96);
});

test("detectNearDuplicate: cosine exactly hi is restatement (≥, not >)", () => {
  // Equality case is hypothetical on the corpus (tea is 0.9522) but the
  // spec is ≥ HI: keep the original rather than merge/rewrite.
  const newRec = { id: 2, text: "paraphrase", embedding: [1] };
  const cur = [mem(1, "original", 0.95)];
  const d = detectNearDuplicate(newRec, cur, simStub, { hi: 0.95, lo: 0.88 });
  assert.strictEqual(d.action, "restate");
});

test("detectNearDuplicate: lo ≤ cosine < hi is merge", () => {
  const newRec = { id: 2, text: "I work as a software architect, mostly on games", embedding: [1] };
  const cur = [mem(1, "I work as a software architect", 0.926)];
  const d = detectNearDuplicate(newRec, cur, simStub, { hi: 0.95, lo: 0.88 });
  assert.strictEqual(d.action, "merge");
  assert.strictEqual(d.match, cur[0]);
});

test("detectNearDuplicate: cosine < lo is not a duplicate (control)", () => {
  // dog/cat live pair ~0.69; peanuts/peanut-allergy ~0.67. Must NOT merge.
  const newRec = { id: 2, text: "I have a cat named Whiskers", embedding: [1] };
  const cur = [mem(1, "I have a dog named Rex", 0.69)];
  assert.strictEqual(detectNearDuplicate(newRec, cur, simStub, { hi: 0.95, lo: 0.88 }), null);
});

test("detectNearDuplicate: cosine exactly lo is merge (≥ lo, < hi)", () => {
  const newRec = { id: 2, text: "incoming", embedding: [1] };
  const cur = [mem(1, "existing", 0.88)];
  const d = detectNearDuplicate(newRec, cur, simStub, { hi: 0.95, lo: 0.88 });
  assert.strictEqual(d.action, "merge");
});

test("detectNearDuplicate: a vectorless new memory can't compare (append, don't crash)", () => {
  const newRec = { id: 2, text: "I am allergic to penicillin", embedding: null };
  const cur = [mem(1, "I'm allergic to penicillin", 0.99)];
  assert.strictEqual(detectNearDuplicate(newRec, cur, simStub, { hi: 0.95, lo: 0.88 }), null);
});

test("detectNearDuplicate: skips vectorless existing rows", () => {
  const newRec = { id: 3, text: "incoming", embedding: [1] };
  const cur = [
    { id: 1, text: "no vector", embedding: null },
    mem(2, "has vector", 0.96),
  ];
  const d = detectNearDuplicate(newRec, cur, simStub, { hi: 0.95, lo: 0.88 });
  assert.strictEqual(d.match, cur[1], "the vectored row, not the hole");
});

test("detectNearDuplicate: argmax, not the first above the floor", () => {
  const newRec = { id: 3, text: "incoming", embedding: [1] };
  const cur = [mem(1, "control", 0.69), mem(2, "paraphrase", 0.96)];
  const d = detectNearDuplicate(newRec, cur, simStub, { hi: 0.95, lo: 0.88 });
  assert.strictEqual(d.action, "restate");
  assert.strictEqual(d.match, cur[1]);
});

test("detectNearDuplicate: honors injected thresholds (config, not constants)", () => {
  const newRec = { id: 2, text: "incoming", embedding: [1] };
  const cur = [mem(1, "existing", 0.96)];
  // 0.96 is HI at default 0.95, but below a raised hi=0.99 / lo=0.97 → append
  assert.strictEqual(detectNearDuplicate(newRec, cur, simStub, { hi: 0.99, lo: 0.97 }), null);
  const d = detectNearDuplicate(newRec, cur, simStub, { hi: 0.99, lo: 0.90 });
  assert.strictEqual(d.action, "merge", "same pair is merge when hi is raised past it");
});

test("pickMergeSurvivor: longer text wins; equal length keeps existing", () => {
  const short = { id: 1, text: "I have a cat named Koneko" };
  const longer = { id: 2, text: "I have a black cat named Koneko" };
  assert.strictEqual(pickMergeSurvivor(short, longer), longer);
  assert.strictEqual(pickMergeSurvivor(longer, short), longer);
  const a = { id: 1, text: "same length!!" }; // 13
  const b = { id: 2, text: "also 13 chars" }; // 13
  assert.strictEqual(pickMergeSurvivor(a, b), a, "tie keeps the already-stored record");
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

test("interrupted write: leftover .tmp is ignored; the target is still the complete previous document", () => {
  // Crash window: temp written, rename not yet. Readers must see all-old,
  // never the partial tmp (BUG-001 class). The tmp name is pid+Date.now();
  // a leftover from a dead attempt uses a different suffix.
  const f = tmp("d-interrupt.txt");
  writeFileDurable(f, "complete-old");
  const leftover = path.join(path.dirname(f), "." + path.basename(f) + ".999.1.tmp");
  fs.writeFileSync(leftover, "PARTIAL-NEW");
  assert.strictEqual(fs.readFileSync(f, "utf8"), "complete-old", "target unmoved by a sibling tmp");
  writeFileDurable(f, "complete-new");
  assert.strictEqual(fs.readFileSync(f, "utf8"), "complete-new", "subsequent durable write recovers");
  assert.strictEqual(fs.readFileSync(leftover, "utf8"), "PARTIAL-NEW",
    "a leftover tmp is not consumed as the store (new writes use a fresh tmp name)");
  fs.unlinkSync(leftover);  // crash leftover is not auto-reaped; don't poison later stray-tmp checks
});

test("failed writeFileDurable does not clobber the target and cleans its temp", () => {
  const blocker = tmp("d-fail-blocker");
  writeFileDurable(blocker, "original");
  // Parent is a file, not a directory: mkdir/open of a nested path throws.
  const nested = path.join(blocker, "child.txt");
  assert.throws(() => writeFileDurable(nested, "must-not-land"));
  assert.strictEqual(fs.readFileSync(blocker, "utf8"), "original", "failed write must not touch the live file");
  const strays = fs.readdirSync(tmpRoot).filter((n) => n.includes(".tmp"));
  assert.deepStrictEqual(strays, [], "failed write must unlink its temp: " + strays.join(", "));
});

test("writeFileDurable onto a directory throws, leaves the directory, cleans the temp", () => {
  const d = tmp("d-fail-dir");
  fs.mkdirSync(d);
  assert.throws(() => writeFileDurable(d, "payload"));
  assert.ok(fs.statSync(d).isDirectory(), "rename-onto-dir must not replace the directory");
  const strays = fs.readdirSync(path.dirname(d)).filter((n) =>
    n.startsWith("." + path.basename(d)) && n.endsWith(".tmp"));
  assert.deepStrictEqual(strays, [], "temp cleaned after rename failure");
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

// ------------------------------------------------- RM-07 SqliteStore + conformance
section("SqliteStore (RM-07 drop-in) + Store conformance");

const {
  SqliteStore, openStore, resolveStoreBackend, sqlitePathFor,
} = require("./store.js");

function sqliteAvailable() {
  try { require("node:sqlite"); return true; } catch { return false; }
}

function freshSqlite(name) {
  const dir = tmp("sqlite-" + (name || Math.random().toString(36).slice(2)));
  fs.mkdirSync(dir, { recursive: true });
  const s = new SqliteStore(path.join(dir, "mem.db"));
  return s;
}

function embClose(a, b, eps) {
  eps = eps == null ? 1e-5 : eps;
  if (a == null && b == null) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}

function recFields(r) {
  return {
    id: String(r.id),
    created: r.created,
    text: r.text,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    superseded_by: r.superseded_by == null ? null : String(r.superseded_by),
    supersedes: r.supersedes == null ? null : String(r.supersedes),
    revision: r.revision,
    deleted: !!r.deleted,
    is_constraint: !!r.is_constraint,
    source: r.source,
    embedding_version: r.embedding_version,
    access_count: r.access_count,
  };
}

if (!sqliteAvailable()) {
  test("SqliteStore SKIPPED (node:sqlite not in this Node)", () => {
    assert.ok(true);
  });
} else {

test("openStore defaults to JsonlStore; RESONANCE_STORE=sqlite is selectable", () => {
  const prev = process.env.RESONANCE_STORE;
  try {
    delete process.env.RESONANCE_STORE;
    assert.strictEqual(resolveStoreBackend(null), "jsonl");
    assert.strictEqual(resolveStoreBackend({}), "jsonl");
    assert.ok(openStore(tmp("sel-default.jsonl")) instanceof JsonlStore);
    assert.strictEqual(resolveStoreBackend({ store: "sqlite" }), "sqlite", "live-config wins");
    process.env.RESONANCE_STORE = "sqlite";
    assert.strictEqual(resolveStoreBackend(null), "sqlite");
    assert.strictEqual(resolveStoreBackend({ store: "jsonl" }), "jsonl", "config beats env");
    assert.strictEqual(sqlitePathFor("C:/data/resonance-memory.jsonl").replace(/\\/g, "/"),
      "C:/data/resonance-memory.db");
    assert.strictEqual(sqlitePathFor("mem.db"), "mem.db");
  } finally {
    if (prev == null) delete process.env.RESONANCE_STORE;
    else process.env.RESONANCE_STORE = prev;
  }
});

test("SqliteStore NEVER constructs AccessLog (BUG-007 trap)", () => {
  const s = freshSqlite("no-access");
  assert.strictEqual(s.access, undefined, "no AccessLog on the instance");
  assert.ok(!fs.existsSync(s.file + ".access.json"), "must not create a sidecar");
  // A leftover live sidecar next to the .db is ignored — counts come from the row.
  fs.writeFileSync(s.file + ".access.json", JSON.stringify({ counts: { "1": { n: 99, last: "X" } } }));
  s.add(normalize({ id: 1, text: "x", created: "2026-01-01T00:00:00.000Z" }));
  assert.strictEqual(s.get(1).access_count, 0, "leftover sidecar must not fold in");
  s.applyRecall([1], new Map());
  assert.strictEqual(s.get(1).access_count, 1, "in-table bump only");
  assert.notStrictEqual(s.get(1).access_count, 100, "99 + 1 would be the doubling costume");
  s.close();
});

test("SqliteStore preserves the opaque id (never AUTOINCREMENT-renumbers)", () => {
  const s = freshSqlite("ids");
  const id = 1700000000001;
  s.add(normalize({ id, text: "keep this id", created: "2026-01-01T00:00:00.000Z" }));
  assert.strictEqual(Number(s.get(id).id), id);
  assert.strictEqual(Number(s.current()[0].id), id);
  s.add(normalize({ id: 7, text: "small id", created: "2026-01-01T00:00:00.000Z" }));
  assert.strictEqual(Number(s.get(7).id), 7, "a small explicit id is not reassigned to 1 or 2");
  assert.strictEqual(s.all().length, 2);
  s.close();
});

test("SqliteStore preserves created as a real column", () => {
  const s = freshSqlite("created");
  const created = "2020-06-15T12:34:56.000Z";
  s.add(normalize({ id: 1, text: "old fact", created, modified: "2021-01-01T00:00:00.000Z" }));
  assert.strictEqual(s.get(1).created, created);
  s.update(1, { text: "edited", modified: "2022-01-01T00:00:00.000Z" });
  assert.strictEqual(s.get(1).created, created, "an edit must not rewrite created");
  s.close();
  const reopened = new SqliteStore(s.file);
  assert.strictEqual(reopened.get(1).created, created, "created survives reopen");
  reopened.close();
});

test("SqliteStore attaches Float32Array AFTER normalize() (typed-array trap)", () => {
  const s = freshSqlite("f32");
  const f32 = new Float32Array([1, 0, 0.25]);
  s.add({
    id: 1, text: "vec", created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z", embedding: f32,
  });
  const got = s.get(1);
  assert.ok(got.embedding instanceof Float32Array, "store returns typed array, not number[]");
  assert.ok(embClose(got.embedding, f32), "round-trip within 1e-5");
  assert.strictEqual(normalize({ embedding: got.embedding }).embedding, null,
    "normalize still drops it — attach-after is the store's job");
  s.close();
});

test("I5-SQLite / BUG-002: recall updates only retention columns on returned rows", () => {
  const s = freshSqlite("bug002");
  const created = "2026-01-01T00:00:00.000Z";
  s.add(normalize({ id: 1, text: "a", embedding: [1, 0], created, source: "user_stated" }));
  s.add(normalize({ id: 2, text: "b", embedding: [0, 1], created, source: "user_stated" }));
  const snap = (r) => ({
    id: Number(r.id), created: r.created, modified: r.modified, text: r.text,
    valid_from: r.valid_from, valid_to: r.valid_to, last_confirmed: r.last_confirmed,
    superseded_by: r.superseded_by, supersedes: r.supersedes, revision: r.revision,
    needs_review: r.needs_review, embedding_version: r.embedding_version,
    source: r.source, is_constraint: r.is_constraint, deleted: r.deleted,
    embedding: Array.from(r.embedding || []),
  });
  const before1 = snap(s.get(1));
  const before2 = snap(s.get(2));
  const nBefore = s.all().length;
  s.applyRecall([1], new Map());
  assert.strictEqual(s.all().length, nBefore, "row count unchanged");
  const after1 = s.get(1);
  const after2 = s.get(2);
  assert.strictEqual(after1.access_count, 1, "returned row was bumped");
  assert.ok(after1.last_access, "last_access stamped");
  assert.deepStrictEqual(snap(after1), before1, "no non-retention column on id 1 changed");
  assert.strictEqual(after2.access_count, 0, "non-returned row not bumped");
  assert.strictEqual(after2.last_access, null);
  assert.deepStrictEqual(snap(after2), before2, "id 2 entirely untouched");
  s.close();
});

test("SqliteStore: access_count does not double after an edit (BUG-007 class)", () => {
  const s = freshSqlite("no-double");
  s.add(normalize({ id: 1, text: "x", created: "2026-01-01T00:00:00.000Z" }));
  s.applyRecall([1], new Map());
  s.applyRecall([1], new Map());
  assert.strictEqual(s.get(1).access_count, 2);
  s.update(1, { text: "edited" });
  assert.strictEqual(s.get(1).access_count, 2, "edit must not inflate");
  s.close();
});

test("SqliteStore vacuum drops deleted rows, keeps counts on survivors", () => {
  const s = freshSqlite("vac");
  s.add(normalize({ id: 1, text: "keep", created: "2026-01-01T00:00:00.000Z" }));
  s.add(normalize({ id: 2, text: "gone", deleted: true, created: "2026-01-01T00:00:00.000Z" }));
  s.applyRecall([1], new Map());
  assert.strictEqual(s.hasDeleted(), true);
  assert.strictEqual(s.vacuum(), 1);
  assert.strictEqual(s.all().length, 1);
  assert.strictEqual(s.get(1).access_count, 1);
  assert.strictEqual(s.hasDeleted(), false);
  s.close();
});

test("SqliteStore nextId stays unique under rapid saves", () => {
  const s = freshSqlite("nextid");
  const ids = [];
  for (let i = 0; i < 200; i++) {
    const id = s.nextId();
    ids.push(String(id));
    s.add(normalize({ id, text: "m" + i, created: "2026-01-01T00:00:00.000Z" }));
  }
  assert.strictEqual(new Set(ids).size, 200);
  assert.strictEqual(s.all().length, 200);
  s.close();
});

test("conformance: add/get/current/active/updateMany/vacuum match JsonlStore", () => {
  const created = "2026-03-01T00:00:00.000Z";
  const jsonl = freshStore();
  const sqlite = freshSqlite("conf");
  const recs = [
    normalize({ id: 1, text: "I work at Acme", embedding: [1, 0, 0], created }),
    normalize({ id: 2, text: "I prefer tea", embedding: [0, 1, 0], created }),
    normalize({ id: 3, text: "gone", deleted: true, embedding: [0, 0, 1], created }),
  ];
  for (const r of recs) { jsonl.add(r); sqlite.add(r); }

  const cmp = (a, b, label) => {
    assert.strictEqual(a.length, b.length, label + " length");
    const A = a.map(recFields).sort((x, y) => x.id.localeCompare(y.id));
    const B = b.map(recFields).sort((x, y) => x.id.localeCompare(y.id));
    assert.deepStrictEqual(A, B, label + " fields");
    for (let i = 0; i < a.length; i++) {
      const ja = jsonl.get(A[i].id), sa = sqlite.get(A[i].id);
      assert.ok(embClose(ja.embedding, sa.embedding), label + " embedding id " + A[i].id);
    }
  };
  cmp(jsonl.current(), sqlite.current(), "current");
  cmp(jsonl.active(), sqlite.active(), "active");
  cmp(jsonl.all(), sqlite.all(), "all");

  const p = supersedePatches(jsonl.get(1), jsonl.get(2), "T2");
  assert.strictEqual(jsonl.updateMany({ "1": p.old, "2": p.new }), 2);
  assert.strictEqual(sqlite.updateMany({ "1": p.old, "2": p.new }), 2);
  cmp(jsonl.current(), sqlite.current(), "after supersession current");
  cmp(jsonl.active(), sqlite.active(), "after supersession active");
  assert.strictEqual(jsonl.get(1).valid_to, sqlite.get(1).valid_to);
  assert.strictEqual(String(jsonl.get(1).superseded_by), String(sqlite.get(1).superseded_by));

  jsonl.applyRecall([2], new Map());
  sqlite.applyRecall([2], new Map());
  assert.strictEqual(jsonl.get(2).access_count, sqlite.get(2).access_count);
  assert.strictEqual(jsonl.get(1).access_count, sqlite.get(1).access_count);

  assert.strictEqual(jsonl.vacuum(), sqlite.vacuum());
  cmp(jsonl.all(), sqlite.all(), "after vacuum");
  sqlite.close();
});

} // sqliteAvailable

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

// ------------------------------------------------- Phase 0 contract (RM-21)
// Section headers keyed to sub-phase / invariant. Slice C wired EdgeStore
// into recall: module-level cases still fail without edges.js; live-path
// cases (I3/I5/I9, migration-numbers, constraint-rescue) fail without the
// memory-core wiring. 0.5 fills remaining transition-table Writes? cells
// and the atomic-recovery tests; it does not re-add coverage that 0.0–0.4
// already hold.
section("Phase 0.0 unified edge record + migration");

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
section("Phase 0.4 soft prune + reactivation (I8)");

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

// --- Phase 0.5: remaining transition-table Writes? cells + atomic recovery --
// Gaps the earlier slices left: interrupted sidecar recovery, the hard-compaction
// write, pruneSweep's positive write, and the full soft-prune column set.
// Failure signatures that already have a guarding test are not re-added.
section("Phase 0.5 contract (transition-table Writes? + atomic recovery)");

test("transition: leftover .tmp sibling is not the store (interrupted persist, EdgeStore)", () => {
  const file = tmp("p05-tmp-sibling.edges.json");
  const E = new EdgeStore(file, { now: () => T0 });
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.7 }));
  E.save();
  const leftover = path.join(path.dirname(file), "." + path.basename(file) + ".999.1.tmp");
  fs.writeFileSync(leftover, "{ this is a partial write");
  const reloaded = new EdgeStore(file, { now: () => T0 });
  assert.strictEqual(reloaded.size, 1, "load reads the target, not the leftover tmp");
  assert.strictEqual(reloaded.get(1, 2).hebbian.weight, 0.7);
});

test("transition: a leftover .tmp with no target is NOT ingested (fail-open empty)", () => {
  // Recovery is "all-old or all-new", never "promote the temp". A crash
  // before the first rename leaves no target; I3 fail-open is empty, not
  // a guess at a partial file. Learned weight in that tmp is gone — the
  // same cost as a corrupt sidecar.
  const file = tmp("p05-tmp-only.edges.json");
  const leftover = path.join(path.dirname(file), "." + path.basename(file) + ".999.1.tmp");
  const ghost = makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.99 });
  fs.writeFileSync(leftover, JSON.stringify({
    kind: SIDECAR_KIND, version: SIDECAR_VERSION, recalls: 0,
    edges: { [edgeKey(1, 2)]: ghost },
  }));
  const E = new EdgeStore(file, { now: () => T0 });
  assert.strictEqual(E.size, 0, "tmp is not the store; a missing target fail-opens empty");
  assert.strictEqual(E.get(1, 2), undefined);
});

test("transition: EdgeStore.save failure does not throw and does not empty the in-memory table (I3)", () => {
  // save() swallows write errors so a full disk cannot break recall.
  // In-memory learned weight is kept; the next successful save persists it.
  const dir = tmp("p05-save-fail-dir");
  fs.mkdirSync(dir);
  const E = new EdgeStore(dir, { now: () => T0 });   // path is a directory → rename fails
  E.put(makeEdge(1, 2, { origin: "co-activation", now: T0, hebbianWeight: 0.4 }));
  assert.doesNotThrow(() => E.save(), "I3: sidecar write must never throw into recall");
  assert.strictEqual(E.size, 1, "failed persist must not wipe the in-memory table");
  assert.strictEqual(E.get(1, 2).hebbian.weight, 0.4);
});

test("transition: soft prune writes the sidecar; semantic + hebbian + created_at + last_updated unmoved", () => {
  const file = tmp("p05-soft-cols.edges.json");
  const E = new EdgeStore(file, { now: () => T0 });
  const e0 = putCombo(E, 1, 2, 0, 0.10);
  const created = e0.created_at;
  const hebSnap = JSON.parse(JSON.stringify(e0.hebbian));
  const semSnap = JSON.parse(JSON.stringify(e0.semantic));
  E.save();
  const before = fs.readFileSync(file, "utf8");
  assert.strictEqual(E.pruneSweep(), 1);
  const after = E.get(1, 2);
  assert.notStrictEqual(fs.readFileSync(file, "utf8"), before, "Writes? yes");
  assert.deepStrictEqual(after.semantic, semSnap, "semantic unchanged");
  assert.deepStrictEqual(after.hebbian, hebSnap, "stored Hebbian unchanged (keeps the decayed value)");
  assert.strictEqual(after.created_at, created);
  assert.strictEqual(after.pruned_at, T0);
  assert.strictEqual(after.prune_count, 1);
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(disk.edges["1:2"].pruned_at, T0);
});

test("transition: hard compaction writes the sidecar and drops both signals", () => {
  const file = tmp("p05-vac-write.edges.json");
  const E = new EdgeStore(file, { now: () => T0 });
  putCombo(E, 1, 2, 0, 0.10);
  putCombo(E, 3, 4, 0.8, 0.70);
  E.pruneSweep();
  const before = fs.readFileSync(file, "utf8");
  assert.ok(JSON.parse(before).edges["1:2"], "soft-pruned row still on disk");
  assert.strictEqual(E.vacuum(), 1);
  const after = fs.readFileSync(file, "utf8");
  assert.notStrictEqual(after, before, "Writes? yes");
  const j = JSON.parse(after);
  assert.strictEqual(j.edges["1:2"], undefined, "pruned row dropped (both signals gone)");
  assert.ok(j.edges["3:4"], "active row kept");
  assert.strictEqual(j.edges["3:4"].hebbian.weight, 0.8);
  assert.strictEqual(j.edges["3:4"].semantic.value, 0.70);
});

test("transition: vacuum of nothing does not rewrite the sidecar", () => {
  const file = tmp("p05-vac-nowrite.edges.json");
  const E = new EdgeStore(file, { now: () => T0 });
  putCombo(E, 1, 2, 1.0, 0.70);
  E.save();
  const before = fs.readFileSync(file, "utf8");
  const mtime = fs.statSync(file).mtimeMs;
  assert.strictEqual(E.vacuum(), 1, "remaining count, nothing dropped");
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
});

// ------------------------------------------------- ROC/TBR field signals (RM-00)
section("field signals: ROC / TBR (RM-00)");

const {
  fieldSignals,
  register, listMetrics, computeMetric, explainMetric, makeRecallAtK, parsePrimaryHits,
  isCorrectStored, COVER_MAX_WORDS,
} = require("./eval/metrics.js");

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

// --------------------------------------- reporting metric registry (RM-02.a)
section("eval metric registry (RM-02.a)");

const REGISTRY_QUERIES = {
  queries: [
    { id: "q1", ranked_ids: ["a", "b", "c"], relevant_ids: ["b"] },  // hit @2, miss @1
    { id: "q2", ranked_ids: ["x", "y"], relevant_ids: ["z"] },        // miss
    { id: "q3", ranked_ids: ["p"], relevant_ids: ["p"] },              // hit @1
  ],
};

test("recall_at_k on a hand-built result set (success@k)", () => {
  assert.strictEqual(computeMetric("recall_at_k", REGISTRY_QUERIES, null, { k: 5 }), 2 / 3);
  assert.strictEqual(computeMetric("recall_at_k", REGISTRY_QUERIES, null, { k: 2 }), 2 / 3);
  assert.strictEqual(computeMetric("recall_at_k", REGISTRY_QUERIES, null, { k: 1 }), 1 / 3);
  const expl = explainMetric("recall_at_k", REGISTRY_QUERIES, null, { k: 1 });
  assert.deepStrictEqual(expl.misses, ["q1", "q2"]);
  assert.strictEqual(expl.hits, 1);
});

test("recall_at_k skips unlabeled queries and defaults k=5", () => {
  const mixed = { queries: [
    { ranked_ids: ["a"], relevant_ids: ["a"] },
    { ranked_ids: ["b"], relevant_ids: [] },          // unlabeled
    { ranked_ids: ["c"] },                            // unlabeled
  ] };
  assert.strictEqual(computeMetric("recall_at_k", mixed, null), 1);
  assert.strictEqual(explainMetric("recall_at_k", mixed, null).n, 1);
});

test("mrr on a tiny known-ranked set", () => {
  // q1 hit @2 → 1/2; q2 miss → 0; q3 hit @1 → 1. MRR = 1.5/3 = 0.5
  assert.strictEqual(computeMetric("mrr", REGISTRY_QUERIES, null), 0.5);
  const expl = explainMetric("mrr", REGISTRY_QUERIES, null);
  assert.strictEqual(expl.n, 3);
  assert.strictEqual(expl.n_found, 2);
  assert.strictEqual(expl.n_missed, 1);
  assert.deepStrictEqual(expl.misses, ["q2"]);
  assert.strictEqual(expl.mean_rank, 1.5);          // (2+1)/2 over found
  assert.strictEqual(expl.median_rank, 1.5);
  assert.strictEqual(expl.byQuery[0].rank, 2);
  assert.strictEqual(expl.byQuery[0].reciprocal, 0.5);
  assert.strictEqual(expl.byQuery[1].rank, null);
  assert.strictEqual(expl.byQuery[2].rank, 1);
});

test("mrr skips unlabeled queries; miss contributes 0 not NaN", () => {
  const mixed = { queries: [
    { id: "hit", ranked_ids: ["a", "b"], relevant_ids: ["b"] },
    { id: "unlabeled", ranked_ids: ["x"], relevant_ids: [] },
    { id: "miss", ranked_ids: ["y"], relevant_ids: ["z"] },
  ] };
  assert.strictEqual(computeMetric("mrr", mixed, null), 0.25); // (0.5 + 0) / 2
  const expl = explainMetric("mrr", mixed, null);
  assert.strictEqual(expl.n, 2);
  assert.deepStrictEqual(expl.misses, ["miss"]);
});

test("mrr is registered alongside recall_at_k", () => {
  assert.ok(listMetrics().some((m) => m.name === "mrr"));
});

test("duplicate_rate on a known-labeled set", () => {
  const records = [{ text: "a1" }, { text: "a2" }, { text: "b1" }, { text: "c1" }];
  const corpus = { groups: { A: ["a1", "a2"], B: ["b1"], C: ["c1"] } };
  assert.strictEqual(computeMetric("duplicate_rate", { records }, corpus), 0.25);
  const expl = explainMetric("duplicate_rate", { records }, corpus);
  assert.strictEqual(expl.n, 4);
  assert.strictEqual(expl.gStar, 3);
  assert.strictEqual(expl.extras, 1);
  assert.strictEqual(expl.byGroup.A.extras, 1);
  assert.strictEqual(expl.byGroup.B.extras, 0);
});

test("duplicate_rate: collapsed exact pair is not redundant; unmatched is not either", () => {
  const collapsed = { records: [{ text: "same" }] };
  const coffee = { groups: { coffee: ["same", "same"] } };
  assert.strictEqual(computeMetric("duplicate_rate", collapsed, coffee), 0);
  const withMystery = { records: [{ text: "a1" }, { text: "mystery" }] };
  const labeled = { groups: { A: ["a1"] } };
  assert.strictEqual(computeMetric("duplicate_rate", withMystery, labeled), 0,
    "unmatched records count as their own singleton, not as extras");
  assert.strictEqual(computeMetric("duplicate_rate", { records: [] }, labeled), 0);
});

test("registering a new metric works; duplicate names throw", () => {
  register({ name: "rm02a_always_half", compute() { return 0.5; } });
  assert.strictEqual(computeMetric("rm02a_always_half", {}, {}), 0.5);
  assert.ok(listMetrics().some((m) => m.name === "rm02a_always_half"));
  assert.throws(() => register({ name: "rm02a_always_half", compute() { return 0; } }),
    /duplicate name/);
  assert.throws(() => register({ name: "nope" }), /compute/);
  register(makeRecallAtK(1));
  assert.strictEqual(computeMetric("recall@1", REGISTRY_QUERIES, null), 1 / 3);
});

test("parsePrimaryHits reads the cosine list and ignores Related:", () => {
  const out = "1. [id 12] I'm allergic to penicillin\n2. [id 7] I live in Texas\n\nRelated:\n- [id 99] junk";
  const hits = parsePrimaryHits(out);
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].id, "12");
  assert.strictEqual(hits[1].id, "7");
});

test("duplicates corpus loads with all three RM-02 bands plus queries", () => {
  const { loadScenarios } = require("./eval/measure.js");
  const scenarios = loadScenarios(path.join(__dirname, "eval", "corpora", "duplicates.jsonl"));
  assert.strictEqual(scenarios.length, 1);
  const s = scenarios[0];
  const bands = new Set(s.writes.map((w) => w.band));
  assert.ok(bands.has("hi") && bands.has("mid") && bands.has("control") && bands.has("exact"),
    "corpus covers hi / mid / control / exact");
  assert.ok(s.queries.length >= 8, "enough queries for recall@k");
  const gids = new Set(s.writes.map((w) => w.dup_group));
  for (const q of s.queries) {
    assert.ok(Array.isArray(q.relevant_groups) && q.relevant_groups.length, q.id + " needs relevant_groups");
    for (const g of q.relevant_groups) assert.ok(gids.has(g), q.id + " group " + g + " missing from writes");
  }
  const multi = [...gids].filter((g) => s.writes.filter((w) => w.dup_group === g).length > 1);
  assert.ok(multi.length >= 3, "several multi-member dup groups");
});

test("extraction_precision on a tiny hand-labeled set with a known answer", () => {
  const results = { cases: [
    { stored: [{ text: "I have a dog named Rex" }], refused: false },
    { stored: [{ text: "Samuel prefers concise answers" }], refused: false },
    { stored: [{ text: "I think you should know that I live in Texas" }], refused: false },
  ] };
  const corpus = { cases: [
    { gold_facts: ["I have a dog named Rex"], noise: [] },
    { gold_facts: ["Samuel prefers concise answers"], noise: ["I think you should know that"] },
    { gold_facts: ["I live in Texas"], noise: ["I think you should know that"] },
  ] };
  assert.strictEqual(computeMetric("extraction_precision", results, corpus), 2 / 3);
  const expl = explainMetric("extraction_precision", results, corpus);
  assert.strictEqual(expl.n_stored, 3);
  assert.strictEqual(expl.n_correct, 2);
  assert.strictEqual(expl.n_noise, 1);
  assert.strictEqual(expl.n_labeled, 3);
});

test("extraction_precision: a stored-noise item lowers precision", () => {
  const clean = { cases: [
    { stored: [{ text: "I have a dog named Rex" }], refused: false },
    { stored: [{ text: "My name is Samuel" }], refused: false },
  ] };
  const gold = { cases: [
    { gold_facts: ["I have a dog named Rex"], noise: [] },
    { gold_facts: ["My name is Samuel"], noise: [] },
  ] };
  assert.strictEqual(computeMetric("extraction_precision", clean, gold), 1);
  const withNoise = { cases: clean.cases.concat([
    { stored: [{ text: "make sure you remind me about the standup" }], refused: false },
  ]) };
  const goldNoise = { cases: gold.cases.concat([
    { gold_facts: ["The Friday standup is at 10am"], noise: ["make sure you"] },
  ]) };
  const lowered = computeMetric("extraction_precision", withNoise, goldNoise);
  assert.strictEqual(lowered, 2 / 3);
  assert.ok(lowered < 1, "noise in the store must drop precision");
});

test("extraction_precision: a refused-PII item counts correctly", () => {
  const refused = { cases: [
    { stored: [{ text: "My name is Samuel" }], refused: false },
    { stored: [], refused: true },
  ] };
  const corpus = { cases: [
    { gold_facts: ["My name is Samuel"], noise: [] },
    { gold_facts: [], noise: ["sk-abcdefghijklmnopqrstuvwxyz123456"], expect_refusal: true },
  ] };
  assert.strictEqual(computeMetric("extraction_precision", refused, corpus), 1,
    "a correct refusal stores nothing, so it does not dilute precision");
  const expl = explainMetric("extraction_precision", refused, corpus);
  assert.strictEqual(expl.n_pii, 1);
  assert.strictEqual(expl.n_pii_refused, 1);
  assert.strictEqual(expl.pii_refusal_rate, 1);
  assert.strictEqual(expl.n_stored, 1);

  const leaked = { cases: [
    { stored: [{ text: "My name is Samuel" }], refused: false },
    { stored: [{ text: "my API key is sk-abcdefghijklmnopqrstuvwxyz123456" }], refused: false },
  ] };
  assert.strictEqual(computeMetric("extraction_precision", leaked, corpus), 0.5,
    "storing PII is a false positive");
  const leakedExpl = explainMetric("extraction_precision", leaked, corpus);
  assert.strictEqual(leakedExpl.pii_refusal_rate, 0);
  assert.strictEqual(leakedExpl.n_pii_refused, 0);
});

test("extraction_precision is registered; unlabeled input does not crash", () => {
  assert.ok(listMetrics().some((m) => m.name === "extraction_precision"));
  assert.ok(listMetrics().some((m) => m.name === "extraction_recall"),
    "extraction_recall ships with 01.b as the anti-cheat for vacuous precision");
  assert.strictEqual(computeMetric("extraction_precision", { records: [{ text: "x" }] }, { groups: {} }), 0,
    "duplicates-shaped input has no gold_facts, so it is unlabeled");
  assert.strictEqual(computeMetric("extraction_recall", { records: [{ text: "x" }] }, { groups: {} }), 0);
  assert.strictEqual(computeMetric("recall_at_k", REGISTRY_QUERIES, null, { k: 5 }), 2 / 3);
  const records = [{ text: "a1" }, { text: "a2" }, { text: "b1" }, { text: "c1" }];
  const dupCorpus = { groups: { A: ["a1", "a2"], B: ["b1"], C: ["c1"] } };
  assert.strictEqual(computeMetric("duplicate_rate", { records }, dupCorpus), 0.25);
});

test("extraction_recall is the anti-cheat for vacuous precision", () => {
  const gold = { cases: [
    { gold_facts: ["Samuel prefers concise answers"], noise: ["I think you should know that"] },
    { gold_facts: ["I live in Texas"], noise: [] },
  ] };
  const perfect = { cases: [
    { stored: [{ text: "Samuel prefers concise answers" }] },
    { stored: [{ text: "I live in Texas" }] },
  ] };
  assert.strictEqual(computeMetric("extraction_recall", perfect, gold), 1);
  assert.strictEqual(computeMetric("extraction_precision", perfect, gold), 1);

  const missed = { cases: [
    { stored: [{ text: "Samuel prefers concise answers" }] },
    { stored: [] },
  ] };
  assert.strictEqual(computeMetric("extraction_recall", missed, gold), 0.5);
  assert.strictEqual(computeMetric("extraction_precision", missed, gold), 1,
    "storing only correct facts keeps precision at 1 even when a gold is dropped");

  const refusedAll = { cases: [{ stored: [], refused: true }, { stored: [], refused: true }] };
  assert.strictEqual(computeMetric("extraction_precision", refusedAll, gold), 1,
    "refuse-everything is vacuous precision 1.0");
  assert.strictEqual(computeMetric("extraction_recall", refusedAll, gold), 0,
    "…and extraction_recall craters, which is the point");
});

test("messy corpus loads; every write has gold_facts + noise labels", () => {
  const { loadScenarios } = require("./eval/measure.js");
  const scenarios = loadScenarios(path.join(__dirname, "eval", "corpora", "messy.jsonl"));
  assert.strictEqual(scenarios.length, 1);
  const s = scenarios[0];
  assert.ok(s.writes.length >= 15, "enough writes to cover the Tier-0/1 shapes");
  assert.ok(s.queries.length >= 8, "enough queries for a later recall@5 A/B");
  const bands = new Set(s.writes.map((w) => w.band));
  for (const need of ["filler", "imperative", "multi", "pii", "control"]) {
    assert.ok(bands.has(need), "corpus missing band " + need);
  }
  assert.ok(bands.has("multi-nosplit"), "over-split trap (and also with a non-standalone half)");
  const writeIds = new Set(s.writes.map((w) => w.id));
  for (const w of s.writes) {
    assert.ok(Array.isArray(w.gold_facts), w.id + " needs gold_facts (empty array = refuse)");
    assert.ok(Array.isArray(w.noise), w.id + " needs noise (empty array = none)");
    if (w.band === "pii") {
      assert.ok(w.expect_refusal, w.id + " PII must expect_refusal");
      assert.strictEqual(w.gold_facts.length, 0, w.id + " PII gold is store-nothing");
    } else {
      assert.ok(w.gold_facts.length >= 1, w.id + " non-PII needs at least one gold fact");
    }
  }
  for (const q of s.queries) {
    assert.ok(Array.isArray(q.relevant_writes) && q.relevant_writes.length, q.id + " needs relevant_writes");
    for (const id of q.relevant_writes) {
      assert.ok(writeIds.has(id), q.id + " write " + id + " missing from writes");
    }
  }
  const pii = s.writes.filter((w) => w.expect_refusal);
  assert.ok(pii.length >= 4, "a few secret/PII shapes");
});

test("messy-hard corpus loads; every write is a long blob with gold facts", () => {
  const { loadScenarios } = require("./eval/measure.js");
  const scenarios = loadScenarios(path.join(__dirname, "eval", "corpora", "messy-hard.jsonl"));
  assert.strictEqual(scenarios.length, 1);
  const s = scenarios[0];
  assert.strictEqual(s.extract_match, "cover");
  assert.ok(s.writes.length >= 8, "enough hard cases");
  assert.ok(s.queries.length >= 12, "enough queries for recall@5");
  const writeIds = new Set(s.writes.map((w) => w.id));
  const bands = new Set(s.writes.map((w) => w.band));
  for (const need of ["implicit", "narrative", "coreference", "multi-and"]) {
    assert.ok(bands.has(need), "messy-hard missing band " + need);
  }
  for (const w of s.writes) {
    assert.ok(Array.isArray(w.gold_facts) && w.gold_facts.length >= 1, w.id + " needs gold");
    assert.ok(w.text.trim().split(/\s+/).length > COVER_MAX_WORDS,
      w.id + " blob must exceed COVER_MAX_WORDS so Tier 0 fails cover-match");
    assert.strictEqual(w.extract_match, "cover");
    assert.ok(!w.expect_refusal, w.id + " is not a PII case");
    // Tier 0 cannot emit these gold facts: no '; '/ 'and also' split, and
    // the gold string is not the blob.
    const prepared = prepareWrite(w.text);
    assert.ok(prepared.ok && prepared.facts.length === 1, w.id + " Tier 0 keeps one blob");
    assert.strictEqual(prepared.facts[0], w.text.replace(/\s+/g, " ").trim());
    for (const g of w.gold_facts) {
      assert.ok(!isCorrectStored(prepared.facts[0], [g], w.noise || [], "cover"),
        w.id + " Tier 0 blob must not cover gold " + JSON.stringify(g));
    }
  }
  for (const q of s.queries) {
    assert.ok(Array.isArray(q.relevant_writes) && q.relevant_writes.length, q.id);
    assert.ok(Array.isArray(q.relevant_facts) && q.relevant_facts.length, q.id);
    for (const id of q.relevant_writes) assert.ok(writeIds.has(id), q.id + " missing write " + id);
  }
});

test("messy corpus: current-save simulation is the pre-extraction baseline", () => {
  const { loadScenarios } = require("./eval/measure.js");
  const s = loadScenarios(path.join(__dirname, "eval", "corpora", "messy.jsonl"))[0];
  const results = { cases: s.writes.map((w) => ({
    id: w.id, stored: [{ text: w.text }], refused: false,
  })) };
  const expl = explainMetric("extraction_precision", results, { cases: s.writes });
  assert.strictEqual(expl.n_labeled, s.writes.length);
  assert.strictEqual(expl.n_stored, s.writes.length, "today save() stores one blob per write");
  // 5 controls + 1 should-not-split compound pass through as-is; filler,
  // imperative, to-split multi, and PII blobs are not gold.
  assert.strictEqual(expl.n_correct, 6);
  assert.strictEqual(expl.rate, 6 / 23);
  assert.strictEqual(expl.n_pii, s.writes.filter((w) => w.expect_refusal).length);
  assert.strictEqual(expl.pii_refusal_rate, 0);
});

// ------------------------------------------------- S1 substrate generator (eval/substrate)
section("S1 substrate scale generator");

const {
  generateScaleCorpus, attachSyntheticEmbeddings, NEEDLES, DEFAULT_SEED, plantedCountFor,
} = require("./eval/substrate/generate.js");

test("generator produces well-formed labeled memories + needles with known relevance", () => {
  const corpus = generateScaleCorpus({ n: 250, seed: DEFAULT_SEED });
  assert.strictEqual(corpus.records.length, 250);
  assert.strictEqual(corpus.queries.length, NEEDLES.length);
  assert.ok(corpus.planted >= NEEDLES.length * 2, "each needle has at least one distractor");
  const texts = new Set();
  const needles = [];
  const distractors = [];
  for (const r of corpus.records) {
    assert.ok(r.id >= 1 && r.text && r.role, "record needs id/text/role");
    assert.ok(["needle", "distractor", "haystack"].includes(r.role), r.role);
    assert.ok(!texts.has(r.text.toLowerCase()), "duplicate text: " + r.text);
    texts.add(r.text.toLowerCase());
    if (r.role === "needle") {
      assert.ok(r.needleId);
      needles.push(r);
    }
    if (r.role === "distractor") {
      assert.ok(r.needleId && r.kind, "distractor needs needleId + kind");
      distractors.push(r);
    }
  }
  assert.strictEqual(needles.length, NEEDLES.length);
  assert.ok(distractors.length >= NEEDLES.length, "hard near-topic distractors planted");
  const byId = new Map(corpus.records.map((r) => [String(r.id), r]));
  for (const q of corpus.queries) {
    assert.ok(q.query && q.needleId && q.relevant_ids.length === 1, q.id);
    const rec = byId.get(String(q.relevant_ids[0]));
    assert.ok(rec && rec.role === "needle" && rec.needleId === q.needleId, q.id + " relevant is the needle");
    assert.strictEqual(rec.text, q.relevant_text);
  }
  const height = corpus.records.find((r) => /terrified of heights/i.test(r.text));
  assert.ok(height && height.role === "distractor" && height.needleId === "height-bookshelf",
    "adv-height-homonym is a planted distractor for the bookshelf needle");
});

test("generator is deterministic for a seed; larger N is a planted+haystack prefix", () => {
  const a = generateScaleCorpus({ n: 200, seed: 7 });
  const b = generateScaleCorpus({ n: 200, seed: 7 });
  assert.deepStrictEqual(a.records.map((r) => r.text), b.records.map((r) => r.text));
  const c = generateScaleCorpus({ n: 200, seed: 8 });
  assert.notDeepStrictEqual(a.records.map((r) => r.text), c.records.map((r) => r.text));
  const small = generateScaleCorpus({ n: 200, seed: 1 });
  const large = generateScaleCorpus({ n: 500, seed: 1 });
  assert.deepStrictEqual(
    small.records.map((r) => r.text),
    large.records.slice(0, 200).map((r) => r.text)
  );
  const plantedSmall = small.records.filter((r) => r.role !== "haystack");
  const plantedLarge = large.records.filter((r) => r.role !== "haystack");
  assert.deepStrictEqual(plantedSmall.map((r) => r.id + ":" + r.text), plantedLarge.map((r) => r.id + ":" + r.text));
});

test("generator rejects n below planted count and unknown needle ids", () => {
  const nNeed = plantedCountFor(NEEDLES);
  assert.throws(() => generateScaleCorpus({ n: nNeed - 1 }), /planted/);
  assert.throws(() => generateScaleCorpus({ n: 100, needleIds: ["no-such-needle"] }), /unknown needle/);
});

test("haystack does not restatement-collide with a needle's current first-person slot", () => {
  const corpus = generateScaleCorpus({ n: 2000, seed: DEFAULT_SEED });
  const hay = corpus.records.filter((r) => r.role === "haystack");
  assert.ok(hay.length > 100);
  for (const r of hay) {
    assert.ok(!/\bi work at\b/i.test(r.text), "haystack stole the job slot: " + r.text);
    assert.ok(!/\bi live in\b/i.test(r.text), "haystack stole the city slot: " + r.text);
    assert.ok(!/\bi(?:'m| am) allergic to\b/i.test(r.text), "haystack stole the allergy slot: " + r.text);
    assert.ok(!/terrified of heights/i.test(r.text));
    assert.ok(!/penicillin/i.test(r.text));
    assert.ok(!/globex/i.test(r.text));
  }
});

test("subset of 3 needles in n=100 is well-formed (S1 e2e fixture)", () => {
  const ids = ["allergy-penicillin", "height-bookshelf", "job-globex"];
  const corpus = generateScaleCorpus({ n: 100, seed: 1, needleIds: ids });
  assert.strictEqual(corpus.records.length, 100);
  assert.strictEqual(corpus.queries.length, 3);
  assert.strictEqual(corpus.records.filter((r) => r.role === "needle").length, 3);
  assert.ok(corpus.records.filter((r) => r.role === "distractor").length >= 9);
});

// ------------------------------------------------- RM-01.b write-side extraction
// Tier 0 (normalize/strip/split) + Tier 1 (PII refusal). Pure, so these
// assert against corpus gold without an embedder. save() wiring + embed
// counts live in asyncTests.

section("RM-01.b write-side extraction (Tier 0/1)");

test("filler: 'I think you should know that' strips to the inner proposition, not a half-opener", () => {
  const r = prepareWrite("I think you should know that Samuel prefers concise answers");
  assert.deepStrictEqual(r.facts, ["Samuel prefers concise answers"]);
  assert.ok(!/^you should know that/i.test(r.facts[0]),
    "0001's /^(i think )/ would leave 'You should know that…' — that is the bug");
});

test("filler: 'just so you're aware' strips to the inner proposition", () => {
  assert.deepStrictEqual(
    prepareWrite("just so you're aware, I usually code late at night").facts,
    ["I usually code late at night"]);
});

test("filler: 'just so you know' strips to the inner proposition", () => {
  assert.deepStrictEqual(
    prepareWrite("Just so you know, I prefer tea over coffee").facts,
    ["I prefer tea over coffee"]);
});

test("filler: 'It's worth noting that' strips to the inner proposition", () => {
  assert.deepStrictEqual(
    prepareWrite("It's worth noting that I'm allergic to penicillin").facts,
    ["I'm allergic to penicillin"]);
});

test("filler: FYI strips and recases the leftover", () => {
  assert.deepStrictEqual(
    prepareWrite("FYI, the Friday standup is at 10am").facts,
    ["The Friday standup is at 10am"]);
});

test("filler: stacked FYI + just so you know both come off", () => {
  assert.deepStrictEqual(
    prepareWrite("FYI, just so you know, I have a cat named Koneko").facts,
    ["I have a cat named Koneko"]);
});

test("imperative: 'remember to remind me' keeps the embedded fact", () => {
  assert.deepStrictEqual(
    prepareWrite("remember to remind me that my sister's birthday is March 3rd").facts,
    ["My sister's birthday is March 3rd"]);
});

test("imperative: 'make sure you' keeps the embedded fact", () => {
  assert.deepStrictEqual(
    prepareWrite("make sure you never give me peanuts").facts,
    ["Never give me peanuts"]);
});

test("imperative: 'Please remember that' keeps the embedded fact", () => {
  assert.deepStrictEqual(
    prepareWrite("Please remember that I have a peanut allergy").facts,
    ["I have a peanut allergy"]);
});

test("imperative: 'don't forget to' / 'be sure to' strip framing", () => {
  assert.deepStrictEqual(
    prepareWrite("don't forget to note that I live in Texas").facts,
    ["I live in Texas"]);
  assert.deepStrictEqual(
    prepareWrite("be sure to remember that I prefer tea over coffee").facts,
    ["I prefer tea over coffee"]);
});

test("imperative with no payload drops the write (empty gold)", () => {
  const r = prepareWrite("remember that");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.facts, []);
});

test("multi: 'and also' splits only when both halves stand alone", () => {
  assert.deepStrictEqual(
    prepareWrite("I have a dog named Rex and also I work as a software architect, mostly on games").facts,
    ["I have a dog named Rex", "I work as a software architect, mostly on games"]);
});

test("multi: '; ' splits two standalone facts", () => {
  assert.deepStrictEqual(
    prepareWrite("My coffee order is an oat-milk cortado, no sugar; I live in Texas").facts,
    ["My coffee order is an oat-milk cortado, no sugar", "I live in Texas"]);
});

test("multi-nosplit: 'and also with honey' is NOT split", () => {
  const text = "I like tea more than coffee and also with honey";
  assert.strictEqual(isStandaloneFact("with honey"), false, "the second half is not a proposition");
  assert.deepStrictEqual(splitFacts(text), [text]);
  assert.deepStrictEqual(prepareWrite(text).facts, [text]);
});

test("PII shapes refuse: store nothing, return a refusal string", () => {
  const cases = [
    ["my API key is sk-abcdefghijklmnopqrstuvwxyz123456", "API key"],
    ["password: hunter2secret", "credential"],
    ["my card number is 4242424242424242", "card"],
    ["the AWS key is AKIAIOSFODNN7EXAMPLE", "AWS"],
    ["keep this -----BEGIN RSA PRIVATE KEY-----", "private key"],
    ["my GitHub token is ghp-abcdefghijklmnopqrstuvwx", "API key"],
  ];
  for (const [text, kind] of cases) {
    const r = prepareWrite(text);
    assert.strictEqual(r.ok, false, kind + " must refuse");
    assert.deepStrictEqual(r.facts, [], kind + " stores nothing");
    assert.ok(/not saved/i.test(r.message), kind + " message: " + r.message);
    assert.ok(/secrets don't belong/i.test(r.message), kind + " names the policy");
  }
});

test("PII mixed with a real fact is store-nothing, not redaction", () => {
  const r = prepareWrite("I live in Texas; my API key is sk-abcdefghijklmnopqrstuvwxyz123456");
  assert.strictEqual(r.ok, false, "contaminated write refuses the whole payload");
  assert.deepStrictEqual(r.facts, [], "must not salvage the Texas fact");
});

test("digit-trap controls survive the card guard (4821, 1500mg)", () => {
  assert.strictEqual(guardSecrets("The garage code is 4821").ok, true);
  assert.strictEqual(guardSecrets("I take 1500mg of metformin daily").ok, true);
  assert.deepStrictEqual(prepareWrite("The garage code is 4821").facts, ["The garage code is 4821"]);
  assert.deepStrictEqual(prepareWrite("I take 1500mg of metformin daily").facts,
    ["I take 1500mg of metformin daily"]);
});

test("clean control passes through byte-identical", () => {
  const clean = "My name is Samuel";
  const r = prepareWrite(clean);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.facts.length, 1);
  assert.strictEqual(r.facts[0], clean);
  assert.strictEqual(normalizeText(clean), clean);
});

test("whitespace collapse is the only transform on a clean fact", () => {
  assert.deepStrictEqual(
    prepareWrite("  I'm diabetic - no sugary recipes  ").facts,
    ["I'm diabetic - no sugary recipes"]);
});

test("0001's short 'I think ' opener is NOT used (would half-strip the gold case)", () => {
  // A genuine leading "I think " without the longer phrase stays put.
  // The corpus gold is the LONG opener; stripping "I think " alone is the bug.
  const kept = prepareWrite("I think Samuel likes dogs named Rex");
  assert.ok(kept.facts[0].toLowerCase().startsWith("i think "),
    "short 'I think ' must not fire; got " + kept.facts[0]);
});

// ------------------------------------------------- RM-01.c Tier 2 (pure)
section("RM-01.c Tier 2 extraction (pure, no network)");

const {
  parseExtractJson, sanityCheckExtract, acceptExtract, pickChatModel,
  isEmbeddingModel, clientSupportsSampling, readExtractEnabled,
  chatCompletionsUrl, modelsUrl, EXTRACT_MAX_FACTS,
} = require("./extract.js");

test("parseExtractJson: minified object, fenced, think-stripped", () => {
  assert.deepStrictEqual(
    parseExtractJson('{"facts":["I have a dog named Rex"],"skip":false}'),
    { facts: ["I have a dog named Rex"], skip: false }
  );
  assert.deepStrictEqual(
    parseExtractJson("```json\n{\"facts\":[\"A\"],\"skip\":false}\n```"),
    { facts: ["A"], skip: false }
  );
  assert.deepStrictEqual(
    parseExtractJson("<think>planning</think>{\"facts\":[\"B\"],\"skip\":false}"),
    { facts: ["B"], skip: false }
  );
  assert.throws(() => parseExtractJson("not json at all"), /no JSON|malformed/);
  assert.throws(() => parseExtractJson("{\"facts\":\"nope\"}"), /facts is not an array/);
});

test("sanityCheckExtract rejects skip, empty, too many, too long, prompt echo", () => {
  const src = "short source text";
  assert.strictEqual(sanityCheckExtract({ facts: ["ok fact here"], skip: false }, src).ok, true);
  assert.strictEqual(sanityCheckExtract({ facts: [], skip: true }, src).ok, false);
  assert.strictEqual(sanityCheckExtract({ facts: [], skip: false }, src).ok, false);
  const many = [];
  for (let i = 0; i < EXTRACT_MAX_FACTS + 1; i++) many.push("fact number " + i);
  assert.strictEqual(sanityCheckExtract({ facts: many, skip: false }, src).reason, "too-many");
  assert.strictEqual(sanityCheckExtract({
    facts: ["this extracted fact is way longer than the source by a large margin xx"],
    skip: false,
  }, src).reason, "too-long");
  const longSrc = "I have a dog named Rex and I live in Texas now as of last spring really";
  assert.strictEqual(sanityCheckExtract({
    facts: ["Extract durable facts"],
    skip: false,
  }, longSrc).reason, "prompt-echo");
});

test("acceptExtract: garbage degrades to null (keep Tier 0)", () => {
  const src = "I have a dog named Rex and I live in Texas now as of last spring";
  assert.deepStrictEqual(
    acceptExtract({ facts: ["I have a dog named Rex"], skip: false }, src),
    ["I have a dog named Rex"]
  );
  assert.strictEqual(acceptExtract({ facts: [], skip: true }, src), null);
  assert.strictEqual(acceptExtract("hello", src), null);
  assert.strictEqual(acceptExtract({ facts: "nope" }, src), null);
  assert.strictEqual(acceptExtract(null, src), null);
  assert.strictEqual(acceptExtract({ facts: [1, 2] }, src), null);
});

test("pickChatModel skips embedding ids; sampling capability is the initialize flag", () => {
  assert.ok(isEmbeddingModel("text-embedding-nomic-embed-text-v1.5"));
  assert.ok(!isEmbeddingModel("qwen3.6-35b-a3b"));
  const body = { data: [
    { id: "text-embedding-nomic-embed-text-v1.5" },
    { id: "openai/gpt-oss-20b" },
    { id: "qwen3.8-27b" },
  ] };
  assert.strictEqual(pickChatModel(body), "openai/gpt-oss-20b");
  assert.strictEqual(pickChatModel(body, "qwen3.8-27b"), "qwen3.8-27b");
  assert.strictEqual(pickChatModel({ data: [{ id: "text-embedding-nomic-embed-text-v1.5" }] }), null);
  assert.ok(clientSupportsSampling({ capabilities: { sampling: {} } }));
  assert.ok(!clientSupportsSampling({ capabilities: { tools: {} } }));
  assert.ok(!clientSupportsSampling(null));
});

test("readExtractEnabled: live-config wins over env, default off", () => {
  const prev = process.env.RESONANCE_EXTRACT_LLM;
  try {
    delete process.env.RESONANCE_EXTRACT_LLM;
    assert.strictEqual(readExtractEnabled(null), false, "off by default");
    assert.strictEqual(readExtractEnabled({ extract_llm: true }), true);
    process.env.RESONANCE_EXTRACT_LLM = "1";
    assert.strictEqual(readExtractEnabled(null), true, "env when no config");
    assert.strictEqual(readExtractEnabled({ extract_llm: false }), false, "config wins");
  } finally {
    if (prev === undefined) delete process.env.RESONANCE_EXTRACT_LLM;
    else process.env.RESONANCE_EXTRACT_LLM = prev;
  }
});

test("chat URL is derived from the embed endpoint, not a second config", () => {
  assert.strictEqual(
    chatCompletionsUrl("http://localhost:1234/v1/embeddings"),
    "http://localhost:1234/v1/chat/completions"
  );
  assert.strictEqual(modelsUrl("http://localhost:1234/v1/embeddings"), "http://localhost:1234/v1/models");
});

test("cover-match: a short paraphrase hits gold; a long blob does not", () => {
  const gold = ["I have a thyroid condition"];
  assert.ok(isCorrectStored("I have a thyroid condition", gold, [], "cover"));
  assert.ok(isCorrectStored("The user has a thyroid condition", gold, [], "cover"));
  const blob = "Stopped by the clinic after work and had a great chat with Dr. Chen about my thyroid. She wants me back in 3 months and said to keep taking the same dose until then. Felt better just having a plan.";
  assert.ok(blob.trim().split(/\s+/).length > COVER_MAX_WORDS, "fixture blob must exceed the atomic-length gate");
  assert.ok(!isCorrectStored(blob, gold, [], "cover"), "Tier 0 blob is not an extracted fact");
  assert.ok(!isCorrectStored("The user has a thyroid condition", gold, [], "exact"),
    "exact match (messy.jsonl) still rejects paraphrase");
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
  DEDUP_HI, DEDUP_LO, readDedupThresholds,
  dedupExisting,
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

// ------------------------------------------------ RM-07 slice 2b export / zip
section("RM-07 slice 2b — zip writer + sovereignty export (read-only)");

const {
  ZipWriter, ZipReader, hasZip64Eocd, crcOf, FLAG_UTF8, U16_MAX,
} = require("./zip.js");
const exp = require("./export-memory.js");

test("slug: lowercase, spaces→hyphens, keep words", () => {
  assert.strictEqual(exp.memorySlug(42, "I like tea"), "42-i-like-tea.json");
});

test("slug: filesystem-illegal stripped, not replaced with junk", () => {
  assert.strictEqual(exp.memorySlug(1, 'hello<>:"/\\|?*world'), "1-helloworld.json");
});

test("slug: reserved CON/PRN/NUL/COM1-9/LPT1-9/empty → <id>.json (no hash)", () => {
  assert.strictEqual(exp.memorySlug(7, "CON"), "7.json");
  assert.strictEqual(exp.memorySlug(7, "prn"), "7.json");
  assert.strictEqual(exp.memorySlug(7, "NUL"), "7.json");
  assert.strictEqual(exp.memorySlug(7, "COM1"), "7.json");
  assert.strictEqual(exp.memorySlug(7, "LPT9"), "7.json");
  assert.strictEqual(exp.memorySlug(7, ""), "7.json");
  assert.strictEqual(exp.memorySlug(7, "???"), "7.json", "illegal-only collapses to empty");
  assert.strictEqual(exp.memorySlug(7, "COM10"), "7-com10.json", "COM10 is not reserved");
});

test("slug: trailing dots/spaces stripped", () => {
  assert.strictEqual(exp.memorySlug(3, "hello..."), "3-hello.json");
  assert.strictEqual(exp.memorySlug(3, "hello   "), "3-hello.json");
});

test("slug: cap ~40 at the last hyphen (whole words, no hash suffix)", () => {
  const long = "this-is-a-very-long-memory-about-something-important-indeed";
  const s = exp.memorySlug(9, long);
  assert.ok(s.startsWith("9-"));
  assert.ok(s.endsWith(".json"));
  const body = s.slice(2, -5);
  assert.ok(body.length <= 40, "slug body capped, got " + body.length + " " + body);
  assert.ok(!/-$/.test(body));
  assert.ok(!/hash|sha|md5/i.test(s), "no hash suffix");
});

test("slug: DON'T ASCII-fold CJK — empty-fold is the payload failure", () => {
  assert.strictEqual(exp.memorySlug(11, "记忆测试"), "11-记忆测试.json");
  assert.strictEqual(exp.memorySlug(12, "café notes"), "12-café-notes.json");
});

test("folder path is f(created) UTC day-granular, zero-padded", () => {
  assert.strictEqual(exp.memoryDayPath("2026-03-05T12:34:56.000Z"), "memories/2026/03/05");
  assert.strictEqual(exp.memoryDayPath("2019-01-09T00:00:00.000Z"), "memories/2019/01/09");
  assert.notStrictEqual(exp.memoryDayPath("2026-03-05T12:34:56.000Z"), "memories/2026/3/5");
});

test("catalog columns: id status created path bytes text", () => {
  const rec = normalize({
    id: 5, text: "I prefer tea in the morning with honey",
    created: "2026-01-02T00:00:00.000Z", deleted: true,
  });
  const line = exp.catalogLine(rec, "root/memories/2026/01/02/5-i-prefer-tea.json", 123);
  const cols = line.replace(/\n$/, "").split("\t");
  assert.deepStrictEqual(exp.catalogHeader().replace(/\n$/, "").split("\t"),
    ["id", "status", "created", "path", "bytes", "text"]);
  assert.strictEqual(cols[0], "5");
  assert.strictEqual(cols[1], "deleted");
  assert.strictEqual(cols[2], "2026-01-02T00:00:00.000Z");
  assert.strictEqual(cols[3], "root/memories/2026/01/02/5-i-prefer-tea.json");
  assert.strictEqual(cols[4], "123");
  assert.ok(cols[5].indexOf("I prefer tea") === 0);
  assert.ok(cols[5].length <= 80);
});

test("recordStatus: deleted wins; superseded via valid_to or superseded_by", () => {
  assert.strictEqual(exp.recordStatus({ deleted: true, valid_to: "x" }), "deleted");
  assert.strictEqual(exp.recordStatus({ superseded_by: 2 }), "superseded");
  assert.strictEqual(exp.recordStatus({ valid_to: "2026-01-01T00:00:00Z" }), "superseded");
  assert.strictEqual(exp.recordStatus({ text: "hi" }), "current");
});

test("sanitizeExportName / never-overwrite Name (2).zip", () => {
  assert.strictEqual(exp.sanitizeExportName("foo/bar<>.zip", "fb"), "foo-bar");
  const dir = tmp("export-unique");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Name.zip"), "x");
  const p2 = exp.uniqueZipPath(dir, "Name");
  assert.strictEqual(path.basename(p2), "Name (2).zip");
  fs.writeFileSync(p2, "y");
  const p3 = exp.uniqueZipPath(dir, "Name");
  assert.strictEqual(path.basename(p3), "Name (3).zip");
});

test("human JSON omits embedding; jsonl line keeps embedding as a JSON array", () => {
  const rec = {
    id: 1, text: "hi", created: "2026-01-01T00:00:00.000Z",
    embedding: Float32Array.from([0.1, 0.2, 0.3]),
  };
  const human = JSON.parse(exp.recordToHumanJson(rec));
  assert.strictEqual("embedding" in human, false);
  const line = JSON.parse(exp.recordToJsonlLine(rec));
  assert.ok(Array.isArray(line.embedding));
  assert.strictEqual(line.embedding.length, 3);
});

test("zip writer: STORE + DEFLATE round-trip, CRC, UTF-8 flag, ZIP64 always", () => {
  const zpath = tmp("tiny.zip");
  const w = new ZipWriter(zpath);
  w.addStored("root/hello.txt", "hello store\n");
  w.addDeflated("root/café.txt", "deflated payload " + "x".repeat(200));
  const fin = w.finalize();
  assert.ok(fs.existsSync(zpath), "renamed off .tmp");
  assert.ok(!fs.existsSync(zpath + ".tmp"), "tmp gone after EOCD rename");
  assert.strictEqual(fin.entries, 2);
  assert.ok(hasZip64Eocd(zpath), "ZIP64 EOCD+locator even at 2 entries — no classic-only path");
  const r = ZipReader.open(zpath);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.readStored("root/hello.txt").toString("utf8"), "hello store\n");
  assert.strictEqual(r.readStored("root/café.txt").toString("utf8"), "deflated payload " + "x".repeat(200));
  const cafe = r.get("root/café.txt");
  assert.ok(cafe.utf8, "UTF-8 flag set so CJK/accents survive");
  assert.strictEqual(cafe.flag & FLAG_UTF8, FLAG_UTF8);
  assert.strictEqual(cafe.crc, crcOf(Buffer.from("deflated payload " + "x".repeat(200))) >>> 0);
  assert.ok(cafe.usize < U16_MAX, "this member is small; ZIP64 is still used for the archive");
});

test("zip writer: killed-looking abort leaves no dest zip", () => {
  const zpath = tmp("aborted.zip");
  const w = new ZipWriter(zpath);
  w.addStored("a.txt", "aa");
  assert.ok(fs.existsSync(zpath + ".tmp"));
  w.abort();
  assert.ok(!fs.existsSync(zpath), "dest was never renamed");
  assert.ok(!fs.existsSync(zpath + ".tmp"), "abort unlinks tmp");
});

test("README + manifest layout field", () => {
  const readme = exp.buildReadme();
  assert.ok(/you own/i.test(readme));
  assert.ok(/diary/i.test(readme));
  assert.ok(/do not sanitize/i.test(readme));
  assert.ok(/memories\.jsonl/.test(readme));
  assert.ok(/catalog\.txt/.test(readme));
  assert.ok(/MAX_PATH/.test(readme));
  const man = JSON.parse(exp.buildManifest({
    exportedAt: "2026-09-05T00:00:00.000Z",
    name: "resonance-memories-2026-09-05",
    count: { total: 3, current: 1, superseded: 1, deleted: 1 },
  }));
  assert.strictEqual(man.layout, "memories/YYYY/MM/DD");
  assert.strictEqual(man.schema_version, 1);
});

// ------------------------------------------------ edit() embedding safety
// An embedder outage is transient; losing an embedding is not.
// createCore already required above (warm-field section)

async function asyncTests() {
  // ------------------------------------------------- RM-07 slice 2a migrator
  section("JSONL→SQLite migrator (RM-07 slice 2a, 10-step protocol)");

  if (!sqliteAvailable()) {
    await atest("JSONL→SQLite migrator SKIPPED (node:sqlite not in this Node)", async () => {
      assert.ok(true);
    });
  } else {
    const { migrateJsonlToSqlite } = require("./migrate-sqlite.js");

    function writeJsonlFixture(file, recs, extra) {
      extra = extra || {};
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const lines = recs.map((r) => JSON.stringify(r));
      if (extra.blankLines) lines.push("", "   ");
      fs.writeFileSync(file, lines.join("\n") + "\n");
      if (extra.access) {
        fs.writeFileSync(file + ".access.json", JSON.stringify({ counts: extra.access }));
      }
      return file;
    }

    function migrateFixture(name) {
      const dir = tmp("mig-" + name + "-" + Math.random().toString(36).slice(2));
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, "mem.jsonl");
    }

    const FIXTURE_RECS = [
      {
        id: 1700000000001,
        text: "I work at Acme",
        created: "2020-06-15T12:34:56.000Z",
        modified: "2020-06-15T12:34:56.000Z",
        embedding: [1, 0, 0.25],
        access_count: 2,
        source: "user_stated",
        embedding_version: 1,
      },
      {
        id: 1700000000002,
        text: "I used to work at Globex",
        created: "2019-01-01T00:00:00.000Z",
        modified: "2019-01-01T00:00:00.000Z",
        embedding: [0, 1, 0],
        valid_from: "2019-01-01T00:00:00.000Z",
        valid_to: "2020-06-15T12:34:56.000Z",
        superseded_by: 1700000000001,
        last_access: "2020-01-01T00:00:00.000Z",
      },
      {
        id: 7,
        text: "no vector here",
        created: "2021-03-03T03:03:03.000Z",
        modified: "2021-03-03T03:03:03.000Z",
      },
      {
        id: 8,
        text: "soft deleted",
        created: "2021-04-04T04:04:04.000Z",
        modified: "2021-04-04T04:04:04.000Z",
        deleted: true,
        embedding: [0, 0, 1],
      },
    ];
    const FIXTURE_ACCESS = {
      "1700000000001": { n: 3, last: "2026-09-01T00:00:00.000Z" },
      "7": { n: 1, last: "2026-09-02T00:00:00.000Z" },
    };

    await atest("10-step happy path: lossless, ids, access-fold-once, created, JSONL→.bak", async () => {
      const jsonl = migrateFixture("happy");
      writeJsonlFixture(jsonl, FIXTURE_RECS, { blankLines: true, access: FIXTURE_ACCESS });
      const logs = [];
      const result = await migrateJsonlToSqlite(jsonl, { log: (m) => logs.push(m) });
      assert.strictEqual(result.status, "migrated");
      assert.strictEqual(result.count, 4, "blank lines are not rows");
      const dbPath = sqlitePathFor(jsonl);
      assert.ok(fs.existsSync(dbPath), ".db at the live path");
      assert.ok(!fs.existsSync(jsonl), "JSONL renamed off MEMORY_FILE_PATH");
      assert.ok(fs.existsSync(jsonl + ".bak"), "recovery snapshot at .bak");
      assert.ok(!fs.existsSync(jsonl + ".access.json"), "live access sidecar is gone");
      assert.ok(fs.existsSync(jsonl + ".access.json.bak"), "access sidecar bak'd");
      assert.ok(!fs.existsSync(dbPath + ".migrating"), "temp gone after rename");
      assert.ok(logs.some((m) => /migrated 4 memories; original kept at /.test(m)));

      const s = new SqliteStore(dbPath);
      const all = s.all();
      assert.strictEqual(all.length, 4);
      const byId = new Map(all.map((r) => [String(r.id), r]));

      const a = byId.get("1700000000001");
      assert.strictEqual(Number(a.id), 1700000000001, "opaque id preserved (not AUTOINCREMENT 1)");
      assert.strictEqual(a.created, "2020-06-15T12:34:56.000Z", "created preserved (not now())");
      assert.strictEqual(a.text, "I work at Acme");
      assert.strictEqual(a.access_count, 5, "in-row 2 + sidecar 3, folded ONCE");
      assert.strictEqual(a.last_access, "2026-09-01T00:00:00.000Z");
      assert.strictEqual(a.importance, 5, "AccessLog.apply sets importance = folded count");
      assert.ok(embClose(a.embedding, [1, 0, 0.25]));

      const b = byId.get("1700000000002");
      assert.strictEqual(String(b.superseded_by), "1700000000001", "superseded_by preserved");
      assert.strictEqual(b.created, "2019-01-01T00:00:00.000Z");
      assert.strictEqual(b.valid_to, "2020-06-15T12:34:56.000Z");
      assert.strictEqual(b.access_count, 0, "no sidecar entry, in-row stays 0");

      const c = byId.get("7");
      assert.strictEqual(Number(c.id), 7, "small explicit id is not reassigned");
      assert.strictEqual(c.created, "2021-03-03T03:03:03.000Z");
      assert.strictEqual(c.embedding, null, "vectorless stays vectorless — do not invent");
      assert.strictEqual(c.access_count, 1, "sidecar-only count folded");

      const d = byId.get("8");
      assert.strictEqual(d.deleted, true);
      assert.ok(embClose(d.embedding, [0, 0, 1]));

      assert.strictEqual(s.current().length, 2, "superseded + deleted excluded from current()");
      // BUG-007: leftover bak sidecar must not fold again on read.
      assert.strictEqual(s.get(1700000000001).access_count, 5, "SqliteStore does not re-fold .bak sidecar");
      s.close();
    });

    await atest("vectorless row migrates vectorless (do not invent a blob)", async () => {
      const jsonl = migrateFixture("vectorless");
      writeJsonlFixture(jsonl, [{
        id: 42, text: "bare fact", created: "2018-08-08T08:08:08.000Z",
      }]);
      await migrateJsonlToSqlite(jsonl, { log() {} });
      const s = new SqliteStore(sqlitePathFor(jsonl));
      const r = s.get(42);
      assert.strictEqual(r.embedding, null);
      assert.strictEqual(r.created, "2018-08-08T08:08:08.000Z");
      assert.strictEqual(s.embeddingRowCount(), 0);
      s.close();
    });

    await atest("count-mismatch aborts non-destructively (JSONL live, no half .db)", async () => {
      const jsonl = migrateFixture("mismatch");
      writeJsonlFixture(jsonl, [
        { id: 1, text: "a", created: "2020-01-01T00:00:00.000Z", embedding: [1, 0] },
        { id: 2, text: "b", created: "2020-01-01T00:00:00.000Z", embedding: [0, 1] },
      ]);
      const before = fs.readFileSync(jsonl, "utf8");
      let threw = null;
      try {
        await migrateJsonlToSqlite(jsonl, {
          log() {},
          onAfterIngest(store) {
            store.db.exec("DELETE FROM memories WHERE id = 1");
          },
        });
      } catch (e) { threw = e; }
      assert.ok(threw, "must abort");
      assert.strictEqual(threw.code, "MIGRATE_COUNT_MISMATCH");
      assert.strictEqual(fs.readFileSync(jsonl, "utf8"), before, "JSONL still live, bytes unchanged");
      const dbPath = sqlitePathFor(jsonl);
      assert.ok(!fs.existsSync(dbPath), "no half .db at the live path");
      assert.ok(!fs.existsSync(dbPath + ".migrating"), "temp deleted on abort");
    });

    await atest("in-process crash-before-rename leaves JSONL live + no half db", async () => {
      const jsonl = migrateFixture("crash-throw");
      writeJsonlFixture(jsonl, [
        { id: 9, text: "keep me", created: "2017-07-07T07:07:07.000Z", embedding: [1, 1] },
      ]);
      const before = fs.readFileSync(jsonl, "utf8");
      let threw = null;
      try {
        await migrateJsonlToSqlite(jsonl, {
          log() {},
          async onBeforeRename() { throw new Error("simulated crash before step 7"); },
        });
      } catch (e) { threw = e; }
      assert.ok(threw);
      assert.ok(/simulated crash/.test(threw.message));
      assert.strictEqual(fs.readFileSync(jsonl, "utf8"), before);
      const dbPath = sqlitePathFor(jsonl);
      assert.ok(!fs.existsSync(dbPath), "no .db at MEMORY_FILE_PATH");
      assert.ok(!fs.existsSync(dbPath + ".migrating"), "temp cleaned on in-process throw");
    });

    await atest("kill-9 before step 7: JSONL live, no half .db, re-run completes", async () => {
      const { spawn } = require("child_process");
      const jsonl = migrateFixture("kill9");
      writeJsonlFixture(jsonl, FIXTURE_RECS, { access: FIXTURE_ACCESS });
      const before = fs.readFileSync(jsonl, "utf8");
      const ready = jsonl + ".ready";
      const child = spawn(process.execPath, [path.join(__dirname, "migrate-sqlite.js"), jsonl], {
        env: Object.assign({}, process.env, {
          RM_MIGRATE_CRASH_BEFORE_RENAME: "1",
          RM_MIGRATE_CRASH_READY: ready,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const t0 = Date.now();
      while (!fs.existsSync(ready)) {
        if (Date.now() - t0 > 15000) {
          try { child.kill("SIGKILL"); } catch { /* */ }
          throw new Error("kill-9 child never wrote ready file: " + (child.stderr && child.stderr.read()));
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      child.kill("SIGKILL");
      await new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode) return resolve();
        child.on("exit", resolve);
        setTimeout(resolve, 5000);
      });
      assert.ok(fs.existsSync(jsonl), "JSONL still at its path after kill-9");
      assert.strictEqual(fs.readFileSync(jsonl, "utf8"), before, "JSONL bytes unchanged");
      const dbPath = sqlitePathFor(jsonl);
      assert.ok(!fs.existsSync(dbPath), "no half .db sits at MEMORY_FILE_PATH");
      // Leftover .db.migrating is allowed (finally did not run). Re-run must
      // drop it (no resume-from-partial) and complete.
      const result = await migrateJsonlToSqlite(jsonl, { log() {} });
      assert.strictEqual(result.status, "migrated");
      assert.strictEqual(result.count, 4);
      assert.ok(fs.existsSync(dbPath));
      assert.ok(!fs.existsSync(jsonl), "JSONL now at .bak");
      assert.ok(fs.existsSync(jsonl + ".bak"));
      assert.ok(!fs.existsSync(dbPath + ".migrating"));
      const s = new SqliteStore(dbPath);
      assert.strictEqual(s.get(1700000000001).access_count, 5);
      assert.strictEqual(s.get(7).embedding, null);
      assert.strictEqual(s.get(1700000000001).created, "2020-06-15T12:34:56.000Z");
      s.close();
    });

    await atest("second run on an already-migrated store is a no-op (ignore leftover JSONL)", async () => {
      const jsonl = migrateFixture("noop");
      writeJsonlFixture(jsonl, [
        { id: 1, text: "original", created: "2020-01-01T00:00:00.000Z", embedding: [1, 0] },
      ]);
      const first = await migrateJsonlToSqlite(jsonl, { log() {} });
      assert.strictEqual(first.status, "migrated");
      const dbPath = sqlitePathFor(jsonl);
      const s1 = new SqliteStore(dbPath);
      assert.strictEqual(s1.get(1).text, "original");
      s1.close();
      // A leftover JSONL at the original path must NOT be dual-read or re-ingested.
      writeJsonlFixture(jsonl, [
        { id: 99, text: "stale leftover — must be ignored", created: "2026-01-01T00:00:00.000Z" },
      ]);
      const logs = [];
      const second = await migrateJsonlToSqlite(jsonl, { log: (m) => logs.push(m) });
      assert.strictEqual(second.status, "already_migrated");
      assert.strictEqual(second.ignoredJsonl, true);
      assert.ok(logs.some((m) => /leftover JSONL ignored/.test(m)));
      assert.ok(fs.existsSync(jsonl), "leftover JSONL is ignored, not consumed");
      const s2 = new SqliteStore(dbPath);
      assert.strictEqual(s2.all().length, 1, "db not re-ingested");
      assert.strictEqual(s2.get(1).text, "original");
      assert.strictEqual(s2.get(99), null, "leftover JSONL rows did not land");
      s2.close();
    });

    await atest("empty .db beside a live JSONL is refused (openStore footgun), JSONL kept", async () => {
      const jsonl = migrateFixture("empty-db");
      writeJsonlFixture(jsonl, [
        { id: 3, text: "do not lose me", created: "2016-06-06T06:06:06.000Z" },
      ]);
      const dbPath = sqlitePathFor(jsonl);
      const empty = new SqliteStore(dbPath);
      assert.strictEqual(empty.rowCount(), 0);
      empty.close();
      const before = fs.readFileSync(jsonl, "utf8");
      let threw = null;
      try { await migrateJsonlToSqlite(jsonl, { log() {} }); }
      catch (e) { threw = e; }
      assert.ok(threw);
      assert.strictEqual(threw.code, "MIGRATE_EMPTY_DB");
      assert.strictEqual(fs.readFileSync(jsonl, "utf8"), before, "JSONL still live");
    });

    await atest("CLI --migrate (entry.js) runs the protocol; not a fifth verb", async () => {
      const { spawnSync } = require("child_process");
      const jsonl = migrateFixture("cli");
      writeJsonlFixture(jsonl, [
        { id: 11, text: "cli fact", created: "2022-02-02T02:02:02.000Z", embedding: [0.5, 0.5] },
      ]);
      const entry = path.join(__dirname, "entry.js");
      const env = Object.assign({}, process.env);
      delete env.RM_MIGRATE_CRASH_BEFORE_RENAME;
      delete env.RM_MIGRATE_CRASH_READY;
      const ran = spawnSync(process.execPath, [entry, "--migrate", "--json", jsonl], {
        encoding: "utf8", timeout: 20000, env,
      });
      assert.strictEqual(ran.status, 0, "cli exit: " + (ran.stderr || ran.stdout));
      const out = JSON.parse(ran.stdout);
      assert.strictEqual(out.status, "migrated");
      assert.strictEqual(out.count, 1);
      assert.ok(fs.existsSync(sqlitePathFor(jsonl)));
      assert.ok(fs.existsSync(jsonl + ".bak"));
      assert.ok(!fs.existsSync(jsonl));
    });

    await atest("unparseable non-blank line aborts; JSONL live", async () => {
      const jsonl = migrateFixture("badline");
      fs.mkdirSync(path.dirname(jsonl), { recursive: true });
      fs.writeFileSync(jsonl, JSON.stringify({
        id: 1, text: "ok", created: "2020-01-01T00:00:00.000Z",
      }) + "\nthis is not json\n");
      let threw = null;
      try { await migrateJsonlToSqlite(jsonl, { log() {} }); }
      catch (e) { threw = e; }
      assert.ok(threw);
      assert.strictEqual(threw.code, "MIGRATE_PARSE");
      assert.ok(fs.existsSync(jsonl), "JSONL still live");
      assert.ok(!fs.existsSync(sqlitePathFor(jsonl)));
    });
  }

  section("RM-07 slice 2b — export bundle (read-only, golden-safe)");

  {
    const { spawn, spawnSync } = require("child_process");
    const { JsonlStore } = require("./store.js");

    function stamp(p) {
      if (!p || !fs.existsSync(p)) return null;
      const st = fs.statSync(p);
      const buf = fs.readFileSync(p);
      return st.size + ":" + st.mtimeMs + ":" + require("crypto").createHash("sha256").update(buf).digest("hex");
    }
    function storeStamp(file) {
      return {
        store: stamp(file),
        edges: stamp(file + ".edges.json"),
        access: stamp(file + ".access.json"),
        db: stamp(file.replace(/\.jsonl$/i, ".db")),
        wal: stamp(file.replace(/\.jsonl$/i, ".db-wal")),
      };
    }

    function seedExportStore(name) {
      const file = tmp("export-" + name + ".jsonl");
      const store = new JsonlStore(file);
      store.add(normalize({
        id: 1, text: "I prefer tea", created: "2026-03-05T12:00:00.000Z",
        embedding: [0.1, 0.2, 0.3],
      }));
      store.add(normalize({
        id: 2, text: "I used to prefer coffee", created: "2026-03-05T13:00:00.000Z",
        embedding: [0.2, 0.1, 0.3], superseded_by: 1, valid_to: "2026-03-05T12:00:00.000Z",
      }));
      store.add(normalize({
        id: 3, text: "old secret I deleted", created: "2026-01-09T00:00:00.000Z",
        embedding: [0.0, 0.1, 0.0], deleted: true,
      }));
      store.add(normalize({
        id: 4, text: "记忆测试", created: "2026-03-05T14:00:00.000Z",
        embedding: [0.4, 0.1, 0.1],
      }));
      store.add(normalize({
        id: 5, text: "CON", created: "2026-03-05T15:00:00.000Z",
        embedding: [0.5, 0.1, 0.1],
      }));
      const { EdgeStore, makeEdge } = require("./edges.js");
      const E = new EdgeStore(file + ".edges.json");
      E.put(makeEdge(1, 2, { origin: "co-activation", now: "2026-03-05T12:00:00.000Z", hebbianWeight: 0.42 }));
      E.processedIds = ["rpc-should-not-export"];
      E.save();
      return { file, store };
    }

    await atest("export zip: whole store incl deleted+superseded, layout, catalog, edges, README", async () => {
      const { file } = seedExportStore("full");
      const outDir = tmp("export-out-full");
      fs.mkdirSync(outDir, { recursive: true });
      const result = await exp.runExport({
        mode: "zip", name: "bundle", outDir, storePath: file,
      });
      assert.ok(fs.existsSync(result.path));
      const z = ZipReader.open(result.path);
      const names = z.names();
      const root = "bundle";
      assert.ok(names.indexOf(root + "/README.txt") >= 0);
      assert.ok(names.indexOf(root + "/manifest.json") >= 0);
      assert.ok(names.indexOf(root + "/catalog.txt") >= 0);
      assert.ok(names.indexOf(root + "/edges.json") >= 0);
      assert.ok(names.indexOf(root + "/memories.jsonl") >= 0);
      const man = JSON.parse(z.readStored(root + "/manifest.json").toString("utf8"));
      assert.strictEqual(man.layout, "memories/YYYY/MM/DD");
      assert.strictEqual(man.count.total, 5);
      assert.strictEqual(man.count.current, 3, "tea + CJK + CON");
      assert.strictEqual(man.count.superseded, 1);
      assert.strictEqual(man.count.deleted, 1);
      const jsonl = z.readStored(root + "/memories.jsonl").toString("utf8").trim().split("\n");
      assert.strictEqual(jsonl.length, 5, "jsonl is the whole store, not current() only");
      const recs = jsonl.map((l) => JSON.parse(l));
      assert.ok(recs.some((r) => r.deleted));
      assert.ok(recs.some((r) => r.superseded_by));
      assert.ok(recs.every((r) => Array.isArray(r.embedding) || r.embedding === null));
      const teaPath = root + "/memories/2026/03/05/1-i-prefer-tea.json";
      const cjkPath = root + "/memories/2026/03/05/4-记忆测试.json";
      const reservedPath = root + "/memories/2026/03/05/5.json";
      const deletedPath = root + "/memories/2026/01/09/3-old-secret-i-deleted.json";
      assert.ok(z.has(teaPath), "day-granular created path");
      assert.ok(z.has(cjkPath), "CJK slug preserved (UTF-8 flag)");
      assert.ok(z.has(reservedPath), "CON → <id>.json");
      assert.ok(z.has(deletedPath), "deleted memory still has a human file");
      const human = JSON.parse(z.readStored(teaPath).toString("utf8"));
      assert.strictEqual("embedding" in human, false, "human file has no vectors");
      assert.strictEqual(human.text, "I prefer tea");
      const catalog = z.readStored(root + "/catalog.txt").toString("utf8");
      const catLines = catalog.trim().split("\n");
      assert.strictEqual(catLines[0].split("\t")[3], "path");
      for (const line of catLines.slice(1)) {
        const cols = line.split("\t");
        assert.strictEqual(cols.length, 6, "catalog columns");
        assert.ok(z.has(cols[3]), "catalog path resolves: " + cols[3]);
      }
      const edges = JSON.parse(z.readStored(root + "/edges.json").toString("utf8"));
      assert.ok(edges.edges);
      const ev = Object.values(edges.edges)[0];
      assert.ok(ev && ev.hebbian && ev.hebbian.weight > 0, "Hebbian weight carried");
      assert.strictEqual("processed_ids" in edges, false, "runtime LRU stays out");
      const readme = z.readStored(root + "/README.txt").toString("utf8");
      assert.ok(/you own/i.test(readme));
      assert.ok(hasZip64Eocd(result.path));
    });

    await atest("export mutates NOTHING (store bytes unchanged)", async () => {
      const { file } = seedExportStore("readonly");
      const before = storeStamp(file);
      const outDir = tmp("export-out-ro");
      fs.mkdirSync(outDir, { recursive: true });
      await exp.runExport({ mode: "zip", name: "ro", outDir, storePath: file });
      assert.deepStrictEqual(storeStamp(file), before);
    });

    await atest("export never overwrites an existing zip", async () => {
      const { file } = seedExportStore("ow");
      const outDir = tmp("export-out-ow");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "mine.zip"), "keep-me");
      const result = await exp.runExport({ mode: "zip", name: "mine", outDir, storePath: file });
      assert.strictEqual(path.basename(result.path), "mine (2).zip");
      assert.strictEqual(fs.readFileSync(path.join(outDir, "mine.zip"), "utf8"), "keep-me");
    });

    await atest("--export-jsonl is the raw scripting primitive (not replaced by the zip)", async () => {
      const { file } = seedExportStore("jsonl");
      const outDir = tmp("export-out-jsonl");
      fs.mkdirSync(outDir, { recursive: true });
      const result = await exp.runExport({
        mode: "jsonl", name: "raw", outFile: outDir, storePath: file,
      });
      assert.ok(result.path.endsWith(".jsonl"));
      const lines = fs.readFileSync(result.path, "utf8").trim().split("\n");
      assert.strictEqual(lines.length, 5);
      const recs = lines.map((l) => JSON.parse(l));
      assert.strictEqual(recs[0].text, "I prefer tea");
      assert.ok(Array.isArray(recs[0].embedding));
    });

    await atest("CLI --export (entry.js) is not a fifth verb; --export-jsonl stays its own flag", async () => {
      const { file } = seedExportStore("cli");
      const outDir = tmp("export-out-cli");
      fs.mkdirSync(outDir, { recursive: true });
      const entry = path.join(__dirname, "entry.js");
      const zip = spawnSync(process.execPath, [
        entry, "--export", "--json", "--name", "cli-bundle", "--out", outDir, file,
      ], { encoding: "utf8" });
      assert.strictEqual(zip.status, 0, zip.stderr || zip.stdout);
      const z = JSON.parse(zip.stdout);
      assert.ok(z.path && fs.existsSync(z.path));
      assert.strictEqual(z.count.total, 5);
      const raw = spawnSync(process.execPath, [
        entry, "--export-jsonl", "--json", "--name", "cli-raw", "--out", outDir, file,
      ], { encoding: "utf8" });
      assert.strictEqual(raw.status, 0, raw.stderr || raw.stdout);
      const j = JSON.parse(raw.stdout);
      assert.ok(j.path.endsWith(".jsonl"));
      assert.strictEqual(j.count, 5);
    });

    await atest("killed export leaves .zip.tmp, never a valid-looking truncated zip", async () => {
      const { file } = seedExportStore("kill");
      const outDir = tmp("export-out-kill");
      fs.mkdirSync(outDir, { recursive: true });
      const ready = tmp("export-kill.ready");
      const child = spawn(process.execPath, [
        path.join(__dirname, "export-memory.js"),
        "--export", "--name", "killed", "--out", outDir, file,
      ], {
        env: Object.assign({}, process.env, {
          RM_EXPORT_CRASH_AFTER: "1",
          RM_EXPORT_CRASH_READY: ready,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const t0 = Date.now();
      while (!fs.existsSync(ready)) {
        if (Date.now() - t0 > 15000) {
          try { child.kill("SIGKILL"); } catch { /* */ }
          throw new Error("export crash-child never wrote ready: " +
            String(child.stderr && child.stderr.read()));
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      child.kill("SIGKILL");
      await new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode) return resolve();
        child.on("exit", resolve);
        setTimeout(resolve, 5000);
      });
      const dest = path.join(outDir, "killed.zip");
      assert.ok(!fs.existsSync(dest), "no dest zip that looks valid");
      assert.ok(fs.existsSync(dest + ".tmp"), "leftover is the .tmp");
    });

    if (sqliteAvailable()) {
      await atest("sqlite export is read-only (no WAL checkpoint, bytes unchanged)", async () => {
        const dir = tmp("export-sqlite");
        fs.mkdirSync(dir, { recursive: true });
        const dbPath = path.join(dir, "mem.db");
        const s = new SqliteStore(dbPath);
        s.add(normalize({
          id: 1, text: "sqlite tea", created: "2026-04-01T00:00:00.000Z",
          embedding: [1, 0, 0],
        }));
        s.close();
        const before = stamp(dbPath);
        const walBefore = fs.existsSync(dbPath + "-wal") ? stamp(dbPath + "-wal") : null;
        const outDir = path.join(dir, "out");
        fs.mkdirSync(outDir, { recursive: true });
        const result = await exp.runExport({
          mode: "zip", name: "sql", outDir, storePath: dbPath,
        });
        assert.ok(fs.existsSync(result.path));
        assert.strictEqual(stamp(dbPath), before, ".db bytes unchanged");
        const z = ZipReader.open(result.path);
        assert.ok(z.has("sql/memories/2026/04/01/1-sqlite-tea.json"));
        const jsonl = z.readStored("sql/memories.jsonl").toString("utf8").trim();
        const rec = JSON.parse(jsonl);
        assert.strictEqual(rec.text, "sqlite tea");
        assert.ok(Array.isArray(rec.embedding));
        void walBefore;
      });
    }
  }

  section("eval measure runner (RM-02.a)");

  await atest("duplicates corpus: both metrics compute via pipeline.js (cached embed)", async () => {
    const { loadScenarios, runScenario } = require("./eval/measure.js");
    const scenarios = loadScenarios(path.join(__dirname, "eval", "corpora", "duplicates.jsonl"));
    const r = await runScenario(scenarios[0], { k: 5 });
    assert.ok(r.metrics.duplicate_rate >= 0 && r.metrics.duplicate_rate <= 1);
    assert.ok(r.metrics.recall_at_k >= 0 && r.metrics.recall_at_k <= 1);
    assert.ok(typeof r.metrics.mrr === "number" && r.metrics.mrr >= 0 && r.metrics.mrr <= 1,
      "mrr ships as a reporting metric (S1 registry extension)");
    assert.strictEqual(r.queries.length, scenarios[0].queries.length);
    assert.ok(r.queries.every((q) => Array.isArray(q.ranked_ids)), "each query has ranked_ids from recall output");
    assert.ok(r.exact_restatements_caught >= 1,
      "byte-identical coffee-order pair is confirmed, not appended");
    assert.ok(r.n_stored_current >= 1 && r.n_stored_current <= r.n_writes);
    assert.ok(r.queries.every((q) => q.relevant_ids.length >= 1),
      "every query resolved to a stored id via group text (merge must keep an original text)");
    assert.ok(r.extraction_precision == null,
      "duplicates writes have no gold_facts; extraction_precision is not a duplicates number");
  });

  await atest("messy-hard corpus: Tier 0 baseline is low (cached embed, no LLM)", async () => {
    const { loadScenarios, runScenario } = require("./eval/measure.js");
    const scenarios = loadScenarios(path.join(__dirname, "eval", "corpora", "messy-hard.jsonl"));
    const r = await runScenario(scenarios[0], { k: 5 });
    assert.ok(r.extraction_precision, "messy-hard writes are labeled");
    assert.strictEqual(scenarios[0].extract_match, "cover");
    assert.strictEqual(r.extraction_recall.rate, 0, "Tier 0 cannot recover implicit gold");
    assert.strictEqual(r.extraction_precision.n_correct, 0, "narrative blobs are not atomic facts");
    assert.strictEqual(r.metrics.recall_at_k, 0, "facts_only relevant ids miss on the blob");
  });

  await atest("messy corpus: extraction_precision via pipeline.js (current save, cached embed)", async () => {
    const { loadScenarios, runScenario } = require("./eval/measure.js");
    const scenarios = loadScenarios(path.join(__dirname, "eval", "corpora", "messy.jsonl"));
    const r = await runScenario(scenarios[0], { k: 5 });
    assert.ok(r.extraction_precision, "messy writes are labeled");
    assert.ok(r.metrics.extraction_precision >= 0 && r.metrics.extraction_precision <= 1);
    assert.ok(r.metrics.duplicate_rate >= 0 && r.metrics.duplicate_rate <= 1);
    assert.ok(r.metrics.recall_at_k >= 0 && r.metrics.recall_at_k <= 1);
    assert.strictEqual(r.queries.length, scenarios[0].queries.length);
    const expl = r.extraction_precision;
    assert.strictEqual(expl.n_labeled, scenarios[0].writes.length);
    assert.strictEqual(expl.n_correct, expl.n_stored, "Tier 0/1 stores only gold facts");
    assert.ok(expl.rate >= 0.9, "pre-declared RM-01.b bar: extraction_precision ≥ 0.9");
    assert.strictEqual(expl.pii_refusal_rate, 1, "every PII write refused");
    assert.strictEqual(expl.n_pii_refused, expl.n_pii);
    assert.ok(r.extraction_recall, "extraction_recall is the anti-cheat");
    assert.strictEqual(r.extraction_recall.rate, 1, "every gold fact has a matching stored record");
    assert.strictEqual(r.metrics.recall_at_k, 1, "recall@5 must not drop");
    assert.ok(r.queries.every((q) => Array.isArray(q.ranked_ids) && q.ranked_ids.length >= 1),
      "each messy query resolved to a stored origin id");
  });

  section("S1 substrate scale (generator → real recall path)");

  await atest("plant 3 needles in 100 distractors: real recall finds them (synthetic geometry)", async () => {
    // Plumbing, not the live embedder: needle ≡ query axis, hard
    // distractors mix 0.65/0.35, haystack is random. The live 1k→50k
    // curve is eval/substrate/scale.js.
    const { createMemory } = require("./eval/pipeline.js");
    const ids = ["allergy-penicillin", "height-bookshelf", "job-globex"];
    const corpus = generateScaleCorpus({ n: 100, seed: 1, needleIds: ids });
    attachSyntheticEmbeddings(corpus, 16, 1);
    const file = tmp("s1-e2e.jsonl");
    const store = new JsonlStore(file);
    for (const rec of corpus.records) {
      store.add(normalize({
        id: rec.id, text: rec.text, embedding: rec.embedding,
        created: "2026-01-01T00:00:00Z",
      }));
    }
    const qv = new Map(corpus.queries.map((q) => [q.query, q.embedding]));
    const mem = createMemory({
      store,
      embed: async (texts) => texts.map((t) => {
        const v = qv.get(t);
        if (!v) throw new Error("unexpected embed: " + t);
        return v;
      }),
      fieldEnabled: false,
    });
    const ranked = [];
    for (const q of corpus.queries) {
      const out = await mem.recall(q.query, 10);
      const hits = parsePrimaryHits(out);
      assert.ok(hits.length >= 1, q.id + " empty recall");
      const top5 = hits.slice(0, 5).map((h) => String(h.id));
      assert.ok(top5.includes(String(q.relevant_ids[0])),
        q.id + " needle not in top-5: " + hits.map((h) => h.id + " " + h.text).join(" | "));
      assert.strictEqual(String(hits[0].id), String(q.relevant_ids[0]),
        q.id + " synthetic geometry should put the needle at rank 1, got " + hits[0].text);
      ranked.push({
        id: q.id,
        ranked_ids: hits.map((h) => String(h.id)),
        relevant_ids: q.relevant_ids,
      });
    }
    assert.strictEqual(computeMetric("recall_at_k", { queries: ranked }, null, { k: 1 }), 1);
    assert.strictEqual(computeMetric("mrr", { queries: ranked }, null), 1);
  });

  if (sqliteAvailable()) {
    section("Store conformance through createCore (JsonlStore ≡ SqliteStore)");

    const confEmbedBank = {
      "I work at Acme": [1, 0, 0, 0],
      "I prefer tea": [0, 1, 0, 0],
      "I'm allergic to peanuts": [0, 0, 1, 0],
      "where do I work": [0.95, 0.05, 0, 0],
      "what do I drink": [0.05, 0.95, 0, 0],
      // Same-slot correction at ~0.60 cosine to Acme: above RM-03 floor
      // (0.535) and below DEDUP_LO (0.88) so it supersedes rather than
      // restates. Mass on dim 4 so it does not argmax onto tea.
      "Actually I work at Globex now": [0.60, 0.05, 0.05, 0.797],
      "I work at Globex": [0.60, 0.05, 0.05, 0.797],
    };
    const confEmbed = async (texts) => texts.map((t) => {
      if (confEmbedBank[t]) return confEmbedBank[t].slice();
      const v = new Array(4).fill(0);
      v[t.length % 4] = 1;
      return v;
    });

    function seedPair(suffix) {
      const created = "2026-01-01T00:00:00.000Z";
      const jsonl = new JsonlStore(tmp("conf-core-" + suffix + ".jsonl"));
      const sqlite = freshSqlite("conf-core-" + suffix);
      const recs = [
        normalize({ id: 11, text: "I work at Acme", embedding: [1, 0, 0, 0], created }),
        normalize({ id: 12, text: "I prefer tea", embedding: [0, 1, 0, 0], created }),
        normalize({ id: 13, text: "I'm allergic to peanuts", embedding: [0, 0, 1, 0], created }),
      ];
      for (const r of recs) { jsonl.add(r); sqlite.add(r); }
      const jCore = createCore({ store: jsonl, embed: confEmbed });
      const sCore = createCore({ store: sqlite, embed: confEmbed });
      return { jsonl, sqlite, jCore, sCore };
    }

    await atest("recall ranking/ids are identical on both backends", async () => {
      const { sqlite, jCore, sCore } = seedPair("recall");
      const jq = await jCore.recall("where do I work", 3);
      const sq = await sCore.recall("where do I work", 3);
      const jHits = parsePrimaryHits(jq).map((h) => String(h.id));
      const sHits = parsePrimaryHits(sq).map((h) => String(h.id));
      assert.deepStrictEqual(sHits, jHits, "same id order\n jsonl=" + jHits + "\n sqlite=" + sHits);
      assert.strictEqual(sHits[0], "11", "Acme is rank-1 for 'where do I work'");
      sqlite.close();
    });

    await atest("save restatement / supersession / edit / delete match", async () => {
      const { jsonl, sqlite, jCore, sCore } = seedPair("verbs");
      // HI restatement of tea: confirm, do not append.
      await jCore.save("I prefer tea");
      await sCore.save("I prefer tea");
      assert.strictEqual(jsonl.current().length, sqlite.current().length, "restatement did not append");
      assert.strictEqual(jsonl.get(12).access_count, sqlite.get(12).access_count);

      // Cue-gated supersession of the job.
      await jCore.save("Actually I work at Globex now");
      await sCore.save("Actually I work at Globex now");
      const jCur = jsonl.current().map((r) => r.text).sort();
      const sCur = sqlite.current().map((r) => r.text).sort();
      assert.deepStrictEqual(sCur, jCur, "current texts after supersession");
      const jOld = jsonl.get(11), sOld = sqlite.get(11);
      assert.ok(jOld.valid_to && sOld.valid_to, "old job retired on both");
      assert.ok(jOld.superseded_by != null && sOld.superseded_by != null, "superseded_by set");

      const jNew = jsonl.current().find((r) => /Globex/.test(r.text));
      const sNew = sqlite.current().find((r) => /Globex/.test(r.text));
      assert.ok(jNew && sNew, "Globex is current");

      await jCore.edit(jNew.id, "I work at Globex");
      await sCore.edit(sNew.id, "I work at Globex");
      assert.strictEqual(jsonl.get(jNew.id).text, sqlite.get(sNew.id).text);

      await jCore.remove(13);
      await sCore.remove(13);
      assert.strictEqual(jsonl.get(13).deleted, true);
      assert.strictEqual(sqlite.get(13).deleted, true);
      assert.strictEqual(jsonl.vacuum(), sqlite.vacuum());
      assert.strictEqual(jsonl.all().length, sqlite.all().length);
      sqlite.close();
    });

    section("RM-00 golden parity (JsonlStore ≡ SqliteStore)");

    const {
      parseStoreKind, run: runEval, key: evalKey,
    } = require("./eval/run.js");

    test("parseStoreKind: --store sqlite / env, flag wins, unknown throws", () => {
      const prev = process.env.RESONANCE_STORE;
      try {
        delete process.env.RESONANCE_STORE;
        assert.strictEqual(parseStoreKind([]), "jsonl");
        assert.strictEqual(parseStoreKind(["--store", "sqlite"]), "sqlite");
        assert.strictEqual(parseStoreKind(["--store=sqlite"]), "sqlite");
        assert.strictEqual(parseStoreKind(["--store", "jsonl"]), "jsonl");
        process.env.RESONANCE_STORE = "sqlite";
        assert.strictEqual(parseStoreKind([]), "sqlite", "env fallback");
        assert.strictEqual(parseStoreKind(["--store", "jsonl"]), "jsonl", "flag wins over env");
        assert.throws(() => parseStoreKind(["--store", "mysql"]), /unknown --store/);
      } finally {
        if (prev === undefined) delete process.env.RESONANCE_STORE;
        else process.env.RESONANCE_STORE = prev;
      }
    });

    // Full golden, both backends, same memory-core. 31 checks, cached
    // embedder, a couple of seconds — cheaper than a fake mini-corpus
    // that could miss a k=5 near-tie. Any pass/fail flip is a STOP.
    await atest("golden scorecard is identical on JsonlStore and SqliteStore", async () => {
      const jsonl = await runEval({ storeKind: "jsonl" });
      const sqlite = await runEval({ storeKind: "sqlite" });
      const j = Object.fromEntries(jsonl.map((r) => [evalKey(r), r.pass]));
      const s = Object.fromEntries(sqlite.map((r) => [evalKey(r), r.pass]));
      const keys = [...new Set([...Object.keys(j), ...Object.keys(s)])];
      const flips = keys.filter((k) => j[k] !== s[k])
        .map((k) => k + " jsonl=" + j[k] + " sqlite=" + s[k]);
      assert.strictEqual(flips.length, 0, "case flips:\n  " + flips.join("\n  "));
      assert.strictEqual(jsonl.length, 31, "golden is 31 checks");
      assert.strictEqual(sqlite.length, 31);
      assert.strictEqual(
        jsonl.filter((r) => r.pass).length,
        sqlite.filter((r) => r.pass).length
      );
    });
  }

  section("RM-01.b save() wiring (Tier 0/1 on the live path)");

  function extractCore(file) {
    let embedCalls = 0;
    const seen = [];
    const store = new JsonlStore(tmp(file));
    const embed = async (texts) => {
      embedCalls += texts.length;
      // Distinct vectors per distinct string so a split's second half is
      // not a cosine-1.0 restatement of the first (the dummy [1,0] trap).
      return texts.map((t) => {
        let i = seen.indexOf(t);
        if (i < 0) { i = seen.length; seen.push(t); }
        const v = new Array(8).fill(0);
        v[i % 8] = 1;
        v[(i * 3 + 1) % 8] = 0.2;
        return v;
      });
    };
    return {
      store,
      core: createCore({ store, embed }),
      embeds: () => embedCalls,
      resetEmbeds() { embedCalls = 0; },
    };
  }

  await atest("save() strips filler and stores the inner proposition", async () => {
    const { store, core } = extractCore("rm01-filler.jsonl");
    const msg = await core.save("I think you should know that Samuel prefers concise answers");
    assert.ok(/Saved/.test(msg));
    assert.strictEqual(store.current().length, 1);
    assert.strictEqual(store.current()[0].text, "Samuel prefers concise answers");
  });

  await atest("save() splits a standalone multi-fact into two records (two embeds)", async () => {
    const { store, core, embeds, resetEmbeds } = extractCore("rm01-split.jsonl");
    resetEmbeds();
    const msg = await core.save("I have a dog named Rex and also I work as a software architect, mostly on games");
    assert.ok(/Saved 2 memories/.test(msg), msg);
    const texts = store.current().map((r) => r.text).sort();
    assert.deepStrictEqual(texts, [
      "I have a dog named Rex",
      "I work as a software architect, mostly on games",
    ].sort());
    assert.strictEqual(embeds(), 2, "a legitimate split is two embeds — the in-scope cost");
  });

  await atest("save() does not split the honey trap", async () => {
    const { store, core, embeds, resetEmbeds } = extractCore("rm01-nosplit.jsonl");
    resetEmbeds();
    await core.save("I like tea more than coffee and also with honey");
    assert.strictEqual(store.current().length, 1);
    assert.strictEqual(store.current()[0].text, "I like tea more than coffee and also with honey");
    assert.strictEqual(embeds(), 1, "no-split is one embed, same as a clean fact");
  });

  await atest("save() refuses each PII shape: stores nothing, returns a refusal", async () => {
    const payloads = [
      "my API key is sk-abcdefghijklmnopqrstuvwxyz123456",
      "password: hunter2secret",
      "my card number is 4242424242424242",
      "the AWS key is AKIAIOSFODNN7EXAMPLE",
      "keep this -----BEGIN RSA PRIVATE KEY-----",
      "my GitHub token is ghp-abcdefghijklmnopqrstuvwx",
    ];
    for (let i = 0; i < payloads.length; i++) {
      const text = payloads[i];
      const { store, core, embeds, resetEmbeds } = extractCore("rm01-pii-" + i + ".jsonl");
      resetEmbeds();
      const msg = await core.save(text);
      assert.ok(/not saved/i.test(msg), text + " → " + msg);
      assert.strictEqual(store.current().length, 0, text + " must not land in the store");
      assert.strictEqual(store.all().length, 0, text + " must not land even as superseded");
      assert.strictEqual(embeds(), 0, "refusal is string-ops only; no embed");
    }
  });

  await atest("save() digit traps and a clean control: one embed, byte-identical text", async () => {
    const { store, core, embeds, resetEmbeds } = extractCore("rm01-control.jsonl");
    resetEmbeds();
    await core.save("My name is Samuel");
    await core.save("The garage code is 4821");
    await core.save("I take 1500mg of metformin daily");
    const texts = store.current().map((r) => r.text);
    assert.deepStrictEqual(texts, [
      "My name is Samuel",
      "The garage code is 4821",
      "I take 1500mg of metformin daily",
    ]);
    assert.strictEqual(embeds(), 3, "clean facts: one embed each, no extra");
  });

  await atest("save() mixed fact+secret stores nothing (refusal, not redaction)", async () => {
    const { store, core } = extractCore("rm01-mixed.jsonl");
    const msg = await core.save("I live in Texas; my API key is sk-abcdefghijklmnopqrstuvwxyz123456");
    assert.ok(/not saved/i.test(msg));
    assert.strictEqual(store.current().length, 0);
  });

  section("RM-01.c save() wiring (Tier 2, mock LLM)");

  function tier2Core(file, extra) {
    let embedCalls = 0;
    const seen = [];
    const store = new JsonlStore(tmp(file));
    const embed = async (texts) => {
      embedCalls += texts.length;
      return texts.map((t) => {
        let i = seen.indexOf(t);
        if (i < 0) { i = seen.length; seen.push(t); }
        const v = new Array(8).fill(0);
        v[i % 8] = 1;
        v[(i * 3 + 1) % 8] = 0.2;
        return v;
      });
    };
    const sent = [];
    const opts = Object.assign({ store, embed }, extra || {});
    if (typeof opts.extract === "function") {
      const inner = opts.extract;
      opts.extract = async (text) => { sent.push(text); return inner(text); };
    }
    return { store, core: createCore(opts), embeds: () => embedCalls, sent };
  }

  await atest("toggle off: extract is never called; byte-identical to 01.b", async () => {
    let called = 0;
    const { store, core } = tier2Core("rm01c-off.jsonl", {
      extractEnabled: () => false,
      extract: async () => { called++; return { facts: ["SHOULD NOT STORE"], skip: false }; },
    });
    await core.save("I think you should know that Samuel prefers concise answers");
    assert.strictEqual(called, 0);
    assert.strictEqual(store.current()[0].text, "Samuel prefers concise answers");
  });

  await atest("toggle on + mock facts: ADD-only, those facts are what is stored", async () => {
    const { store, core, sent } = tier2Core("rm01c-on.jsonl", {
      extractEnabled: () => true,
      extract: async () => ({ facts: ["I have a green parrot named Mango", "I go to the gym at 5am"], skip: false }),
    });
    const msg = await core.save("Life at home is loud in a good way. Between the parrot (Mango, the green one) and getting up for the gym at 5am, quiet evenings are rare and I would not trade it.");
    assert.ok(/Saved 2 memories/.test(msg), msg);
    const texts = store.current().map((r) => r.text).sort();
    assert.deepStrictEqual(texts, ["I go to the gym at 5am", "I have a green parrot named Mango"]);
    assert.strictEqual(sent.length, 1, "one extraction call");
    assert.ok(!/Life at home is loud/.test(store.current().map((r) => r.text).join(" ")),
      "the narrative blob is not stored alongside the facts (extraction replaces, ADD-only vs existing memories)");
  });

  await atest("mock throws / times out / returns garbage: silent degrade to Tier 0/1", async () => {
    const src = "I think you should know that Samuel prefers concise answers";
    const { store: s1, core: c1 } = tier2Core("rm01c-throw.jsonl", {
      extractEnabled: () => true,
      extract: async () => { throw new Error("boom"); },
    });
    const m1 = await c1.save(src);
    assert.ok(/Saved/.test(m1), m1);
    assert.strictEqual(s1.current()[0].text, "Samuel prefers concise answers");

    const { store: s2, core: c2 } = tier2Core("rm01c-timeout.jsonl", {
      extractEnabled: () => true,
      extractTimeoutMs: () => 30,
      extract: () => new Promise(() => {}),
    });
    const t0 = Date.now();
    const m2 = await c2.save(src);
    assert.ok(Date.now() - t0 < 2000, "timeout must not hang save");
    assert.ok(/Saved/.test(m2), m2);
    assert.strictEqual(s2.current()[0].text, "Samuel prefers concise answers");

    const { store: s3, core: c3 } = tier2Core("rm01c-garbage.jsonl", {
      extractEnabled: () => true,
      extract: async () => ({ facts: "not-an-array", skip: false }),
    });
    await c3.save(src);
    assert.strictEqual(s3.current()[0].text, "Samuel prefers concise answers");
  });

  await atest("PII is refused BEFORE any LLM call (secret is never sent)", async () => {
    const { store, core, sent } = tier2Core("rm01c-pii.jsonl", {
      extractEnabled: () => true,
      extract: async (t) => ({ facts: ["leaked: " + t], skip: false }),
    });
    const msg = await core.save("my API key is sk-abcdefghijklmnopqrstuvwxyz123456");
    assert.ok(/not saved/i.test(msg), msg);
    assert.strictEqual(store.current().length, 0);
    assert.strictEqual(sent.length, 0, "extract must not see a secret");
  });

  await atest("capability-detect false: toggle on still no-ops (extract never called)", async () => {
    let called = 0;
    const { store, core } = tier2Core("rm01c-incapable.jsonl", {
      extractEnabled: () => true,
      extractCapable: () => false,
      extract: async () => { called++; return { facts: ["SHOULD NOT STORE"], skip: false }; },
    });
    await core.save("I think you should know that Samuel prefers concise answers");
    assert.strictEqual(called, 0);
    assert.strictEqual(store.current()[0].text, "Samuel prefers concise answers");
  });

  await atest("default createCore: Tier 2 off, no extract injector, 01.b path", async () => {
    const { store, core } = extractCore("rm01c-default.jsonl");
    await core.save("FYI, the Friday standup is at 10am");
    assert.strictEqual(store.current()[0].text, "The Friday standup is at 10am");
  });

  section("RM-02.b cosine-banded dedup at save");

  // Unit vectors: cosine([1,0], [c, sqrt(1-c²)]) = c. Lets a test dial an
  // exact band without a live embedder.
  function vecAt(cos) {
    const c = Number(cos);
    return [c, Math.sqrt(Math.max(0, 1 - c * c))];
  }
  const ORIGIN = [1, 0];

  function dedupCore(file, table, thresholds) {
    const store = new JsonlStore(tmp(file));
    const embed = async (texts) => texts.map((t) => {
      if (table[t]) return table[t].slice();
      return ORIGIN.slice();
    });
    const opts = { store, embed };
    if (thresholds) opts.dedupThresholds = () => thresholds;
    return { store, core: createCore(opts) };
  }

  await atest("HI restatement bumps last_confirmed + access_count and does NOT append", async () => {
    const table = {
      "I prefer tea over coffee": ORIGIN,
      "I like tea more than coffee": vecAt(0.9522),
    };
    const { store, core } = dedupCore("dedup-hi.jsonl", table);
    await core.save("I prefer tea over coffee");
    const id = store.current()[0].id;
    store.update(id, { last_confirmed: "2020-01-01T00:00:00.000Z", access_count: 0 });
    const msg = await core.save("I like tea more than coffee");
    assert.ok(/Already remembered/.test(msg));
    assert.strictEqual(store.current().length, 1, "HI paraphrase must not append");
    assert.strictEqual(store.active().length, 1, "and must not persist a superseded copy either");
    const rec = store.get(id);
    assert.strictEqual(rec.text, "I prefer tea over coffee", "original text kept");
    assert.notStrictEqual(rec.last_confirmed, "2020-01-01T00:00:00.000Z", "last_confirmed bumped");
    assert.strictEqual(rec.access_count, 1, "access_count bumped");
  });

  await atest("mid-band merge keeps the longer original text, sets superseded_by, unions metadata", async () => {
    const short = "I have a cat named Koneko";
    const longer = "I have a black cat named Koneko";
    const table = { [short]: ORIGIN, [longer]: vecAt(0.9435) };
    const { store, core } = dedupCore("dedup-mid.jsonl", table);
    await core.save(short);
    const oldId = store.current()[0].id;
    store.update(oldId, { is_constraint: true, access_count: 4, source: "user_stated" });
    const msg = await core.save(longer);
    assert.ok(/merged/i.test(msg), "merge is reported, not a silent restatement");
    assert.strictEqual(store.current().length, 1, "one current survivor");
    const survivor = store.current()[0];
    assert.strictEqual(survivor.text, longer, "longer original text kept (not a blend)");
    assert.notStrictEqual(survivor.id, oldId, "incoming was longer → new row is current");
    assert.strictEqual(survivor.supersedes, oldId);
    assert.strictEqual(survivor.is_constraint, true, "union: constraint flag carried onto survivor");
    assert.ok(survivor.access_count >= 5, "union: access_count inherited + confirmation bump");
    const loser = store.get(oldId);
    assert.ok(loser.valid_to, "loser is superseded, not deleted");
    assert.strictEqual(loser.superseded_by, survivor.id);
    assert.strictEqual(loser.text, short, "loser original text is recoverable");
    assert.strictEqual(store.active().length, 2, "both rows kept (I8)");
  });

  await atest("mid-band merge: existing longer text stays current, incoming is the superseded loser", async () => {
    const longer = "I work as a software architect, mostly on games";
    const short = "I work as a software architect";
    const table = { [longer]: ORIGIN, [short]: vecAt(0.9261) };
    const { store, core } = dedupCore("dedup-mid-keep.jsonl", table);
    await core.save(longer);
    const keepId = store.current()[0].id;
    await core.save(short);
    assert.strictEqual(store.current().length, 1);
    assert.strictEqual(store.current()[0].id, keepId);
    assert.strictEqual(store.current()[0].text, longer);
    const loser = store.active().find((r) => String(r.id) !== String(keepId));
    assert.ok(loser, "shorter incoming was persisted as superseded");
    assert.strictEqual(loser.text, short);
    assert.strictEqual(loser.superseded_by, keepId);
    assert.ok(loser.valid_to);
  });

  await atest("control pair (~0.69, distinct) is NOT merged", async () => {
    const dog = "I have a dog named Rex";
    const cat = "I have a cat named Whiskers";
    const table = { [dog]: ORIGIN, [cat]: vecAt(0.69) };
    const { store, core } = dedupCore("dedup-control.jsonl", table);
    await core.save(dog);
    await core.save(cat);
    assert.strictEqual(store.current().length, 2, "both current — dog/cat must not collapse");
    assert.ok(store.current().every((r) => !r.valid_to && r.superseded_by == null));
  });

  await atest("a save below DEDUP_LO appends normally", async () => {
    const table = {
      "My name is Samuel": ORIGIN,
      "The garage code is 4821": vecAt(0.20),
    };
    const { store, core } = dedupCore("dedup-below-lo.jsonl", table);
    await core.save("My name is Samuel");
    const msg = await core.save("The garage code is 4821");
    assert.ok(/^Saved\./.test(msg), "plain append, not merge/restate");
    assert.strictEqual(store.current().length, 2);
  });

  await atest("thresholds are read from the injected config getter", async () => {
    const table = {
      "I prefer tea over coffee": ORIGIN,
      "I like tea more than coffee": vecAt(0.9522),
    };
    // Raise HI past the tea pair so the default restatement becomes an append.
    const { store, core } = dedupCore("dedup-cfg.jsonl", table, { hi: 0.99, lo: 0.97 });
    await core.save("I prefer tea over coffee");
    await core.save("I like tea more than coffee");
    assert.strictEqual(store.current().length, 2, "pair that is HI at 0.95 appends when config hi=0.99");
  });

  await atest("readDedupThresholds: live config wins over env, env over defaults", async () => {
    assert.deepStrictEqual(readDedupThresholds(null), { hi: DEDUP_HI, lo: DEDUP_LO });
    assert.strictEqual(DEDUP_HI, 0.95);
    assert.strictEqual(DEDUP_LO, 0.88);
    assert.deepStrictEqual(
      readDedupThresholds({ dedup_hi: 0.99, dedup_lo: 0.90 }),
      { hi: 0.99, lo: 0.90 },
      "config keys dedup_hi / dedup_lo"
    );
    const prevHi = process.env.RESONANCE_DEDUP_HI;
    const prevLo = process.env.RESONANCE_DEDUP_LO;
    process.env.RESONANCE_DEDUP_HI = "0.97";
    process.env.RESONANCE_DEDUP_LO = "0.91";
    try {
      assert.deepStrictEqual(readDedupThresholds(null), { hi: 0.97, lo: 0.91 }, "env when no config");
      assert.deepStrictEqual(
        readDedupThresholds({ dedup_hi: 0.93 }),
        { hi: 0.93, lo: 0.91 },
        "config hi wins; env lo fills the other"
      );
    } finally {
      if (prevHi === undefined) delete process.env.RESONANCE_DEDUP_HI;
      else process.env.RESONANCE_DEDUP_HI = prevHi;
      if (prevLo === undefined) delete process.env.RESONANCE_DEDUP_LO;
      else process.env.RESONANCE_DEDUP_LO = prevLo;
    }
  });

  await atest("dedup degrades to append when the new record has no vector", async () => {
    const store = new JsonlStore(tmp("dedup-novec.jsonl"));
    let live = true;
    const embed = async (texts) => {
      if (!live) throw new Error("embedder down");
      return texts.map(() => ORIGIN.slice());
    };
    const core = createCore({ store, embed });
    await core.save("I'm allergic to penicillin");
    live = false;
    const msg = await core.save("I am allergic to penicillin");
    assert.ok(/^Saved\./.test(msg) || /Saved/.test(msg), "save still succeeds");
    assert.strictEqual(store.current().length, 2, "can't compare → append, don't crash or drop");
    assert.strictEqual(store.current()[1].embedding, null);
  });

  await atest("exact byte-identical restatement still confirms (and now bumps access_count)", async () => {
    const { store, core } = dedupCore("dedup-exact.jsonl", { "I drink tea": ORIGIN });
    await core.save("I drink tea");
    const id = store.current()[0].id;
    const msg = await core.save("I drink tea");
    assert.ok(/Already remembered/.test(msg));
    assert.strictEqual(store.current().length, 1);
    assert.strictEqual(store.get(id).access_count, 1);
  });

  await atest("RM-02.b A/B bar on the duplicates corpus: dup_rate ≤ 0.1591 and recall@5 = 1", async () => {
    const { loadScenarios, runScenario } = require("./eval/measure.js");
    const scenarios = loadScenarios(path.join(__dirname, "eval", "corpora", "duplicates.jsonl"));
    const r = await runScenario(scenarios[0], { k: 5 });
    assert.ok(r.metrics.duplicate_rate <= 0.1591,
      "duplicate_rate " + r.metrics.duplicate_rate + " must drop ≥50% from 0.3182");
    assert.strictEqual(r.metrics.recall_at_k, 1,
      "recall@5 must hold (controls not over-merged); misses=" + (r.recall_at_k.misses || []).join(","));
  });

  section("RM-02.c --dedup-existing backfill");

  // Independent 3-D unit axes so tea/cat/dog groups cannot cosine-bleed.
  function axisAt(axis, cos) {
    const c = Number(cos);
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    if (axis === 0) return [c, s, 0];
    if (axis === 1) return [0, c, s];
    return [0, 0, 1];
  }
  const TEA_A = "I prefer tea over coffee";
  const TEA_B = "I like tea more than coffee";
  const CAT_A = "I have a cat named Koneko";
  const CAT_B = "I have a black cat named Koneko";
  const DOG = "I have a dog named Rex";
  const FIXTURE_TABLE = {
    [TEA_A]: [1, 0, 0],
    [TEA_B]: axisAt(0, 0.9522),
    [CAT_A]: [0, 1, 0],
    [CAT_B]: axisAt(1, 0.9435),
    [DOG]: [0, 0, 1],
  };
  const FIXTURE_TEXTS = [TEA_A, TEA_B, CAT_A, CAT_B, DOG];
  const T_BACKFILL = "2026-09-05T12:00:00.000Z";

  function seedRaw(file, rows) {
    const store = new JsonlStore(tmp(file));
    const t0 = "2026-01-01T00:00:00.000Z";
    for (const row of rows) {
      store.add(normalize({
        id: store.nextId(),
        created: t0, modified: t0, text: row.text,
        embedding: row.embedding != null ? row.embedding : null,
        valid_from: t0, last_confirmed: t0,
        access_count: row.access_count || 0,
      }));
    }
    return store;
  }
  function seedFixture(file, texts) {
    return seedRaw(file, (texts || FIXTURE_TEXTS).map((t) => ({
      text: t, embedding: FIXTURE_TABLE[t] ? FIXTURE_TABLE[t].slice() : null,
    })));
  }
  function currentTexts(store) {
    return store.current().map((r) => r.text).sort();
  }

  await atest("dry-run mutates NOTHING (bytes + mtime) and reports the known plan", async () => {
    const store = seedFixture("dedup-ex-dry.jsonl");
    const before = fs.readFileSync(store.file, "utf8");
    const mtime = fs.statSync(store.file).mtimeMs;
    const plan = await dedupExisting({ store, apply: false, now: T_BACKFILL });
    assert.strictEqual(plan.wrote, false, "dry-run must not apply");
    assert.strictEqual(fs.readFileSync(store.file, "utf8"), before, "store bytes unchanged");
    assert.strictEqual(fs.statSync(store.file).mtimeMs, mtime, "mtime unchanged");
    assert.strictEqual(plan.restatements.length, 1, "tea paraphrase is a restatement");
    assert.strictEqual(plan.restatements[0].incomingText, TEA_B);
    assert.strictEqual(plan.restatements[0].matchText, TEA_A);
    assert.strictEqual(plan.merges.length, 1, "cat pair is a mid-band merge");
    assert.strictEqual(plan.merges[0].survivorText, CAT_B, "longer original survives");
    assert.strictEqual(plan.merges[0].loserText, CAT_A);
    assert.ok(!plan.restatements.some((r) => r.incomingText === DOG || r.matchText === DOG));
    assert.ok(!plan.merges.some((m) => m.survivorText === DOG || m.loserText === DOG),
      "control dog must not enter the plan");
    assert.strictEqual(plan.beforeCount, 5);
    assert.strictEqual(plan.afterCount, 3);
    assert.strictEqual(plan.skipped.length, 0);
    const { formatPlan } = require("./dedup-existing.js");
    const out = formatPlan(plan, { apply: false, storePath: store.file });
    assert.ok(/dry-run/i.test(out));
    assert.ok(/Nothing written/i.test(out));
    assert.ok(/Restatements \(1\)/.test(out));
    assert.ok(/Merges \(1\)/.test(out));
  });

  await atest("apply end state matches sequential save() through 02.b (current texts)", async () => {
    const embed = async (texts) => texts.map((t) => (FIXTURE_TABLE[t] || [0, 0, 1]).slice());
    const online = new JsonlStore(tmp("dedup-ex-online.jsonl"));
    const core = createCore({ store: online, embed });
    for (const t of FIXTURE_TEXTS) await core.save(t);

    const offline = seedFixture("dedup-ex-offline.jsonl");
    const seeded = offline.all().length;
    const plan = await dedupExisting({ store: offline, apply: true, now: T_BACKFILL });
    assert.strictEqual(plan.wrote, true);
    assert.deepStrictEqual(currentTexts(offline), currentTexts(online),
      "offline backfill current() must match one-by-one save()");
    assert.strictEqual(offline.current().length, 3, "tea + cat + dog");
    assert.strictEqual(offline.all().length, seeded, "I8: backfill never hard-deletes");
    const tea = offline.current().find((r) => r.text === TEA_A);
    assert.ok(tea, "HI restatement keeps the earlier original");
    const cat = offline.current().find((r) => r.text === CAT_B);
    assert.ok(cat, "mid merge keeps the longer original");
    const catLoser = offline.active().find((r) => r.text === CAT_A);
    assert.ok(catLoser && catLoser.superseded_by === cat.id && catLoser.valid_to,
      "merge loser is superseded, not deleted");
    const teaLoser = offline.active().find((r) => r.text === TEA_B);
    assert.ok(teaLoser && teaLoser.superseded_by === tea.id,
      "already-stored restatement is superseded (I8) rather than dropped");
  });

  await atest("second --apply is a no-op; clean store reports nothing to do", async () => {
    const store = seedFixture("dedup-ex-idem.jsonl");
    await dedupExisting({ store, apply: true, now: T_BACKFILL });
    const before = fs.readFileSync(store.file, "utf8");
    const mtime = fs.statSync(store.file).mtimeMs;
    const again = await dedupExisting({ store, apply: true, now: T_BACKFILL });
    assert.ok(again.nothingToDo, "nothing left to merge");
    assert.strictEqual(again.wrote, false, "second apply must not rewrite");
    assert.strictEqual(again.restatements.length, 0);
    assert.strictEqual(again.merges.length, 0);
    assert.strictEqual(fs.readFileSync(store.file, "utf8"), before);
    assert.strictEqual(fs.statSync(store.file).mtimeMs, mtime);

    const clean = seedRaw("dedup-ex-clean.jsonl", [
      { text: "alpha", embedding: [1, 0, 0] },
      { text: "beta", embedding: [0, 1, 0] },
    ]);
    const p = await dedupExisting({ store: clean, apply: true });
    assert.ok(p.nothingToDo);
    assert.strictEqual(p.wrote, false);
    assert.strictEqual(clean.current().length, 2);
  });

  await atest("vectorless row is skipped, not merged (embedder down)", async () => {
    const store = seedRaw("dedup-ex-novec.jsonl", [
      { text: TEA_A, embedding: [1, 0, 0] },
      { text: TEA_B, embedding: null },
    ]);
    const before = fs.readFileSync(store.file, "utf8");
    const embed = async () => { throw new Error("embedder down"); };
    const plan = await dedupExisting({ store, embed, apply: true, now: T_BACKFILL });
    assert.strictEqual(plan.skipped.length, 1);
    assert.strictEqual(plan.skipped[0].reason, "no vector");
    assert.strictEqual(plan.restatements.length, 0, "must not merge blind");
    assert.strictEqual(plan.merges.length, 0);
    assert.strictEqual(store.current().length, 2, "both still current");
    assert.strictEqual(fs.readFileSync(store.file, "utf8"), before,
      "apply with nothing to patch must not rewrite");
  });

  await atest("vectorless row re-embeds then restates when the embedder is up", async () => {
    const store = seedRaw("dedup-ex-fill.jsonl", [
      { text: TEA_A, embedding: [1, 0, 0] },
      { text: TEA_B, embedding: null },
    ]);
    const embed = async (texts) => texts.map((t) => (FIXTURE_TABLE[t] || [1, 0, 0]).slice());
    const plan = await dedupExisting({ store, embed, apply: true, now: T_BACKFILL });
    assert.strictEqual(plan.skipped.length, 0);
    assert.strictEqual(plan.vectorBackfills, 1);
    assert.strictEqual(plan.restatements.length, 1);
    assert.strictEqual(store.current().length, 1);
    const loser = store.active().find((r) => r.text === TEA_B);
    assert.ok(loser && Array.isArray(loser.embedding) && loser.embedding.length,
      "filled vector is persisted on the superseded row too");
  });

  await atest("apply is one durable rewrite (I5) and loses no memory (I8)", async () => {
    const store = seedFixture("dedup-ex-i5.jsonl");
    const nSeeded = store.all().length;
    let many = 0, one = 0;
    const origMany = store.updateMany.bind(store);
    const origOne = store.update.bind(store);
    store.updateMany = function () { many++; return origMany.apply(this, arguments); };
    store.update = function () { one++; return origOne.apply(this, arguments); };
    await dedupExisting({ store, apply: true, now: T_BACKFILL });
    assert.strictEqual(many, 1, "one updateMany → one writeFileDurable");
    assert.strictEqual(one, 0, "never a per-pair store.update");
    const dir = path.dirname(store.file);
    const marker = "." + path.basename(store.file) + ".";
    const tmps = fs.readdirSync(dir).filter((n) => n.indexOf(marker) === 0 && n.slice(-4) === ".tmp");
    assert.strictEqual(tmps.length, 0, "writeFileDurable leaves no temp files");
    const raw = fs.readFileSync(store.file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.ok(raw.endsWith("\n"));
    for (const line of lines) JSON.parse(line);  // every line parseable — not truncated
    assert.strictEqual(store.all().length, nSeeded, "I8: survivors + superseded both present");
    assert.ok(store.active().every((r) => !r.deleted), "no hard/soft-delete of losers");
  });

  await atest("CLI --dedup-existing (entry.js) dry-run default; --apply required to mutate", async () => {
    const { spawnSync } = require("child_process");
    const store = seedFixture("dedup-ex-cli.jsonl");
    const before = fs.readFileSync(store.file, "utf8");
    const entry = path.join(__dirname, "entry.js");
    const env = Object.assign({}, process.env);
    delete env.RESONANCE_DEDUP_HI;
    delete env.RESONANCE_DEDUP_LO;
    delete env.RESONANCE_MEMORY_CONFIG;
    const dry = spawnSync(process.execPath, [entry, "--dedup-existing", "--json", store.file], {
      encoding: "utf8", timeout: 15000, env,
    });
    assert.strictEqual(dry.status, 0, "dry-run exit: " + (dry.stderr || dry.stdout));
    const report = JSON.parse(dry.stdout);
    assert.strictEqual(report.applied, false);
    assert.strictEqual(report.wrote, false);
    assert.strictEqual(report.restatements.length, 1);
    assert.strictEqual(report.merges.length, 1);
    assert.strictEqual(fs.readFileSync(store.file, "utf8"), before, "CLI dry-run mutates nothing");

    const applied = spawnSync(process.execPath, [entry, "--dedup-existing", "--apply", "--json", store.file], {
      encoding: "utf8", timeout: 15000, env,
    });
    assert.strictEqual(applied.status, 0, "apply exit: " + (applied.stderr || applied.stdout));
    const after = JSON.parse(applied.stdout);
    assert.strictEqual(after.applied, true);
    assert.strictEqual(after.wrote, true);
    assert.strictEqual(after.afterCount, 3);
    assert.notStrictEqual(fs.readFileSync(store.file, "utf8"), before);
    assert.strictEqual(new JsonlStore(store.file).current().length, 3);
  });

  await atest("duplicates corpus backfill: plan matches groups; dup_rate 0.3182→0; recall@5 holds", async () => {
    const { embed } = require("./eval/embed-cache.js");
    const { loadScenarios, resolveRelevant } = require("./eval/measure.js");
    const { groupsFromWrites, explainMetric, parsePrimaryHits } = require("./eval/metrics.js");
    const scenarios = loadScenarios(path.join(__dirname, "eval", "corpora", "duplicates.jsonl"));
    const writes = scenarios[0].writes;
    const groups = groupsFromWrites(writes);
    const textToGroup = {};
    for (const w of writes) textToGroup[w.text] = w.dup_group;

    // Pre-02.b shape: exact restatement already existed, so drop the second
    // byte-identical coffee-order write. 22 current, 7 extras (4 HI + 3 mid).
    const seenExact = new Set();
    const pre02b = [];
    for (const w of writes) {
      if (w.band === "exact") {
        if (seenExact.has(w.text)) continue;
        seenExact.add(w.text);
      }
      pre02b.push(w);
    }
    const vecs = await embed(pre02b.map((w) => w.text));
    const store = new JsonlStore(tmp("dedup-ex-corpus.jsonl"));
    for (let i = 0; i < pre02b.length; i++) {
      store.add(normalize({
        id: i + 1,
        text: pre02b[i].text,
        embedding: vecs[i],
        created: "2026-01-01T00:00:00.000Z",
      }));
    }
    const beforeBytes = fs.readFileSync(store.file, "utf8");
    const beforeDup = explainMetric("duplicate_rate", { records: store.current() }, { groups });
    assert.strictEqual(beforeDup.extras, 7);
    assert.ok(Math.abs(beforeDup.rate - 7 / 22) < 1e-9, "pre-02.b baseline 0.3182");

    const dry = await dedupExisting({ store, apply: false, now: T_BACKFILL });
    assert.strictEqual(fs.readFileSync(store.file, "utf8"), beforeBytes, "corpus dry-run is a no-write");
    const restateGroups = new Set(dry.restatements.map((r) => textToGroup[r.incomingText]));
    const mergeGroups = new Set(dry.merges.map((m) => textToGroup[m.loserText] || textToGroup[m.survivorText]));
    assert.ok(restateGroups.has("penicillin") && restateGroups.has("tea") && restateGroups.has("peanuts"),
      "HI groups are restatements");
    assert.ok(!restateGroups.has("coffee-order"), "exact pair already collapsed in this fixture");
    assert.ok(mergeGroups.has("job") && mergeGroups.has("cat") && mergeGroups.has("diabetic"),
      "mid groups are merges");
    for (const g of ["dog", "peanut-allergy", "standup", "mechanic", "name", "night-owl", "sister-bday", "garage"]) {
      assert.ok(!restateGroups.has(g) && !mergeGroups.has(g), "control " + g + " must not collapse");
    }
    assert.strictEqual(dry.restatements.length, 4, "4 HI extras");
    assert.strictEqual(dry.merges.length, 3, "3 mid extras");
    assert.strictEqual(dry.afterCount, 15);

    const applied = await dedupExisting({ store, apply: true, now: T_BACKFILL });
    assert.strictEqual(applied.wrote, true);
    const recs = store.current();
    const afterDup = explainMetric("duplicate_rate", { records: recs }, { groups });
    assert.strictEqual(afterDup.rate, 0, "duplicate_rate dropped to 0");
    assert.strictEqual(recs.length, 15);

    const core = createCore({ store, embed });
    let hits = 0;
    const misses = [];
    for (const q of scenarios[0].queries) {
      const output = await core.recall(q.query, 5);
      const ranked = parsePrimaryHits(output).map((h) => String(h.id));
      const relevant = resolveRelevant(q, recs, groups).map(String);
      if (relevant.some((id) => ranked.indexOf(id) >= 0)) hits++;
      else misses.push(q.id);
    }
    assert.strictEqual(hits, scenarios[0].queries.length,
      "recall@5 held; misses=" + misses.join(","));
  });

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
      // Phase 0.1/0.3 bind tests construct many collinear vecAtCos()
      // neighbors whose pairwise cosine is ≥ DEDUP_LO even though the
      // texts are distinct labels ("n90" vs "n80"). Dedup is RM-02.b's
      // job; these tests isolate bind. Bands above 1 disable it.
      dedupThresholds: opts.dedupThresholds || (() => ({ hi: 2, lo: 2 })),
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

  // ------------------------------------------------ Phase 0.5 live-path contract
  // Remaining transition-table rows (save-creates columns, save-where-exists
  // Writes?, field-off recall Writes? no) and the crash-before-edge-write
  // stale-semantic case. Fake clock via EdgeStore.now = T0 throughout.
  section("Phase 0.5 live-path contract (transition table + failure signatures)");

  await atest("transition: save creates edge — all columns + sidecar write", async () => {
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.80) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges, edgesPath } = saveTimeCore("p05-save-creates.jsonl", embed);
    await core.save("a");
    assert.strictEqual(fs.existsSync(edgesPath), false, "first save has no neighbor → no sidecar yet");
    await core.save("b");
    assert.ok(fs.existsSync(edgesPath), "Writes? yes — sidecar appears when an edge is created");
    const idA = store.current().find((m) => m.text === "a").id;
    const idB = store.current().find((m) => m.text === "b").id;
    const e = edges().get(idA, idB);
    assert.ok(e, "save-time edge exists");
    assert.strictEqual(e.hebbian.weight, 0, "no seeded baseline");
    assert.strictEqual(e.hebbian.last_updated, e.created_at, "last_updated = created_at");
    assert.ok(e.created_at, "created_at set");
    assert.strictEqual(e.pruned_at, null);
    assert.strictEqual(e.provenance.origin, "save-time-neighbor");
    assert.ok(typeof e.semantic.value === "number" && e.semantic.value >= SAVE_TIME_MIN_COS);
    const recA = store.get(e.a);
    const recB = store.get(e.b);
    assert.deepStrictEqual(e.semantic.src_versions, {
      a: recA.embedding_version,
      b: recB.embedding_version,
    });
    const j = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
    assert.strictEqual(j.kind, SIDECAR_KIND);
    assert.ok(j.edges[edgeKey(idA, idB)]);
  });

  await atest("transition: save where edge exists, versions fresh — no sidecar write, columns unmoved", async () => {
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.80) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges, edgesPath } = saveTimeCore("p05-exists-fresh.jsonl", embed);
    await core.save("a");
    await core.save("b");
    const idA = store.current().find((m) => m.text === "a").id;
    const idB = store.current().find((m) => m.text === "b").id;
    const recA = store.get(idA);
    const recB = store.get(idB);
    const snap = JSON.parse(JSON.stringify(edges().get(idA, idB)));
    const before = fs.readFileSync(edgesPath, "utf8");
    const mtime = fs.statSync(edgesPath).mtimeMs;
    const result = bindSaveTimeNeighbors(recB, [recA], edges());
    assert.strictEqual(result.wrote, false, "fresh src_versions → no recompute");
    assert.strictEqual(fs.readFileSync(edgesPath, "utf8"), before, "Writes? only if semantic recomputed");
    assert.strictEqual(fs.statSync(edgesPath).mtimeMs, mtime);
    assert.deepStrictEqual(edges().get(idA, idB), snap,
      "semantic, hebbian, created_at, pruned_at all unmoved");
  });

  await atest("transition: save where edge exists, versions stale — recompute semantic, hebbian unmoved, write yes", async () => {
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.80) };
    const embed = async (texts) => texts.map((t) => vecs[t] || [0, 0, 1]);
    const { store, core, edges, edgesPath } = saveTimeCore("p05-exists-stale.jsonl", embed);
    await core.save("a");
    await core.save("b");
    const idA = store.current().find((m) => m.text === "a").id;
    const idB = store.current().find((m) => m.text === "b").id;
    const recA = store.get(idA);
    const recB = store.get(idB);
    const edge = edges().get(idA, idB);
    const hebSnap = JSON.parse(JSON.stringify(edge.hebbian));
    const created = edge.created_at;
    const pruned = edge.pruned_at;
    const originSnap = JSON.parse(JSON.stringify(edge.provenance));
    // Simulate an edit() version bump with no edge write (transition table).
    recA.embedding_version = recA.embedding_version + 1;
    const before = fs.readFileSync(edgesPath, "utf8");
    const result = bindSaveTimeNeighbors(recB, [recA], edges());
    assert.strictEqual(result.wrote, true, "stale cache must be refreshed");
    assert.notStrictEqual(fs.readFileSync(edgesPath, "utf8"), before, "Writes? yes");
    const after = edges().get(idA, idB);
    assert.deepStrictEqual(after.hebbian, hebSnap, "hebbian.weight + last_updated unchanged");
    assert.strictEqual(after.created_at, created);
    assert.strictEqual(after.pruned_at, pruned);
    assert.deepStrictEqual(after.provenance, originSnap, "origin is how it came to exist");
    // store.get re-parses from disk; the bump lives on the in-memory recs we
    // passed into bind. Tag must follow canonical edge.a/edge.b, not save-arg order.
    const byId = { [String(idA)]: recA, [String(idB)]: recB };
    assert.strictEqual(
      semanticValid(after, byId[after.a].embedding_version, byId[after.b].embedding_version),
      true,
      "src_versions now match the recs bind saw"
    );
    assert.ok(typeof after.semantic.value === "number");
  });

  await atest("transition: field-off recall writes nothing to the edge store", async () => {
    // The transition-table `recall` row is Writes? no. Field-on recall still
    // co-issues reinforceRecall (sidecar write, not JSONL — I5); that is the
    // retained co-recall path, covered elsewhere. Field-off is the pure read.
    const vecs = { a: [1, 0, 0], b: vecAtCos(0.80), q: [1, 0, 0] };
    const embed = async (texts) => texts.map((t) => vecs[t] || vecs.q);
    const { core, edgesPath } = saveTimeCore("p05-recall-off.jsonl", embed, { fieldOn: false });
    await core.save("a");
    await core.save("b");
    assert.ok(fs.existsSync(edgesPath), "save-time bind already wrote the sidecar");
    const before = fs.readFileSync(edgesPath, "utf8");
    const mtime = fs.statSync(edgesPath).mtimeMs;
    await core.recall("q", 1);
    assert.strictEqual(fs.readFileSync(edgesPath, "utf8"), before, "field-off recall Writes? no");
    assert.strictEqual(fs.statSync(edgesPath).mtimeMs, mtime);
  });

  await atest("failure: crash-before-edge-write — persist bumped version, reload sidecar, still stale", async () => {
    // Event-based invalidation's failure window: memory persists, invalidation
    // never runs (crash, or by design: edit writes no edge). Stale must be
    // structurally self-evident on a FRESH EdgeStore loaded from disk.
    let vec = [1, 0, 0];
    const embed = async (texts) => texts.map(() => vec.slice());
    const { store, core, edgesPath } = saveTimeCore("p05-crash-stale.jsonl", embed);
    await core.save("first");
    await core.save("second");
    const ids = store.current().map((m) => m.id);
    const sidecarBefore = fs.readFileSync(edgesPath, "utf8");
    const srcBefore = JSON.parse(sidecarBefore).edges[edgeKey(ids[0], ids[1])].semantic.src_versions;
    vec = [0, 1, 0];
    await core.edit(ids[0], "first-edited");
    assert.strictEqual(store.get(ids[0]).embedding_version, 2);
    assert.strictEqual(fs.readFileSync(edgesPath, "utf8"), sidecarBefore,
      "edit did not touch the sidecar (crash-before-edges is the design)");
    // New process: load the sidecar from disk, no in-memory invalidate().
    const reloaded = new EdgeStore(edgesPath, { now: () => T0 });
    const edge = reloaded.get(ids[0], ids[1]);
    assert.deepStrictEqual(edge.semantic.src_versions, srcBefore, "no invalidation event rewrote it");
    const recA = store.get(edge.a);
    const recB = store.get(edge.b);
    assert.strictEqual(semanticValid(edge, recA.embedding_version, recB.embedding_version), false,
      "stale is a version comparison against the persisted memory, not a flag");
  });

  await atest("transition: reactivate does not rewrite semantic — self-heal is version mismatch", async () => {
    const { core, store, edges, edgesPath } = liveField("p05-re-stale.jsonl", true);
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
    const semSnap = JSON.parse(JSON.stringify(E.get(meetingId, diabeticId).semantic));
    const hebSnap = JSON.parse(JSON.stringify(E.get(meetingId, diabeticId).hebbian));
    const created = planted.created_at;
    await core.edit(meetingId, MEETING);   // re-embed → version 2; reactivation writes
    const after = E.get(meetingId, diabeticId);
    assert.strictEqual(after.pruned_at, null, "revived");
    assert.strictEqual(after.last_reactivated_at, T0);
    assert.strictEqual(after.created_at, created, "created_at preserved");
    assert.deepStrictEqual(after.hebbian, hebSnap, "weight + last_updated carried, not snapped");
    assert.deepStrictEqual(after.semantic, semSnap, "reactivate does not recompute semantic");
    const recA = store.get(after.a);
    const recB = store.get(after.b);
    assert.strictEqual(semanticValid(after, recA.embedding_version, recB.embedding_version), false,
      "self-heal is the version mismatch on next read, not an invalidation event");
    assert.ok(fs.existsSync(edgesPath), "Writes? yes (reactivation is the one edit write)");
  });
}

// ------------------------------------------------------------------- report
asyncTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }
  process.exit(failed ? 1 : 0);
});
