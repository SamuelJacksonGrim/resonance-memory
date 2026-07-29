#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
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
} = require("./record.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); failed++; }
}
function section(s) { console.log("\n" + s); }

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

// ------------------------------------------------------------------- report
console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }
process.exit(failed ? 1 : 0);
