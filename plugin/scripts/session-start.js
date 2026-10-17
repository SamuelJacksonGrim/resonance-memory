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
 * session-start.js — SessionStart hook (startup, resume, clear, compact).
 *
 * 1. Lays down the memory system in this project's memory folder, additively:
 *    a file that already exists is never touched, so a user's own MEMORY.md
 *    and memories survive. Only missing pieces are added.
 * 2. Detects the embedder fresh (LM Studio, Ollama, or none) and, when there is
 *    one, starts an incremental rebuild in the background so the first message
 *    already has warm vectors.
 * 3. Gives Claude the memory rules and the exact recall command for this
 *    folder. This is the plugin's stand-in for the CLAUDE.md block the exe
 *    installer writes: a plugin's CLAUDE.md is not loaded, and re-injecting on
 *    every start (including after compaction) means the rules can't fall out of
 *    context.
 *
 * Fails silent: any problem exits 0 with no output, so a broken memory folder
 * never blocks a session.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const penv = require("./plugin-env.js");

const ROOT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(ROOT, "template");

function fwd(p) {
  return String(p).split(path.sep).join("/");
}

// Copy what is missing, never overwrite. Returns the relative paths it added.
function layDown(memoryDir) {
  const added = [];
  fs.mkdirSync(memoryDir, { recursive: true });
  const walk = (srcDir, rel) => {
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, ent.name);
      const r = rel ? rel + "/" + ent.name : ent.name;
      const dst = path.join(memoryDir, r);
      if (ent.isDirectory()) {
        if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
        walk(src, r);
      } else if (ent.name !== ".keep" && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        added.push(r);
      }
    }
  };
  walk(TEMPLATE, "");
  return added;
}

function startRebuild(env) {
  const child = spawn(process.execPath, [path.join(__dirname, "lib", "recall.js"), "--rebuild"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
}

function recallCommand(memoryDir, data) {
  return "node \"" + fwd(path.join(__dirname, "recall-cli.js")) + "\" --memory-dir \"" + fwd(memoryDir)
    + "\" --data \"" + fwd(data) + "\"";
}

function modeLine(embedder) {
  if (embedder.mode === "semantic") {
    return "Recall searches by meaning (" + embedder.name + ", " + embedder.model + ").";
  }
  return "Recall is in keyword mode: no local embedder was found, so it matches words, not meaning. For recall by "
    + "meaning the user can run LM Studio or Ollama with nomic-embed-text loaded (free, offline); it is picked up at "
    + "the next session start. Mention this once if memory comes up, not every session.";
}

function contextText(memoryDir, embedder, added, data) {
  const cmd = recallCommand(memoryDir, data);
  const lines = [
    "## Memory (the Resonance Memory plugin)",
    "",
    "Your memory folder for this project is `" + fwd(memoryDir) + "`; its `MEMORY.md` index loads at the start of "
      + "every session. " + modeLine(embedder),
    "",
    "- **Search before saying you don't know** something about the user or your work together, and before asking "
      + "them to repeat themselves: `" + cmd + " --query \"what you're trying to remember\"` (add `--history` to "
      + "search faded text). It covers every live memory, including ones with no line in `MEMORY.md`.",
    "- A hook surfaces matching memories on each message as a `[recall]` block. Open the ones that look relevant; "
      + "ignore the rest.",
    "- **Read `memory-architecture.md` in that folder before writing a memory.** In short: merge into the memory "
      + "something belongs in before adding a file; correct by replacement, never an \"UPDATE:\" note; date every "
      + "fact; newer wins only when better supported; replaced text moves verbatim to `history/<same-name>.md`, "
      + "nothing is lost. Who the user is and how they want to work stays at the top level with a line in "
      + "`MEMORY.md`; everything else goes in `projects/`, `tools/` or `reference/` subject folders.",
    "- The recall index rebuilds itself after each Write/Edit in that folder. After edits made by a script or the "
      + "shell, run the same command with `--rebuild` instead of `--query`.",
  ];
  if (added.length) {
    lines.push("", "(First run in this folder: the plugin added " + added.join(", ") + ". Existing files were left "
      + "as they were.)");
  }
  return lines.join("\n");
}

async function run(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const write = opts.write || ((s) => process.stdout.write(s));
  try {
    const raw = opts.stdin != null ? String(opts.stdin) : await penv.readStdinText();
    const payload = penv.parsePayload(raw);
    const memoryDir = penv.memoryDirFrom(payload, env);
    if (!memoryDir) return 0;
    let added = [];
    try { added = layDown(memoryDir); }
    catch { /* an unwritable folder still gets the rules and recall */ }
    const embedder = await penv.embedderFor(env, { fresh: true, candidates: opts.candidates });
    if (embedder.mode === "semantic") {
      try { (opts.startRebuild || startRebuild)(penv.recallEnv(env, memoryDir, embedder)); }
      catch { /* the per-write hook and the next start retry */ }
    }
    const out = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: contextText(memoryDir, embedder, added, penv.dataDir(env)),
      },
    };
    write(JSON.stringify(out));
    return 0;
  } catch {
    return 0;
  }
}

if (require.main === module) {
  // exitCode, not exit(): on Windows, Node 24 aborts with a libuv assertion
  // (UV_HANDLE_CLOSING, async.c:94) when process.exit() runs right after two
  // fetches to the same server (measured 2026-10-17: exit() 15/15 crashes,
  // exitCode 0/15). A crashed hook exits 127 and its output is dropped.
  run().then((code) => { process.exitCode = code || 0; }, () => { process.exitCode = 0; });
}

module.exports = { run, layDown, contextText, recallCommand };
