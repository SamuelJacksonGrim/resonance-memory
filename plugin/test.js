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
 * plugin/test.js — offline checks for the Claude Code plugin.
 *
 * The plugin installs from its own folder (Claude Code copies only ./plugin),
 * so it carries copies of the recall scripts in scripts/lib. The first test is
 * the guard against the two drifting: every lib file must be byte-identical to
 * hooks/memory-system/. To refresh after changing the originals:
 *   node plugin/test.js --sync
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const ORIG = path.join(ROOT, "..", "hooks", "memory-system");
const LIB = path.join(ROOT, "scripts", "lib");
const LIB_FILES = fs.readdirSync(LIB).filter((f) => f.endsWith(".js")).sort();

if (process.argv.includes("--sync")) {
  for (const f of LIB_FILES) fs.copyFileSync(path.join(ORIG, f), path.join(LIB, f));
  console.log("synced " + LIB_FILES.join(", ") + " from hooks/memory-system");
  process.exit(0);
}

const penv = require("./scripts/plugin-env.js");
const session = require("./scripts/session-start.js");
const memoryWrite = require("./scripts/memory-write.js");

const NONE = [{ name: "none", endpoint: "http://127.0.0.1:9", match: /x/ }];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rm-plugin-test-"));
}

test("scripts/lib matches hooks/memory-system byte for byte", () => {
  for (const f of LIB_FILES) {
    const a = fs.readFileSync(path.join(ORIG, f));
    const b = fs.readFileSync(path.join(LIB, f));
    assert.ok(a.equals(b), f + " drifted from hooks/memory-system (run: node plugin/test.js --sync)");
  }
});

test("lib carries every module the recall scripts require", () => {
  for (const f of LIB_FILES) {
    const src = fs.readFileSync(path.join(LIB, f), "utf8");
    for (const m of src.matchAll(/require\("\.\/([^"]+)"\)/g)) {
      assert.ok(fs.existsSync(path.join(LIB, m[1])), f + " requires ./" + m[1] + ", which is not in scripts/lib");
    }
  }
});

test("memory folder: pinned option wins, else beside the transcript", () => {
  assert.strictEqual(penv.memoryDirFrom({ transcript_path: "/x/projects/p/s.jsonl" }, {}), path.join("/x/projects/p", "memory"));
  const pinned = penv.memoryDirFrom({ transcript_path: "/x/projects/p/s.jsonl" }, { CLAUDE_PLUGIN_OPTION_MEMORY_DIR: "/mem" });
  assert.strictEqual(pinned, path.resolve("/mem"));
  assert.strictEqual(penv.memoryDirFrom({}, {}), "");
});

test("recall env blanks RECALL_CONFIG and keys the cache by folder", () => {
  const env = { CLAUDE_PLUGIN_DATA: "/d", RECALL_CONFIG: "/home/.resonance-memory/memory-system.json" };
  const a = penv.recallEnv(env, "/a/memory", { mode: "keyword" });
  const b = penv.recallEnv(env, "/b/memory", { mode: "keyword" });
  assert.strictEqual(a.RECALL_CONFIG, "");
  assert.strictEqual(a.RECALL_MEMORY, "/a/memory");
  assert.notStrictEqual(a.RECALL_CACHE, b.RECALL_CACHE);
  const s = penv.recallEnv(env, "/a/memory", { mode: "semantic", endpoint: "http://e", model: "m" });
  assert.strictEqual(s.RECALL_ENDPOINT, "http://e");
  assert.strictEqual(s.RECALL_MODEL, "m");
});

test("no embedder answering means keyword mode, not an error", async () => {
  const r = await penv.detectEmbedder({}, { candidates: NONE, timeoutMs: 500 });
  assert.strictEqual(r.mode, "keyword");
});

test("session start lays the system down once and never overwrites", async () => {
  const dir = tmpDir();
  const proj = path.join(dir, "proj");
  const env = { CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const stdin = JSON.stringify({ transcript_path: path.join(proj, "s.jsonl") });
  let out = "";
  await session.run({ env, stdin, write: (s) => { out += s; }, candidates: NONE, startRebuild: () => {} });
  const mem = path.join(proj, "memory");
  for (const f of ["MEMORY.md", "memory-architecture.md", path.join("history", "README.md")]) {
    assert.ok(fs.existsSync(path.join(mem, f)), f + " not laid down");
  }
  for (const d of ["projects", "tools", "reference"]) assert.ok(fs.statSync(path.join(mem, d)).isDirectory());
  assert.ok(!fs.existsSync(path.join(mem, "projects", ".keep")), ".keep should not be copied");
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.ok(/keyword mode/.test(ctx) && /First run/.test(ctx));
  assert.ok(ctx.length < 10000, "additionalContext is capped at 10,000 characters");

  fs.writeFileSync(path.join(mem, "MEMORY.md"), "mine\n");
  out = "";
  await session.run({ env, stdin, write: (s) => { out += s; }, candidates: NONE, startRebuild: () => {} });
  assert.strictEqual(fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8"), "mine\n");
  assert.ok(!/First run/.test(JSON.parse(out).hookSpecificOutput.additionalContext));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("session start is silent without a transcript path", async () => {
  let out = "";
  await session.run({ env: {}, stdin: "{}", write: (s) => { out += s; }, candidates: NONE });
  assert.strictEqual(out, "");
});

test("memory write in keyword mode starts no rebuild", async () => {
  const dir = tmpDir();
  let spawned = 0;
  const env = { CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CLAUDE_PLUGIN_OPTION_MEMORY_DIR: path.join(dir, "memory") };
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "embedder.json"), JSON.stringify({ at: Date.now(), result: { mode: "keyword" } }));
  const stdin = JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(dir, "memory", "a.md") } });
  await memoryWrite.run({ env, stdin, spawn: () => { spawned++; } });
  assert.strictEqual(spawned, 0);
  fs.writeFileSync(path.join(dir, "data", "embedder.json"), JSON.stringify({ at: Date.now(), result: { mode: "semantic", endpoint: "http://e", model: "m" } }));
  await memoryWrite.run({ env, stdin, spawn: () => { spawned++; } });
  assert.strictEqual(spawned, 1, "a memory write with an embedder should rebuild");
  const other = JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(dir, "elsewhere.md") } });
  await memoryWrite.run({ env, stdin: other, spawn: () => { spawned++; } });
  assert.strictEqual(spawned, 1, "a write outside the memory folder should not rebuild");
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("ok   " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL " + t.name + "\n     " + (err && err.message));
    }
  }
  console.log(failed ? failed + " failed" : "all " + tests.length + " passed");
  process.exit(failed ? 1 : 0);
})();
