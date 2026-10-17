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
 * memory-write.js — PostToolUse hook (Write, Edit, MultiEdit). Runs RM's own
 * rebuild-on-write hook (lib/rebuild-on-write.js) with this session's folder,
 * cache and embedder, so an edit to a memory re-embeds just that file in the
 * background. In keyword mode there is nothing to embed, so it does nothing.
 */

const path = require("path");
const { spawn } = require("child_process");

const penv = require("./plugin-env.js");
const hook = require("./lib/rebuild-on-write.js");

async function run(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  try {
    const raw = opts.stdin != null ? String(opts.stdin) : await penv.readStdinText();
    const payload = penv.parsePayload(raw);
    const memoryDir = penv.memoryDirFrom(payload, env);
    if (!memoryDir) return 0;
    const embedder = await penv.embedderFor(env, { candidates: opts.candidates });
    if (embedder.mode !== "semantic") return 0;
    const renv = penv.recallEnv(env, memoryDir, embedder);
    // The lib hook's default spawner hands the child process.env, which has no
    // RECALL_* for this folder, so give it one that carries renv.
    const spawnFn = opts.spawn || (() => {
      const launch = hook.recallRebuildLaunch(path.join(__dirname, "lib", "recall.js"));
      const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true, env: renv });
      child.unref();
      return child;
    });
    return await hook.runRebuildHook({ stdin: raw, env: renv, spawn: spawnFn });
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

module.exports = { run };
