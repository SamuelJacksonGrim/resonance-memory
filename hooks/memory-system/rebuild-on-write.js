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
 * rebuild-on-write.js — Claude Code PostToolUse hook.
 * Port of tools/rebuild-on-memory-write.ps1. When Write / Edit / MultiEdit
 * touches a file under the memory directory, launch `recall.js --rebuild`
 * detached. Fails silent and does not wait.
 *
 * The PowerShell hook matches the literal path
 * projects\C--Users-spamw\memory\ (case-insensitive). That match is kept.
 * If RECALL_MEMORY is set, a write under that directory also fires, so an
 * install on another machine can point the hook at its own folder.
 * The child inherits the environment, so RECALL_CACHE / RECALL_ENDPOINT /
 * EMBED_* reach the rebuild.
 */

const path = require("path");
const { spawn } = require("child_process");

const LEGACY_MARK = /projects\\C--Users-spamw\\memory\\/i;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function underDir(filePath, root) {
  if (!root) return false;
  const file = path.resolve(String(filePath));
  const base = path.resolve(String(root));
  const rel = path.relative(base, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

function isMemoryPath(filePath, env) {
  const norm = String(filePath).replace(/\//g, "\\");
  if (LEGACY_MARK.test(norm)) return true;
  const e = env || process.env;
  if (e.RECALL_MEMORY && underDir(filePath, e.RECALL_MEMORY)) return true;
  return false;
}

function defaultSpawn() {
  const recall = path.join(__dirname, "recall.js");
  const child = spawn(process.execPath, [recall, "--rebuild"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  return child;
}

async function runRebuildHook(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  try {
    const raw = opts.stdin != null ? String(opts.stdin) : await readStdin();
    if (!raw) return 0;
    let payload;
    try { payload = JSON.parse(raw); }
    catch { return 0; }
    const tool = payload && payload.tool_name;
    if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") return 0;
    const filePath = payload.tool_input && payload.tool_input.file_path;
    if (!filePath) return 0;
    if (!isMemoryPath(filePath, env)) return 0;
    const spawnFn = opts.spawn || defaultSpawn;
    try { spawnFn(); }
    catch { /* a refresh must never fail the tool call */ }
    return 0;
  } catch {
    return 0;
  }
}

async function main() {
  return runRebuildHook();
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code || 0),
    () => process.exit(0)
  );
}

module.exports = {
  LEGACY_MARK,
  isMemoryPath,
  underDir,
  defaultSpawn,
  runRebuildHook,
  main,
};
