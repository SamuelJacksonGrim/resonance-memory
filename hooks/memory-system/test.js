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
"use strict";

/*
 * Unit tests for the memory-system recall port. No network: embeddings come
 * from an injected function or a localhost fake. On Windows, when
 * tools/recall.ps1 is present, a fixture is also planned with both engines
 * and the file set, hashes, and header fields must match.
 *
 * Run: node hooks/memory-system/test.js
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const sources = require("./sources.js");
const recall = require("./recall.js");
const hook = require("./recall-hook.js");
const rebuildHook = require("./rebuild-on-write.js");
const installMem = require("./install-memory.js");
const buildExe = require("../../build-exe.js");

const PS1 = "C:\\Users\\spamw\\tools\\recall.ps1";
const MODEL = "text-embedding-nomic-embed-text-v1.5";

const queue = [];
let passed = 0;
let failed = 0;
function section(s) { queue.push({ section: s }); }
function test(name, fn) { queue.push({ name, fn }); }

function capture() {
  const io = { hostLines: [], outLines: [] };
  io.host = (m) => io.hostLines.push(String(m));
  io.out = (m) => io.outLines.push(String(m));
  return io;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "recall-port-"));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function scriptedEmbed(vec) {
  const fn = async (text) => {
    fn.calls.push(text);
    if (fn.failOn && String(text).includes(fn.failOn)) throw new Error(fn.failMessage || "boom");
    return fn.vecFor ? fn.vecFor(text) : (fn.vec || vec || [1, 0, 0, 0]);
  };
  fn.calls = [];
  fn.vec = vec || [1, 0, 0, 0];
  fn.failOn = "";
  return fn;
}

function vecFromText(text) {
  if (String(text).startsWith("search_query:")) return [1, 0, 0, 0];
  const h = crypto.createHash("sha256").update(String(text), "utf8").digest();
  return [h[0] / 255, h[1] / 255, h[2] / 255, (h[3] + 1) / 255];
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        endpoint: "http://127.0.0.1:" + port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

function buildFixture(root) {
  write(path.join(root, "alpha.md"), [
    "---",
    "description: Alpha person",
    "persistence: standing",
    "weight: 0.55",
    "---",
    "Body mentions weight: 0.99 but the first match wins.",
    "",
  ].join("\n"));
  write(path.join(root, "beta.md"), [
    "description: \"quoted desc\"",
    "persistence: milestone",
    "weight: 0.9",
    "No fence. Still a live memory.",
    "",
  ].join("\n"));
  write(path.join(root, "bom-kept.md"), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("---\ndescription: bom kept\nweight: 0.4\n---\nkept body\n", "utf8"),
  ]));
  let gamma = "---\r\ndescription: café notes\r\npersistence: episodic\r\nweight: 0.25\r\n---\r\n";
  if (gamma.length < 2199) gamma += "n".repeat(2199 - gamma.length);
  assert.strictEqual(gamma.length, 2199, "surrogate must sit on the 2200 cut");
  gamma += "🙂AFTER" + "Z".repeat(400);
  write(path.join(root, "projects", "sub", "gamma.md"), gamma);
  write(path.join(root, "projects", "body-trap.md"), [
    "---",
    "description: real body",
    "weight: 0.3",
    "---",
    "generated: true",
    "A sentence in the body must not mark this generated.",
    "",
  ].join("\n"));
  write(path.join(root, "projects", "history", "not-the-fade-store.md"), "description: drawer named history\nweight: 0.5\n");
  write(path.join(root, "reference", "quoted-gen.md"), [
    "---",
    "generated: \"true\"",
    "description: quotes do not count",
    "weight: 0.5",
    "---",
    "kept, because the PowerShell scanner does not unquote.",
    "",
  ].join("\n"));
  write(path.join(root, "tools", "plain.md"), "No header fields at all.\n");
  write(path.join(root, "tools", "capital.md"), "Description: Capital Key\nPersistence: Standing\nWeight: 0.7\n");
  write(path.join(root, "tools", "Zed.md"), "description: zed\nweight: 0.5\n");
  write(path.join(root, "generated.md"), "---\ngenerated: true\ndescription: nope\n---\n");
  write(path.join(root, "projects", "cabinet.md"), "---\ncabinet-index: 1\ndescription: nope\n---\n");
  write(path.join(root, "yes-gen.md"), "---\nGenerated: YES\ndescription: nope\n---\n");
  write(path.join(root, "MEMORY.md"), "description: index\n");
  write(path.join(root, "_index.md"), "description: index\n");
  write(path.join(root, "_index-extra.md"), "description: index\n");
  write(path.join(root, "notes", "stray.md"), "description: stray\n");
  write(path.join(root, "other", "nope.md"), "description: nope\n");
  write(path.join(root, "history", "old.md"), "description: faded\nweight: 0.2\n");
  write(path.join(root, "history", "MEMORY.md"), "description: no\n");
  write(path.join(root, "history", "_index.md"), "description: history index name is not special in -History\n");
  write(path.join(root, "history", "nested", "nope.md"), "description: nested fade is not listed\n");
  write(path.join(root, "_session-archive", "old.md"), "description: no\n");
  write(path.join(root, "_indexes", "idx.md"), "description: no\n");
  write(path.join(root, "projects", "_indexes", "gen.md"), "description: no\n");
  write(path.join(root, "projects", "sub", "_session-archive", "x.md"), "description: no\n");
  write(path.join(root, "tools", "_Index.md"), "description: no\n");
  write(path.join(root, "reference", "_session-archive", "x.md"), "description: no\n");
  write(path.join(root, "readme.txt"), "not markdown\n");
}

const EXPECTED_LIVE = [
  "alpha.md",
  "beta.md",
  "bom-kept.md",
  "projects/body-trap.md",
  "projects/history/not-the-fade-store.md",
  "projects/sub/gamma.md",
  "reference/quoted-gen.md",
  "tools/capital.md",
  "tools/plain.md",
  "tools/Zed.md",
];

function runPs(args) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1,
  ].concat(args), { encoding: "utf8" });
}

section("source rules");

test("name and path excludes match the PowerShell predicates", async () => {
  assert.strictEqual(sources.excludedByName("MEMORY.md"), true);
  assert.strictEqual(sources.excludedByName("Memory.md"), true);
  assert.strictEqual(sources.excludedByName("_index.md"), true);
  assert.strictEqual(sources.excludedByName("_Index-Extra.md"), true);
  assert.strictEqual(sources.excludedByName("_indexed.md"), true);
  assert.strictEqual(sources.excludedByName("index.md"), false);
  assert.strictEqual(sources.excludedByName("alpha.md"), false);

  assert.strictEqual(sources.excludedByRel("alpha.md"), false);
  assert.strictEqual(sources.excludedByRel("history/old.md"), true);
  assert.strictEqual(sources.excludedByRel("History/old.md"), true);
  assert.strictEqual(sources.excludedByRel("_session-archive/old.md"), true);
  assert.strictEqual(sources.excludedByRel("_indexes/idx.md"), true);
  assert.strictEqual(sources.excludedByRel("notes/stray.md"), true);
  assert.strictEqual(sources.excludedByRel("projects/a.md"), false);
  assert.strictEqual(sources.excludedByRel("Projects/Sub/a.md"), false);
  assert.strictEqual(sources.excludedByRel("projects/history/a.md"), false);
  assert.strictEqual(sources.excludedByRel("projects/_indexes/a.md"), true);
  assert.strictEqual(sources.excludedByRel("projects/sub/_Indexes/a.md"), true);
  assert.strictEqual(sources.excludedByRel("tools/sub/_session-archive/a.md"), true);
  assert.strictEqual(sources.excludedByRel("reference/a.md"), false);
});

test("generated scanner is frontmatter-only and does not unquote", async () => {
  assert.strictEqual(sources.isGeneratedText("---\ngenerated: true\n---\n"), true);
  assert.strictEqual(sources.isGeneratedText("---\nGenerated: YES\n---\n"), true);
  assert.strictEqual(sources.isGeneratedText("---\ncabinet-index: 1\n---\n"), true);
  assert.strictEqual(sources.isGeneratedText("---\n  generated: true\n---\n"), false);
  assert.strictEqual(sources.isGeneratedText("---\ngenerated: \"true\"\n---\n"), false);
  assert.strictEqual(sources.isGeneratedText("generated: true\n"), false);
  assert.strictEqual(sources.isGeneratedText("---\ndescription: x\n---\ngenerated: true\n"), false);
  assert.strictEqual(sources.isGeneratedText("\uFEFF---\ngenerated: true\n---\n"), true);
  assert.strictEqual(sources.isGeneratedText("---\ndescription: x\n"), false);
});

test("live set is the drawers plus top level, sorted by full path", async () => {
  const root = tmpdir();
  try {
    buildFixture(root);
    const files = sources.liveFiles(root);
    assert.deepStrictEqual(files.map((f) => f.rel), EXPECTED_LIVE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

section("embed text");

test("document prefix, 2200 UTF-16 cut, and model|doc hash", async () => {
  const raw = "n".repeat(2199) + "🙂AFTER";
  const desc = "café";
  const doc = recall.documentText("gamma", raw, desc);
  assert.ok(doc.startsWith("search_document: gamma. café. "));
  assert.strictEqual(doc.length, "search_document: gamma. café. ".length + 2200);
  // The cut lands on the high surrogate of 🙂. .NET Substring does that too.
  assert.strictEqual(doc.charCodeAt(doc.length - 1), 0xd83d);
  const hash = recall.contentHash(MODEL, doc);
  assert.strictEqual(hash, crypto.createHash("sha256").update(MODEL + "|" + doc, "utf8").digest("hex"));
  assert.strictEqual(hash, hash.toLowerCase());
  assert.strictEqual(recall.getField("Description: Capital Key\nWeight: 0.7\n", "description", "x"), "Capital Key");
  assert.strictEqual(recall.getField("description: \"quoted desc\"\n", "description", "x"), "quoted desc");
  assert.strictEqual(recall.parseWeight("0.55"), 0.55);
  assert.strictEqual(recall.parseWeight(recall.getField("nope", "weight", "0.5")), 0.5);
});

test("endpoint accepts a base URL or RM's full /v1/embeddings URL", async () => {
  assert.strictEqual(recall.embeddingsUrl("http://localhost:1234"), "http://localhost:1234/v1/embeddings");
  assert.strictEqual(recall.embeddingsUrl("http://localhost:1234/"), "http://localhost:1234/v1/embeddings");
  assert.strictEqual(
    recall.embeddingsUrl("http://localhost:1234/v1/embeddings"),
    "http://localhost:1234/v1/embeddings"
  );
  const cfg = recall.resolveConfig({
    history: true,
    cache: "C:\\tools\\memory-embeddings.json",
    memoryDir: "C:\\mem",
    env: { RECALL_MODEL: "from-recall", EMBED_MODEL: "from-embed", EMBED_ENDPOINT: "http://127.0.0.1:9/v1/embeddings" },
  });
  assert.strictEqual(cfg.model, "from-recall");
  assert.strictEqual(cfg.endpoint, "http://127.0.0.1:9/v1/embeddings");
  assert.strictEqual(cfg.cache, "C:\\tools\\memory-embeddings-history.json");
  assert.strictEqual(cfg.memoryDir, path.join("C:\\mem", "history"));
  // The model never follows RM's EMBED_MODEL, and nothing personal is a default.
  const fallback = recall.resolveConfig({ env: { EMBED_MODEL: "from-embed" } });
  assert.strictEqual(fallback.model, recall.DEFAULT_MODEL);
  assert.strictEqual(fallback.memoryDir, "");
  assert.ok(recall.DEFAULT_CACHE.startsWith(require("os").homedir()), recall.DEFAULT_CACHE);
  assert.ok(recall.DEFAULT_CACHE.endsWith(path.join(".resonance-memory", "memory-embeddings.json")));
});

section("plan, history, duplicates");

test("plan lists live rows; history is flat and has its own cache name", async () => {
  const root = tmpdir();
  const io = capture();
  try {
    buildFixture(root);
    const live = await recall.plan({
      memoryDir: root, model: MODEL, host: io.host, out: io.out,
    });
    assert.strictEqual(live.exitCode, 0);
    assert.deepStrictEqual(live.rows.map((r) => r.rel), EXPECTED_LIVE);
    const alpha = live.rows.find((r) => r.name === "alpha");
    assert.strictEqual(alpha.description, "Alpha person");
    assert.strictEqual(alpha.persistence, "standing");
    assert.strictEqual(alpha.weight, 0.55);
    const plain = live.rows.find((r) => r.name === "plain");
    assert.strictEqual(plain.description, "plain");
    assert.strictEqual(plain.persistence, "standing");
    assert.strictEqual(plain.weight, 0.5);
    const quoted = live.rows.find((r) => r.name === "quoted-gen");
    assert.strictEqual(quoted.description, "quotes do not count");
    const capital = live.rows.find((r) => r.name === "capital");
    assert.strictEqual(capital.description, "Capital Key");
    assert.strictEqual(capital.persistence, "Standing");
    assert.strictEqual(capital.weight, 0.7);

    const histIo = capture();
    const hist = await recall.plan({
      memoryDir: root, model: MODEL, history: true, host: histIo.host, out: histIo.out,
    });
    assert.strictEqual(hist.exitCode, 0);
    const histRels = hist.rows.map((r) => r.rel).sort();
    assert.deepStrictEqual(histRels, ["history/_index.md", "history/old.md"]);
    assert.strictEqual(hist.cfg.cache.endsWith("-history.json"), true);

    const dupRoot = tmpdir();
    write(path.join(dupRoot, "projects", "same.md"), "description: a\n");
    write(path.join(dupRoot, "tools", "same.md"), "description: b\n");
    const dupIo = capture();
    const dup = await recall.plan({ memoryDir: dupRoot, model: MODEL, host: dupIo.host, out: dupIo.out });
    assert.strictEqual(dup.exitCode, 1);
    assert.ok(dupIo.outLines[0].includes("Duplicate basename 'same'"));
    assert.ok(dupIo.outLines[0].includes("Cache NOT modified."));
    fs.rmSync(dupRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PowerShell plan on the same fixture matches file set, hashes, and fields", async () => {
  if (process.platform !== "win32" || !fs.existsSync(PS1)) {
    console.log("       (skipped: recall.ps1 is not on this machine)");
    return;
  }
  const root = tmpdir();
  try {
    buildFixture(root);
    const psLive = path.join(root, "ps-live.json");
    const psHist = path.join(root, "ps-hist.json");
    const liveRun = runPs([
      "-Plan", "-MemoryDir", root, "-ResultPath", psLive, "-Model", MODEL,
      "-Endpoint", "http://127.0.0.1:9",
    ]);
    assert.strictEqual(liveRun.status, 0, liveRun.stderr || liveRun.stdout);
    const nodeLive = await recall.plan({ memoryDir: root, model: MODEL, host: () => {}, out: () => {} });
    const psRows = asArray(JSON.parse(fs.readFileSync(psLive, "utf8")));
    assert.strictEqual(psRows.length, nodeLive.rows.length);
    assert.deepStrictEqual(psRows.map((r) => r.rel), nodeLive.rows.map((r) => r.rel));
    for (let i = 0; i < psRows.length; i++) {
      const a = psRows[i];
      const b = nodeLive.rows[i];
      assert.strictEqual(b.name, a.name, a.rel);
      assert.strictEqual(b.hash, a.hash, a.rel + " hash");
      assert.strictEqual(b.description, a.description, a.rel + " description");
      assert.strictEqual(b.persistence, a.persistence, a.rel);
      assert.ok(Math.abs(b.weight - a.weight) < 1e-9, a.rel + " weight " + b.weight + " vs " + a.weight);
    }
    const histRun = runPs([
      "-Plan", "-History", "-MemoryDir", root, "-ResultPath", psHist, "-Model", MODEL,
    ]);
    assert.strictEqual(histRun.status, 0, histRun.stderr || histRun.stdout);
    const nodeHist = await recall.plan({
      memoryDir: root, model: MODEL, history: true, host: () => {}, out: () => {},
    });
    const psHistRows = asArray(JSON.parse(fs.readFileSync(psHist, "utf8")));
    const key = (rows) => rows.map((r) => r.rel + " " + r.hash).sort();
    assert.deepStrictEqual(key(nodeHist.rows), key(psHistRows));

    const dupRoot = tmpdir();
    write(path.join(dupRoot, "projects", "same.md"), "description: a\n");
    write(path.join(dupRoot, "tools", "Same.md"), "description: b\n");
    const dup = runPs(["-Plan", "-MemoryDir", dupRoot, "-ResultPath", path.join(dupRoot, "no.json"), "-Model", MODEL]);
    assert.strictEqual(dup.status, 1);
    fs.rmSync(dupRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

section("rebuild");

test("incremental reuse, full, delete, corrupt cache, failed embed leaves the cache", async () => {
  const root = tmpdir();
  const cache = path.join(root, "cache.json");
  const mem = path.join(root, "mem");
  write(path.join(mem, "a.md"), "description: aaa\nweight: 0.5\n\nbody-a\n");
  write(path.join(mem, "b.md"), "description: bbb\nweight: 0.4\n\nbody-b\n");
  const embed = scriptedEmbed();
  embed.vecFor = vecFromText;
  const io = capture();
  try {
    const first = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, endpoint: "http://127.0.0.1:9",
      embed, host: io.host, out: io.out,
    });
    assert.strictEqual(first.exitCode, 0);
    assert.strictEqual(first.embedded, 2);
    assert.strictEqual(first.reused, 0);
    assert.strictEqual(first.dropped, 0);
    assert.strictEqual(embed.calls.filter((t) => t === "search_query: healthcheck").length, 1);
    assert.strictEqual(embed.calls.filter((t) => t.startsWith("search_document:")).length, 2);
    assert.ok(!fs.existsSync(cache + ".tmp"));
    assert.ok(!fs.existsSync(cache + ".bak"));
    assert.ok(!fs.existsSync(cache + ".lock"));
    const raw1 = fs.readFileSync(cache);
    assert.notStrictEqual(raw1[0], 0xef, "cache must not start with a UTF-8 BOM");
    const entries1 = JSON.parse(raw1.toString("utf8"));
    assert.strictEqual(entries1.length, 2);
    assert.ok(entries1[0].vector.length, 4);
    const callsAfterFirst = embed.calls.length;

    const second = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, embed, host: io.host, out: io.out,
    });
    assert.strictEqual(second.exitCode, 0);
    assert.strictEqual(second.embedded, 0);
    assert.strictEqual(second.reused, 2);
    assert.strictEqual(embed.calls.length, callsAfterFirst, "unchanged rebuild must not call the embedder");
    const entries2 = JSON.parse(fs.readFileSync(cache, "utf8"));
    assert.deepStrictEqual(entries2.map((e) => e.vector), entries1.map((e) => e.vector));
    const bak = fs.readFileSync(cache + ".bak");
    assert.deepStrictEqual(bak, raw1);

    write(path.join(mem, "b.md"), "description: bbb changed\nweight: 0.4\n\nbody-b\n");
    const third = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, embed, host: io.host, out: io.out,
    });
    assert.strictEqual(third.embedded, 1);
    assert.strictEqual(third.reused, 1);
    const entries3 = JSON.parse(fs.readFileSync(cache, "utf8"));
    const a3 = entries3.find((e) => e.name === "a");
    const a1 = entries1.find((e) => e.name === "a");
    assert.deepStrictEqual(a3.vector, a1.vector);
    assert.notStrictEqual(entries3.find((e) => e.name === "b").hash, entries1.find((e) => e.name === "b").hash);

    fs.rmSync(path.join(mem, "b.md"));
    const fourth = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, embed, host: io.host, out: io.out,
    });
    assert.strictEqual(fourth.embedded, 0);
    assert.strictEqual(fourth.dropped, 1);
    assert.strictEqual(fourth.count, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(cache, "utf8"))[0].name, "a");

    const beforeFull = fs.readFileSync(cache);
    const full = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, full: true, embed, host: io.host, out: io.out,
    });
    assert.strictEqual(full.embedded, 1);
    assert.strictEqual(full.reused, 0);
    assert.deepStrictEqual(fs.readFileSync(cache + ".bak"), beforeFull);

    const upper = JSON.parse(fs.readFileSync(cache, "utf8"));
    upper[0].model = MODEL.toUpperCase();
    upper[0].hash = String(upper[0].hash).toUpperCase();
    fs.writeFileSync(cache, JSON.stringify(upper));
    const callsBeforeCase = embed.calls.length;
    const cased = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, embed, host: io.host, out: io.out,
    });
    assert.strictEqual(cased.reused, 1, "hash and model compare are case-insensitive, like PowerShell -eq");
    assert.strictEqual(embed.calls.length, callsBeforeCase);

    fs.writeFileSync(cache, "{");
    const healed = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, embed, host: io.host, out: io.out,
    });
    assert.strictEqual(healed.embedded, 1);
    assert.strictEqual(fs.readFileSync(cache + ".bak", "utf8"), "{");
    assert.strictEqual(JSON.parse(fs.readFileSync(cache, "utf8")).length, 1);

    const good = fs.readFileSync(cache);
    embed.failOn = "search_document:";
    const broke = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, full: true, embed, host: io.host, out: io.out,
    });
    assert.strictEqual(broke.exitCode, 1);
    assert.ok(io.outLines.some((l) => l.includes("Cache NOT modified.")));
    assert.deepStrictEqual(fs.readFileSync(cache), good);
    assert.ok(!fs.existsSync(cache + ".tmp"));
    assert.ok(!fs.existsSync(cache + ".lock"));
    embed.failOn = "";

    embed.failOn = "healthcheck";
    write(path.join(mem, "c.md"), "description: ccc\n");
    const beforeHealth = fs.readFileSync(cache);
    const sick = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, embed, host: io.host, out: io.out,
    });
    assert.strictEqual(sick.exitCode, 1);
    assert.deepStrictEqual(fs.readFileSync(cache), beforeHealth);
    fs.rmSync(path.join(mem, "c.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a one-element PowerShell cache (bare object, not an array) is reused", async () => {
  const root = tmpdir();
  const mem = path.join(root, "mem");
  const cache = path.join(root, "one.json");
  write(path.join(mem, "solo.md"), "description: only\nweight: 0.5\n\nhello\n");
  const embed = scriptedEmbed();
  embed.vecFor = vecFromText;
  try {
    const planned = await recall.plan({ memoryDir: mem, model: MODEL, host: () => {}, out: () => {} });
    const row = planned.rows[0];
    fs.writeFileSync(cache, JSON.stringify({
      name: row.name,
      description: row.description,
      persistence: row.persistence,
      weight: row.weight,
      rel: row.rel,
      model: MODEL,
      hash: row.hash,
      vector: [9, 8, 7],
    }));
    const result = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, embed, host: () => {}, out: () => {},
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.reused, 1);
    assert.strictEqual(embed.calls.length, 0);
    const written = JSON.parse(fs.readFileSync(cache, "utf8"));
    assert.ok(Array.isArray(written));
    assert.deepStrictEqual(written[0].vector, [9, 8, 7]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("empty directory and missing directory do not write a cache", async () => {
  const root = tmpdir();
  const mem = path.join(root, "mem");
  fs.mkdirSync(mem);
  const cache = path.join(root, "cache.json");
  const io = capture();
  try {
    const empty = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, embed: scriptedEmbed(), host: io.host, out: io.out,
    });
    assert.strictEqual(empty.exitCode, 1);
    assert.ok(io.outLines.some((l) => l.includes("No memory files found")));
    assert.ok(!fs.existsSync(cache));
    const missing = await recall.rebuild({
      memoryDir: path.join(root, "nope"), cache, model: MODEL, embed: scriptedEmbed(), host: io.host, out: io.out,
    });
    assert.strictEqual(missing.exitCode, 1);
    assert.ok(io.hostLines.some((l) => l.includes("No directory")));
    assert.ok(!fs.existsSync(cache));
    assert.ok(!fs.existsSync(cache + ".lock"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lock: a live holder times out, a dead holder is taken, two rebuilds do not overlap", async () => {
  const root = tmpdir();
  const mem = path.join(root, "mem");
  const cache = path.join(root, "cache.json");
  write(path.join(mem, "a.md"), "description: aaa\n");
  try {
    const held = cache + ".lock";
    fs.mkdirSync(held);
    fs.writeFileSync(path.join(held, "pid"), String(process.pid));
    const io = capture();
    const blocked = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, lockTimeoutMs: 200,
      embed: scriptedEmbed(), host: io.host, out: io.out,
    });
    assert.strictEqual(blocked.exitCode, 1);
    assert.ok(io.outLines.some((l) => l.includes("Another rebuild held the lock")));
    assert.ok(io.outLines.some((l) => l.includes("Cache untouched.")));
    assert.ok(!fs.existsSync(cache));
    fs.rmSync(held, { recursive: true, force: true });

    fs.mkdirSync(held);
    fs.writeFileSync(path.join(held, "pid"), "999999");
    let alive = true;
    try { process.kill(999999, 0); } catch (err) { alive = err.code === "EPERM"; }
    assert.strictEqual(alive, false, "pid 999999 must not be a live process on this machine");
    const took = await recall.rebuild({
      memoryDir: mem, cache, model: MODEL, lockTimeoutMs: 1000,
      embed: scriptedEmbed(), host: () => {}, out: () => {},
    });
    assert.strictEqual(took.exitCode, 0);
    assert.ok(!fs.existsSync(held));

    fs.rmSync(cache, { force: true });
    let active = 0;
    let maxActive = 0;
    const gate = async (text) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return vecFromText(text);
    };
    const [r1, r2] = await Promise.all([
      recall.rebuild({ memoryDir: mem, cache, model: MODEL, embed: gate, host: () => {}, out: () => {} }),
      recall.rebuild({ memoryDir: mem, cache, model: MODEL, embed: gate, host: () => {}, out: () => {} }),
    ]);
    assert.strictEqual(r1.exitCode, 0);
    assert.strictEqual(r2.exitCode, 0);
    assert.strictEqual(maxActive, 1, "embeddings from two rebuilds overlapped");
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(cache, "utf8"))));
    assert.ok(!fs.existsSync(cache + ".lock"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("embed request body is UTF-8, including non-ASCII and an emoji", async () => {
  let raw = null;
  let type = "";
  const srv = await listen(async (req, res) => {
    raw = await readBody(req);
    type = String(req.headers["content-type"] || "");
    const text = JSON.parse(raw.toString("utf8")).input[0];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: [text.length, 1, 0, 0] }] }));
  });
  try {
    const text = "search_document: café 日本語 🙂";
    const vec = await recall.embedText(text, {
      endpoint: srv.endpoint, model: "m", timeoutMs: 5000,
    });
    const expected = Buffer.from(JSON.stringify({ model: "m", input: [text] }), "utf8");
    assert.deepStrictEqual(raw, expected);
    assert.ok(type.toLowerCase().includes("charset=utf-8"));
    assert.ok(raw.includes(Buffer.from("café", "utf8")));
    assert.ok(raw.includes(Buffer.from("日本語", "utf8")));
    assert.ok(raw.includes(Buffer.from("🙂", "utf8")));
    assert.strictEqual(vec[0], text.length);
    // The Latin-1 byte for é must not be how the body encodes that character.
    const latin1 = Buffer.from(JSON.stringify({ model: "m", input: [text] }), "latin1");
    assert.notDeepStrictEqual(raw, latin1);
  } finally {
    await srv.close();
  }
});

section("query");

test("milestones are listed and not ranked; result file matches the rows", async () => {
  const root = tmpdir();
  const cache = path.join(root, "cache.json");
  const result = path.join(root, "out", "hits.json");
  fs.writeFileSync(cache, JSON.stringify([
    { name: "mile-low", persistence: "milestone", weight: 0.2, rel: "mile-low.md", vector: [1, 0, 0], description: "m" },
    { name: "mile-high", persistence: "Milestone", weight: 0.9, rel: "mile-high.md", vector: [0, 1, 0], description: "m" },
    { name: "best", persistence: "standing", weight: 0.55, rel: "best.md", vector: [1, 0, 0], description: "b" },
    { name: "mid", persistence: "standing", weight: 0.4, rel: "projects/mid.md", vector: [0.8, 0.6, 0], description: "m" },
    { name: "low", persistence: "standing", weight: 0.4, rel: "low.md", vector: [0, 1, 0], description: "l" },
  ]));
  const io = capture();
  try {
    const found = await recall.search({
      query: "find the thing",
      cache,
      model: MODEL,
      top: 2,
      resultPath: result,
      embed: async (text) => {
        assert.strictEqual(text, "search_query: find the thing");
        return [1, 0, 0];
      },
      host: io.host,
      out: io.out,
    });
    assert.strictEqual(found.exitCode, 0);
    assert.deepStrictEqual(found.hits.map((h) => h.name), ["best", "mid"]);
    assert.ok(Math.abs(found.hits[0].score - 1) < 1e-12);
    assert.ok(Math.abs(found.hits[1].score - 0.8) < 1e-12);
    assert.deepStrictEqual(io.hostLines, [
      "",
      "ALWAYS LOADED (milestone - not ranked, not optional)",
      "  [0.90] mile-high  mile-high.md",
      "  [0.20] mile-low  mile-low.md",
      "",
      "RETRIEVED for: \"find the thing\"",
      "  score    cosine   weight   memory",
      "  1.0000   1.0000   0.55     best  best.md",
      "  0.8000   0.8000   0.40     mid  projects/mid.md",
      "",
    ]);
    const payload = JSON.parse(fs.readFileSync(result, "utf8"));
    assert.strictEqual(payload.query, "find the thing");
    assert.deepStrictEqual(payload.hits.map((h) => h.name), ["best", "mid"]);
    const none = await recall.search({
      query: "",
      cache,
      host: io.host,
      out: io.out,
      embed: async () => { throw new Error("should not embed"); },
    });
    assert.strictEqual(none.exitCode, 0);
    const missing = capture();
    const noCache = await recall.search({
      query: "hello there friend",
      cache: path.join(root, "missing.json"),
      host: missing.host,
      out: missing.out,
      embed: async () => { throw new Error("should not embed"); },
    });
    assert.strictEqual(noCache.exitCode, 0);
    assert.ok(missing.hostLines[0].includes("No cache"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

section("prompt hook");

test("hook prints the top 3 at >= 0.70 and stays silent otherwise", async () => {
  const root = tmpdir();
  const mem = path.join(root, "mem");
  const cache = path.join(root, "cache.json");
  write(path.join(mem, "alpha.md"), "description: alpha desc\n");
  write(path.join(mem, "projects", "beta.md"), "description: beta desc\n");
  write(path.join(mem, "projects", "gamma.md"), "description: gamma desc\n");
  write(path.join(mem, "delta.md"), "description: delta desc\n");
  write(path.join(mem, "epsilon.md"), "description: epsilon desc\n");
  write(path.join(mem, "mile.md"), "description: mile desc\npersistence: milestone\n");
  write(path.join(mem, "projects", "dup.md"), "description: dup a\n");
  write(path.join(mem, "tools", "dup.md"), "description: dup b\n");
  fs.writeFileSync(cache, JSON.stringify([
    { name: "alpha", description: "alpha desc", persistence: "standing", weight: 0.5, vector: [1, 0, 0] },
    { name: "beta", description: "beta desc", persistence: "standing", weight: 0.5, vector: [0.8, 0.6, 0] },
    { name: "gamma", description: "gamma desc", persistence: "standing", weight: 0.5, vector: [0.75, Math.sqrt(1 - 0.75 * 0.75), 0] },
    { name: "delta", description: "delta desc", persistence: "standing", weight: 0.5, vector: [0.7, Math.sqrt(1 - 0.7 * 0.7), 0] },
    { name: "epsilon", description: "epsilon desc", persistence: "standing", weight: 0.5, vector: [0.699, Math.sqrt(1 - 0.699 * 0.699), 0] },
    { name: "mile", description: "mile desc", persistence: "milestone", weight: 1, vector: [1, 0, 0] },
    { name: "dup", description: "dup desc", persistence: "standing", weight: 0.5, vector: [1, 0, 0] },
    { name: "ghost", description: "not on disk", persistence: "standing", weight: 0.5, vector: [1, 0, 0] },
  ]));
  const env = { RECALL_MEMORY: mem, RECALL_CACHE: cache, RECALL_MODEL: "m" };
  const seen = [];
  const embed = async (text) => {
    seen.push(text);
    return [1, 0, 0];
  };
  try {
    let written = "";
    const code = await hook.runHook({
      stdin: JSON.stringify({ prompt: "  hello world!  " }),
      env, embed, write: (s) => { written += s; },
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(seen, ["search_query:   hello world!  "]);
    assert.strictEqual(written, [
      "[recall] Auto-surfaced memories that may bear on this message (read the file if relevant):",
      "  - alpha (1.00) -- alpha desc  [alpha.md]",
      "  - beta (0.80) -- beta desc  [projects/beta.md]",
      "  - gamma (0.75) -- gamma desc  [projects/gamma.md]",
      "",
    ].join("\n"));

    const silent = async (stdin, embedFn) => {
      let out = "";
      const c = await hook.runHook({
        stdin, env, embed: embedFn || embed, write: (s) => { out += s; },
      });
      assert.strictEqual(c, 0);
      assert.strictEqual(out, "");
    };
    await silent("");
    await silent("not json");
    await silent(JSON.stringify({ prompt: "hello there" }));
    await silent(JSON.stringify({ prompt: "hello there!" }), async () => { throw new Error("down"); });
    await silent(JSON.stringify({ prompt: "hello there!" }), async () => [0, 0, 0]);
    await silent(JSON.stringify({ prompt: "hello there!" }), async () => [0, 0, 1]);
    const quietEnv = Object.assign({}, env, { RECALL_CACHE: path.join(root, "missing.json") });
    let out = "";
    await hook.runHook({
      stdin: JSON.stringify({ prompt: "hello there!" }),
      env: quietEnv,
      embed: async () => { throw new Error("should not be called"); },
      write: (s) => { out += s; },
    });
    assert.strictEqual(out, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

section("rebuild-on-write hook");

test("only Write/Edit/MultiEdit under the memory dir spawns, and it does not wait", async () => {
  let calls = 0;
  const spawnFn = () => { calls++; };
  const fire = (payload, env) => rebuildHook.runRebuildHook({
    stdin: payload == null ? "" : JSON.stringify(payload),
    env: env || {},
    spawn: spawnFn,
  });
  assert.strictEqual(await fire(null), 0);
  assert.strictEqual(calls, 0);
  assert.strictEqual(await fire({ tool_name: "Read", tool_input: { file_path: "C:\\Users\\spamw\\.claude\\projects\\C--Users-spamw\\memory\\a.md" } }), 0);
  assert.strictEqual(calls, 0);
  assert.strictEqual(await rebuildHook.runRebuildHook({ stdin: "{", spawn: spawnFn }), 0);
  assert.strictEqual(calls, 0);
  assert.strictEqual(await fire({ tool_name: "Write", tool_input: { file_path: "C:\\tmp\\elsewhere.md" } }), 0);
  assert.strictEqual(calls, 0);
  // No legacy path: without RECALL_MEMORY, a write anywhere (including the old hardcoded folder) fires nothing.
  assert.strictEqual(await fire({
    tool_name: "Write",
    tool_input: { file_path: "C:/Users/someone/.claude/projects/x/memory/foo.md" },
  }), 0);
  assert.strictEqual(calls, 0);

  const root = tmpdir();
  const mem = path.join(root, "mem");
  fs.mkdirSync(mem);
  assert.strictEqual(await fire({
    tool_name: "Write",
    tool_input: { file_path: path.join(mem, "a.md") },
  }, { RECALL_MEMORY: mem }), 0);
  assert.strictEqual(calls, 1);
  for (const tool of ["Edit", "MultiEdit"]) {
    assert.strictEqual(await fire({ tool_name: tool, tool_input: { file_path: path.join(mem, "sub", "b.md") } },
      { RECALL_MEMORY: mem }), 0);
  }
  assert.strictEqual(calls, 3);
  assert.strictEqual(await fire({ tool_name: "Write", tool_input: { file_path: path.join(root, "mem-other", "c.md") } },
    { RECALL_MEMORY: mem }), 0);
  assert.strictEqual(calls, 3);                    // a sibling folder with a similar name doesn't match
  fs.rmSync(root, { recursive: true, force: true });
});

test("detached rebuild writes a scratch cache and the hook returns first", async () => {
  const root = tmpdir();
  const mem = path.join(root, "mem");
  const cache = path.join(root, "cache.json");
  write(path.join(mem, "a.md"), "---\ndescription: alpha\nweight: 0.5\n---\nhello\n");
  let release;
  const hold = new Promise((r) => { release = r; });
  let requests = 0;
  const srv = await listen(async (req, res) => {
    await readBody(req);
    requests++;
    if (requests === 1) await hold;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
  });
  try {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, "rebuild-on-write.js")], {
      env: Object.assign({}, process.env, {
        RECALL_MEMORY: mem,
        RECALL_CACHE: cache,
        RECALL_ENDPOINT: srv.endpoint,
        RECALL_MODEL: "m",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.end(JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: path.join(mem, "a.md") },
    }));
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("hook did not exit")), 5000);
      child.on("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, "");
    assert.strictEqual(stderr, "");
    assert.ok(elapsed < 1000, "hook blocked on the rebuild (" + elapsed + "ms)");
    assert.ok(!fs.existsSync(cache), "cache appeared before the embedder was released");
    release();
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(cache)) {
      if (Date.now() > deadline) throw new Error("detached rebuild did not write the cache");
      await new Promise((r) => setTimeout(r, 20));
    }
    const rows = JSON.parse(fs.readFileSync(cache, "utf8"));
    assert.strictEqual(rows[0].name, "a");
    assert.strictEqual(rows[0].model, "m");
    assert.deepStrictEqual(rows[0].vector, [1, 0, 0, 0]);
    assert.ok(!fs.existsSync(cache + ".lock"));
  } finally {
    release();
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

section("cli");

test("node recall.js --plan writes the result file and no-args exits 0", async () => {
  const root = tmpdir();
  try {
    write(path.join(root, "mem", "a.md"), "description: aaa\nweight: 0.5\n");
    const out = path.join(root, "plan.json");
    const planned = spawnSync(process.execPath, [
      path.join(__dirname, "recall.js"),
      "--plan", "--memory-dir", path.join(root, "mem"),
      "--result", out, "--model", MODEL,
    ], { encoding: "utf8" });
    assert.strictEqual(planned.status, 0, planned.stderr);
    const rows = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.strictEqual(rows[0].name, "a");
    assert.strictEqual(rows[0].description, "aaa");
    const bare = spawnSync(process.execPath, [path.join(__dirname, "recall.js")], { encoding: "utf8" });
    assert.strictEqual(bare.status, 0);
    assert.ok(bare.stderr.includes("Need -Query, -Rebuild, or -Plan."));
    const both = spawnSync(process.execPath, [
      path.join(__dirname, "recall.js"), "--plan", "--query", "x",
      "--memory-dir", path.join(root, "mem"),
    ], { encoding: "utf8" });
    assert.strictEqual(both.status, 1);
    assert.ok(both.stderr.includes("Use -Plan on its own."));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cosine zero-vector is 0 and a normal pair matches the formula", async () => {
  assert.strictEqual(recall.cosine([0, 0], [1, 0]), 0);
  assert.strictEqual(recall.cosine([1, 0], [0, 0]), 0);
  assert.ok(Math.abs(recall.cosine([1, 0], [0.6, 0.8]) - 0.6) < 1e-12);
});

section("config file and installer");

function installEnv(home) {
  return { USERPROFILE: home, HOME: home };
}

function scrubRecallEnv(base) {
  const env = Object.assign({}, base);
  for (const k of ["RECALL_MEMORY", "RECALL_CACHE", "RECALL_ENDPOINT", "RECALL_MODEL", "RECALL_CONFIG", "EMBED_ENDPOINT", "EMBED_MODEL"]) {
    delete env[k];
  }
  return env;
}

test("config file is used only when the flag and RECALL_* env are absent", async () => {
  const home = tmpdir();
  try {
    const mem = path.join(home, "mem");
    const cache = path.join(home, "cache.json");
    write(path.join(home, ".resonance-memory", "memory-system.json"), JSON.stringify({
      memoryDir: mem,
      cache: cache,
      endpoint: "http://127.0.0.1:9",
      model: "from-file",
    }));
    const env = Object.assign(installEnv(home), { EMBED_MODEL: "from-embed" });
    const cfg = recall.resolveConfig({ env });
    assert.strictEqual(cfg.memoryDir, mem);
    assert.strictEqual(cfg.cache, cache);
    assert.strictEqual(cfg.endpoint, "http://127.0.0.1:9");
    assert.strictEqual(cfg.model, "from-file", "EMBED_MODEL must not win over the config file");
    const fromEnv = recall.resolveConfig({
      env: Object.assign({}, env, { RECALL_MODEL: "from-env", RECALL_MEMORY: path.join(home, "other") }),
    });
    assert.strictEqual(fromEnv.model, "from-env");
    assert.strictEqual(fromEnv.memoryDir, path.join(home, "other"));
    const flagged = recall.resolveConfig({ env, model: "from-flag", memoryDir: path.join(home, "flagged") });
    assert.strictEqual(flagged.model, "from-flag");
    assert.strictEqual(flagged.memoryDir, path.join(home, "flagged"));
    assert.notStrictEqual(cfg.cache, recall.DEFAULT_CACHE);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("write hook watches the config file's memoryDir when RECALL_MEMORY is unset", async () => {
  const home = tmpdir();
  const mem = path.join(home, "mem");
  fs.mkdirSync(mem);
  write(path.join(home, ".resonance-memory", "memory-system.json"), JSON.stringify({ memoryDir: mem }));
  let calls = 0;
  const fire = (filePath) => rebuildHook.runRebuildHook({
    stdin: JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } }),
    env: installEnv(home),
    spawn: () => { calls++; },
  });
  try {
    assert.strictEqual(await fire(path.join(mem, "a.md")), 0);
    assert.strictEqual(calls, 1);
    assert.strictEqual(await fire(path.join(home, "elsewhere.md")), 0);
    assert.strictEqual(calls, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("rebuild child uses entry.js when the hook was started that way", async () => {
  const entry = path.join(__dirname, "..", "..", "entry.js");
  const viaEntry = rebuildHook.recallRebuildLaunch(entry);
  assert.deepStrictEqual(viaEntry.args.slice(-2), ["--recall", "--rebuild"]);
  assert.ok(viaEntry.args[0].endsWith("entry.js"));
  const direct = rebuildHook.recallRebuildLaunch(path.join(__dirname, "rebuild-on-write.js"));
  assert.ok(direct.args[0].endsWith("recall.js"));
  assert.deepStrictEqual(direct.args.slice(1), ["--rebuild"]);
});

test("hook identity matches the exe flag and the PowerShell scripts, not --recall", async () => {
  assert.strictEqual(installMem.isRecallHook({
    command: "powershell", args: ["-File", "C:\\tools\\recall-hook.ps1"],
  }), true);
  assert.strictEqual(installMem.isRecallHook({
    command: process.execPath, args: ["C:\\repo\\entry.js", "--recall-hook"],
  }), true);
  assert.strictEqual(installMem.isRecallHook({
    command: process.execPath, args: ["C:\\repo\\entry.js", "--recall", "--query", "x"],
  }), false);
  assert.strictEqual(installMem.isRebuildHook({
    command: "powershell", args: ["-File", "C:\\tools\\rebuild-on-memory-write.ps1"],
  }), true);
  assert.strictEqual(installMem.isRebuildHook({ command: "echo", args: ["hi"] }), false);
  const spec = installMem.hookSpec("--recall-hook", 15, "recalling memory...");
  assert.strictEqual(spec.type, "command");
  assert.strictEqual(spec.command, process.execPath);
  assert.ok(spec.args.includes("--recall-hook"));
  assert.ok(spec.args.some((a) => a.endsWith("entry.js")));
});

test("CLAUDE block placeholders are filled and paths with spaces are quoted", async () => {
  const filled = installMem.fillClaudeBlock(installMem.loadClaudeBlock(), {
    memoryDir: "C:\\mem ory",
    cabinetDir: "C:\\cab inet",
    recallPrefix: "\"C:\\Program Files\\node.exe\" \"C:\\repo\\entry.js\" --recall",
  });
  assert.ok(filled.includes("\"C:\\mem ory\""));
  assert.ok(filled.includes("\"C:\\cab inet\""));
  assert.ok(filled.includes("--recall --query"));
  assert.ok(filled.includes("--recall --rebuild"));
  assert.ok(filled.includes("MEMORY.md"));
  assert.ok(!filled.includes("MEMORY_DIR"));
  assert.ok(!filled.includes("RECALL_JS"));
  assert.ok(!filled.includes("CABINET_DIR"));
});

test("ship assets carry the template, the memory scripts, and the cabinet package", async () => {
  const root = path.join(__dirname, "..", "..");
  const assets = buildExe.collectShipAssets(root);
  assert.ok(assets.memoryTemplate.files["MEMORY.md"].includes("Memory index"));
  assert.strictEqual(typeof assets.memoryTemplate.files["projects/.keep"], "string");
  assert.ok(assets.memoryTemplate.files["history/README.md"].includes("faded"));
  assert.ok(assets.memoryScripts["recall.js"].includes("runtimeFrom"));
  assert.ok(assets.memoryScripts["install-memory.js"].includes("installMemorySystem"));
  assert.ok(assets.memoryScripts["recall-hook.js"]);
  assert.ok(assets.memoryScripts["rebuild-on-write.js"]);
  assert.ok(assets.memoryScripts["sources.js"]);
  assert.ok(!assets.memoryScripts["test.js"]);
  assert.ok(assets.cabinetPackage.files["__main__.py"].includes("def cmd_index"));
  assert.ok(!assets.cabinetPackage.files["tests/test_cabinet.py"]);
  assert.ok(assets.claudeMemoryBlock.includes("RECALL_JS"));
  assert.ok(assets.demoSeed.length > 0);
  assert.ok(assets.systemPrompt.includes("```"));
  const module = { exports: {} };
  new Function("module", buildExe.renderEmbeddedAssets(root))(module);
  assert.strictEqual(module.exports.memoryTemplate.files["MEMORY.md"], assets.memoryTemplate.files["MEMORY.md"]);
  assert.strictEqual(typeof module.exports.demoSeed, "string");
  assert.strictEqual(typeof module.exports.systemPrompt, "string");
  const fromInstaller = installMem.loadTemplate();
  assert.strictEqual(fromInstaller.files["cabinet.tsv"], assets.memoryTemplate.files["cabinet.tsv"]);
});

test("dry run writes nothing", async () => {
  const home = tmpdir();
  const memoryDir = path.join(home, "proj", "memory");
  write(path.join(memoryDir, "MEMORY.md"), "USER OWNED\n");
  const before = fs.readFileSync(path.join(memoryDir, "MEMORY.md"));
  const mtime = fs.statSync(path.join(memoryDir, "MEMORY.md")).mtimeMs;
  try {
    const result = await installMem.installMemorySystem({
      memoryDir: memoryDir,
      env: installEnv(home),
      embed: scriptedEmbed(),
    });
    assert.strictEqual(result.exitCode, 0, result.lines.join("\n"));
    assert.strictEqual(result.wrote, false);
    assert.strictEqual(result.lines[0], "dry run: nothing will be written");
    assert.ok(result.lines.some((l) => l.startsWith("would write ") && l.includes("cabinet.tsv")));
    assert.ok(result.lines.some((l) => l.includes("MEMORY.md") && l.includes("merge by hand")));
    assert.ok(result.lines.some((l) => l.includes("would add UserPromptSubmit") && l.includes("--recall-hook") && l.includes("entry.js")));
    assert.ok(result.lines.some((l) => l.includes("would add PostToolUse " + installMem.POST_MATCHER) && l.includes("--rebuild-on-write")));
    assert.ok(result.lines.some((l) => l.includes("would append memory block")));
    assert.ok(result.lines.some((l) => l.includes("would full-rebuild")));
    assert.deepStrictEqual(fs.readFileSync(path.join(memoryDir, "MEMORY.md")), before);
    assert.strictEqual(fs.statSync(path.join(memoryDir, "MEMORY.md")).mtimeMs, mtime);
    assert.ok(!fs.existsSync(path.join(memoryDir, "cabinet.tsv")));
    assert.ok(!fs.existsSync(path.join(home, ".claude", "settings.json")));
    assert.ok(!fs.existsSync(path.join(home, ".claude", "CLAUDE.md")));
    assert.ok(!fs.existsSync(path.join(home, ".resonance-memory", "memory-system.json")));
    assert.ok(!fs.existsSync(path.join(home, ".resonance-memory", "memory-embeddings.json")));
    assert.strictEqual(result.lines.filter((l) => l.startsWith("wrote ") || l.startsWith("applied")).length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("missing --memory-dir writes nothing", async () => {
  const home = tmpdir();
  try {
    const result = await installMem.installMemorySystem({
      apply: true,
      env: installEnv(home),
      embed: scriptedEmbed(),
    });
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.wrote, false);
    assert.ok(result.lines[0].includes("refusing"));
    assert.ok(result.lines.some((l) => l.includes("Missing --memory-dir")));
    assert.ok(!fs.existsSync(path.join(home, ".claude")));
    assert.ok(!fs.existsSync(path.join(home, ".resonance-memory")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("invalid settings.json stops the install before any write", async () => {
  const home = tmpdir();
  const memoryDir = path.join(home, "mem");
  const settingsPath = path.join(home, ".claude", "settings.json");
  write(settingsPath, "{ not json");
  try {
    const result = await installMem.installMemorySystem({
      apply: true,
      memoryDir: memoryDir,
      env: installEnv(home),
      embed: scriptedEmbed(),
    });
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.wrote, false);
    assert.strictEqual(result.lines[0], "refusing to apply; nothing written");
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), "{ not json");
    assert.ok(!fs.existsSync(settingsPath + ".bak"));
    assert.ok(!fs.existsSync(memoryDir));
    assert.ok(!fs.existsSync(path.join(home, ".resonance-memory", "memory-system.json")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("apply lays the template without overwriting, merges hooks once, and appends the block once", async () => {
  const home = tmpdir();
  const env = installEnv(home);
  const memoryDir = path.join(home, "proj", "memory");
  const ownedMemory = "USER OWNED memory index\n";
  const ownedArch = "USER RULES stay\n";
  write(path.join(memoryDir, "MEMORY.md"), ownedMemory);
  write(path.join(memoryDir, "memory-architecture.md"), ownedArch);
  const settingsPath = path.join(home, ".claude", "settings.json");
  const originalSettings = JSON.stringify({
    theme: "dark",
    permissions: { defaultMode: "bypassPermissions" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo", args: ["keep-me"] }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "C:\\custom\\note.exe", args: ["--ping"] }] },
      ],
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo", args: ["bash"] }] },
        { matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: "echo", args: ["fmt"] }] },
      ],
    },
  }, null, 2) + "\n";
  write(settingsPath, originalSettings);
  const claudePath = path.join(home, ".claude", "CLAUDE.md");
  write(claudePath, "Hello.\n");
  const configPath = path.join(home, ".resonance-memory", "memory-system.json");
  write(configPath, JSON.stringify({ extra: true, memoryDir: "old", cache: "old", endpoint: "old", model: "old" }));
  const templateRoot = path.join(__dirname, "..", "..", "memory-system", "template");
  try {
    const first = await installMem.installMemorySystem({
      apply: true,
      memoryDir: memoryDir,
      env: env,
      embed: scriptedEmbed([1, 0, 0, 0]),
    });
    assert.strictEqual(first.exitCode, 0, first.lines.join("\n"));
    assert.strictEqual(first.wrote, true);
    assert.strictEqual(first.lines[0], "applying");
    assert.ok(first.lines.includes("applied"));
    assert.strictEqual(fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8"), ownedMemory);
    assert.strictEqual(fs.readFileSync(path.join(memoryDir, "memory-architecture.md"), "utf8"), ownedArch);
    assert.ok(first.lines.some((l) => l.includes("MEMORY.md") && l.includes("merge by hand")));
    assert.ok(first.lines.some((l) => l.includes("memory-architecture.md") && l.includes("merge by hand")));
    assert.strictEqual(
      fs.readFileSync(path.join(memoryDir, "cabinet.tsv"), "utf8"),
      fs.readFileSync(path.join(templateRoot, "cabinet.tsv"), "utf8")
    );
    assert.strictEqual(
      fs.readFileSync(path.join(memoryDir, "history", "README.md"), "utf8"),
      fs.readFileSync(path.join(templateRoot, "history", "README.md"), "utf8")
    );
    assert.ok(fs.existsSync(path.join(memoryDir, "projects", ".keep")));
    assert.ok(fs.existsSync(path.join(memoryDir, "reference", ".keep")));
    assert.ok(fs.existsSync(path.join(memoryDir, "tools", ".keep")));

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.strictEqual(settings.theme, "dark");
    assert.strictEqual(settings.permissions.defaultMode, "bypassPermissions");
    assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].args[0], "keep-me");
    assert.strictEqual(settings.hooks.PostToolUse[0].matcher, "Bash");
    assert.strictEqual(settings.hooks.PostToolUse[0].hooks[0].args[0], "bash");
    const writeGroup = settings.hooks.PostToolUse.find((g) => g.matcher === "Write|Edit|MultiEdit");
    assert.ok(writeGroup);
    assert.strictEqual(writeGroup.hooks[0].args[0], "fmt");
    assert.strictEqual(writeGroup.hooks.filter((h) => (h.args || []).includes("--rebuild-on-write")).length, 1);
    const promptHooks = settings.hooks.UserPromptSubmit[0].hooks;
    assert.ok(promptHooks.some((h) => (h.args || []).includes("--ping")));
    assert.strictEqual(promptHooks.filter((h) => (h.args || []).includes("--recall-hook")).length, 1);
    assert.ok(promptHooks.some((h) => (h.args || []).some((a) => String(a).endsWith("entry.js"))));
    assert.strictEqual(fs.readFileSync(settingsPath + ".bak", "utf8"), originalSettings);

    const claude = fs.readFileSync(claudePath, "utf8");
    assert.ok(claude.startsWith("Hello.\n"));
    assert.strictEqual(claude.split(installMem.BLOCK_MARKER).length, 2);
    assert.ok(claude.includes("--recall --query"), claude);
    assert.ok(claude.includes("--recall --rebuild"));
    assert.ok(claude.includes(memoryDir));
    assert.ok(!claude.includes("RECALL_JS"));
    assert.ok(!claude.includes("MEMORY_DIR"));
    assert.ok(!claude.includes("CABINET_DIR"));
    assert.strictEqual(fs.readFileSync(claudePath + ".bak", "utf8"), "Hello.\n");

    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.strictEqual(cfg.extra, true);
    assert.strictEqual(cfg.memoryDir, memoryDir);
    assert.strictEqual(cfg.model, recall.DEFAULT_MODEL);
    assert.ok(cfg.cache.startsWith(home), cfg.cache);
    assert.ok(fs.existsSync(cfg.cache));
    const cached = JSON.parse(fs.readFileSync(cfg.cache, "utf8"));
    assert.ok(cached.some((r) => r.name === "memory-architecture"));
    const cabMain = path.join(home, ".resonance-memory", "cabinet", "cabinet", "__main__.py");
    assert.ok(fs.readFileSync(cabMain, "utf8").includes("def cmd_index"));

    const settingsBytes = fs.readFileSync(settingsPath);
    const claudeBytes = fs.readFileSync(claudePath);
    const configBytes = fs.readFileSync(configPath);
    const bakMtime = fs.statSync(settingsPath + ".bak").mtimeMs;
    const memMtime = fs.statSync(path.join(memoryDir, "MEMORY.md")).mtimeMs;
    const cabMtime = fs.statSync(cabMain).mtimeMs;

    const second = await installMem.installMemorySystem({
      apply: true,
      memoryDir: memoryDir,
      env: env,
      embed: scriptedEmbed([1, 0, 0, 0]),
    });
    assert.strictEqual(second.exitCode, 0, second.lines.join("\n"));
    assert.ok(second.lines.some((l) => l.includes("not adding another")));
    assert.ok(second.lines.some((l) => l.includes("hooks already present")));
    assert.ok(second.lines.some((l) => l.includes("memory block already present")));
    const again = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.strictEqual(
      again.hooks.UserPromptSubmit[0].hooks.filter((h) => (h.args || []).includes("--recall-hook")).length,
      1
    );
    const rebuilds = again.hooks.PostToolUse
      .filter((g) => g.matcher === "Write|Edit|MultiEdit")
      .reduce((n, g) => n + g.hooks.filter((h) => (h.args || []).includes("--rebuild-on-write")).length, 0);
    assert.strictEqual(rebuilds, 1);
    assert.deepStrictEqual(fs.readFileSync(settingsPath), settingsBytes);
    assert.deepStrictEqual(fs.readFileSync(claudePath), claudeBytes);
    assert.deepStrictEqual(fs.readFileSync(configPath), configBytes);
    assert.strictEqual(fs.readFileSync(claudePath, "utf8").split(installMem.BLOCK_MARKER).length, 2);
    assert.strictEqual(fs.statSync(settingsPath + ".bak").mtimeMs, bakMtime);
    assert.strictEqual(fs.statSync(path.join(memoryDir, "MEMORY.md")).mtimeMs, memMtime);
    assert.strictEqual(fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8"), ownedMemory);
    assert.strictEqual(fs.statSync(cabMain).mtimeMs, cabMtime);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PowerShell recall hooks are preserved and not duplicated", async () => {
  const home = tmpdir();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const text = [
    "{",
    "  \"theme\": \"dark\",",
    "  \"hooks\": {",
    "    \"UserPromptSubmit\": [{",
    "      \"hooks\": [{",
    "        \"type\": \"command\",",
    "        \"command\": \"powershell\",",
    "        \"args\": [\"-File\", \"C:\\\\tools\\\\recall-hook.ps1\"]",
    "      }]",
    "    }],",
    "    \"PostToolUse\": [{",
    "      \"matcher\": \"Write|Edit|MultiEdit\",",
    "      \"hooks\": [{",
    "        \"type\": \"command\",",
    "        \"command\": \"powershell\",",
    "        \"args\": [\"-File\", \"C:\\\\tools\\\\rebuild-on-memory-write.ps1\"]",
    "      }]",
    "    }]",
    "  }",
    "}",
    "",
  ].join("\n");
  write(settingsPath, text);
  try {
    const result = await installMem.installMemorySystem({
      apply: true,
      memoryDir: path.join(home, "mem"),
      env: installEnv(home),
      embed: scriptedEmbed([1, 0, 0, 0]),
    });
    assert.strictEqual(result.exitCode, 0, result.lines.join("\n"));
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), text);
    assert.ok(!fs.existsSync(settingsPath + ".bak"));
    assert.ok(result.lines.some((l) => l.includes("recall-hook.ps1") && l.includes("not adding another")));
    assert.ok(result.lines.some((l) => l.includes("rebuild-on-memory-write.ps1") && l.includes("not adding another")));
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.hooks.UserPromptSubmit[0].hooks.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("entry.js flags: dry run, recall plan, and the prompt hook", async () => {
  const entry = path.join(__dirname, "..", "..", "entry.js");
  const home = tmpdir();
  const env = scrubRecallEnv(Object.assign({}, process.env, installEnv(home)));
  const mem = path.join(home, "mem");
  write(path.join(mem, "alpha.md"), "description: alpha desc\nweight: 0.5\n");
  write(path.join(mem, "history", "old.md"), "description: old desc\n");
  const srv = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
  });
  try {
    const dry = spawnSync(process.execPath, [
      entry, "--install-memory-system", "--memory-dir", mem,
    ], { encoding: "utf8", env: env });
    assert.strictEqual(dry.status, 0, dry.stderr || dry.stdout);
    assert.ok(dry.stdout.includes("dry run: nothing will be written"), dry.stdout);
    assert.ok(dry.stdout.includes("would write"));
    assert.ok(!fs.existsSync(path.join(home, ".claude", "settings.json")));
    assert.ok(!fs.existsSync(path.join(home, ".resonance-memory", "memory-system.json")));
    const owned = fs.readFileSync(path.join(mem, "alpha.md"), "utf8");

    const planOut = path.join(home, "plan.json");
    const planned = spawnSync(process.execPath, [
      entry, "--recall", "--plan", "--memory-dir", mem, "--result", planOut, "--model", MODEL,
    ], { encoding: "utf8", env: env });
    assert.strictEqual(planned.status, 0, planned.stderr);
    const planRows = JSON.parse(fs.readFileSync(planOut, "utf8"));
    assert.ok(planRows.some((r) => r.name === "alpha"));
    assert.ok(!planRows.some((r) => r.rel && r.rel.indexOf("history/") === 0));

    const histOut = path.join(home, "hist.json");
    const hist = spawnSync(process.execPath, [
      entry, "--recall", "--history", "--plan", "--memory-dir", mem, "--result", histOut, "--model", MODEL,
    ], { encoding: "utf8", env: env });
    assert.strictEqual(hist.status, 0, hist.stderr);
    const histRows = JSON.parse(fs.readFileSync(histOut, "utf8"));
    assert.ok(histRows.some((r) => r.name === "old"));

    const cache = path.join(home, "cache.json");
    fs.writeFileSync(cache, JSON.stringify([
      { name: "alpha", description: "alpha desc", persistence: "standing", weight: 0.5, vector: [1, 0, 0] },
    ]));
    write(path.join(home, ".resonance-memory", "memory-system.json"), JSON.stringify({
      memoryDir: mem,
      cache: cache,
      endpoint: srv.endpoint,
      model: "m",
    }));
    // spawnSync freezes this process, so the fake embedder could not answer
    // and the hook (fail-silent) would print nothing. Wait without blocking.
    const hooked = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, "--recall-hook"], { env: env });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ prompt: "hello world!" }));
    });
    assert.strictEqual(hooked.status, 0, hooked.stderr);
    assert.ok(hooked.stdout.includes("[recall]"), hooked.stdout + "\n" + hooked.stderr);
    assert.ok(hooked.stdout.includes("alpha"));
    const quiet = spawnSync(process.execPath, [entry, "--recall-hook"], {
      input: JSON.stringify({ prompt: "hi" }),
      encoding: "utf8",
      env: env,
    });
    assert.strictEqual(quiet.status, 0, quiet.stderr);
    assert.strictEqual(quiet.stdout, "");
    const ignored = spawnSync(process.execPath, [entry, "--rebuild-on-write"], {
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(mem, "alpha.md") } }),
      encoding: "utf8",
      env: env,
    });
    assert.strictEqual(ignored.status, 0, ignored.stderr);
    assert.strictEqual(ignored.stdout, "");
    assert.strictEqual(fs.readFileSync(path.join(mem, "alpha.md"), "utf8"), owned);
  } finally {
    await srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

(async () => {
  for (const item of queue) {
    if (item.section) {
      console.log("\n" + item.section);
      continue;
    }
    try {
      await item.fn();
      console.log("  ok   " + item.name);
      passed++;
    } catch (e) {
      console.log("  FAIL " + item.name + "\n       " + (e && e.stack ? e.stack : e));
      failed++;
    }
  }
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
