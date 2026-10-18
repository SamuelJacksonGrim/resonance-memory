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
 * prompt-recall.js — UserPromptSubmit hook. Resolves this session's memory
 * folder, cache and embedder (plugin-env.js), then runs RM's own recall hook
 * (lib/recall-hook.js) unchanged with that environment. Same output, same
 * threshold, same silence on failure as the exe install.
 */

const penv = require("./plugin-env.js");
const hook = require("./lib/recall-hook.js");

async function run(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  try {
    const raw = opts.stdin != null ? String(opts.stdin) : await penv.readStdinText();
    const payload = penv.parsePayload(raw);
    const memoryDir = penv.memoryDirFrom(payload, env);
    if (!memoryDir) return 0;
    const embedder = await penv.embedderFor(env, { candidates: opts.candidates });
    return await hook.runHook({
      stdin: raw,
      env: penv.recallEnv(env, memoryDir, embedder),
      write: opts.write,
    });
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
