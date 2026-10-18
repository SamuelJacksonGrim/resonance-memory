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
 * recall-cli.js — the recall command Claude runs from its shell.
 *
 *   node recall-cli.js --memory-dir <dir> --data <plugin data dir> --query "..." [--top 5] [--history]
 *   node recall-cli.js --memory-dir <dir> --data <plugin data dir> --rebuild [--full] [--history]
 *
 * Commands Claude runs through its shell don't get CLAUDE_PLUGIN_DATA, so the
 * session-start hook writes both paths into the command it hands Claude, and
 * this wrapper turns them back into the same cache and embedder the hooks use.
 * Everything after that is RM's own recall.js.
 */

const penv = require("./plugin-env.js");
const recall = require("./lib/recall.js");

function takeFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return { value: "", rest: argv };
  const rest = argv.slice(0, i).concat(argv.slice(i + 2));
  return { value: argv[i + 1], rest };
}

async function main(argv) {
  let args = argv.slice();
  const mem = takeFlag(args, "--memory-dir");
  args = mem.rest;
  const data = takeFlag(args, "--data");
  args = data.rest;
  if (!mem.value) {
    process.stderr.write("Need --memory-dir (the session-start note has the full command).\n");
    return 1;
  }
  const env = Object.assign({}, process.env);
  if (data.value) env.CLAUDE_PLUGIN_DATA = data.value;
  const embedder = await penv.embedderFor(env, { fresh: true });
  const renv = penv.recallEnv(env, mem.value, embedder);
  if (embedder.mode !== "semantic" && args.includes("--rebuild")) {
    process.stdout.write("Keyword mode: nothing to rebuild (no local embedder found).\n");
    return 0;
  }
  // recall.js prints its ranked table on stderr (the PowerShell original wrote
  // it with Write-Host); send it to stdout so the shell tool shows it as the answer.
  const host = (m) => process.stdout.write(String(m) + "\n");
  return recall.main(args, { env: renv, host, out: host });
}

if (require.main === module) {
  // exitCode, not exit(): on Windows, Node 24 aborts with a libuv assertion
  // (UV_HANDLE_CLOSING, async.c:94) when process.exit() runs right after two
  // fetches to the same server (measured 2026-10-17: exit() 15/15 crashes,
  // exitCode 0/15). A crashed hook exits 127 and its output is dropped.
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code || 0; },
    (err) => {
      process.stderr.write(String(err && err.stack || err) + "\n");
      process.exitCode = 1;
    }
  );
}

module.exports = { main };
