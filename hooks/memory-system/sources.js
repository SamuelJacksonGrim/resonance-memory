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
 * sources.js — which files are live memories.
 * Port of recall-sources.ps1 (2026-10-11). Same include and exclude rules.
 * Segment tests are case-insensitive, matching PowerShell -eq.
 *
 * Included:
 *   <root>/<name>.md
 *   <root>/projects/any-depth/<name>.md
 *   <root>/tools/any-depth/<name>.md
 *   <root>/reference/any-depth/<name>.md
 * Excluded:
 *   MEMORY.md, names starting with _index
 *   frontmatter generated: true or cabinet-index: true
 *   top-level history/, _session-archive/, _indexes/
 *   _indexes/ and _session-archive/ at any depth
 *   any other top-level folder
 * history/ is excluded only as the first path segment.
 */

const fs = require("fs");
const path = require("path");

const DRAWERS = ["projects", "tools", "reference"];
const GENERATED_RE = /^(generated|cabinet-index):\s*(true|yes|1)\s*$/i;

function decodeUtf8(buf) {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  return b.toString("utf8");
}

function readText(fullPath) {
  return decodeUtf8(fs.readFileSync(fullPath));
}

function baseNameOf(filename) {
  return path.parse(filename).name;
}

function excludedByName(name) {
  const lower = String(name).toLowerCase();
  if (lower === "memory.md") return true;
  if (lower.startsWith("_index")) return true;
  return false;
}

function excludedByRel(rel) {
  const parts = String(rel).replace(/\\/g, "/").split("/");
  if (parts.length < 2) return false;
  const top = parts[0].toLowerCase();
  if (top === "history" || top === "_session-archive" || top === "_indexes") return true;
  if (top !== "projects" && top !== "tools" && top !== "reference") return true;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i].toLowerCase();
    if (seg === "_indexes" || seg === "_session-archive") return true;
  }
  return false;
}

function isGeneratedText(text) {
  if (!text) return false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.startsWith("---")) return false;
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end < 0) return false;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 0x20 || c0 === 0x09) continue;
    if (GENERATED_RE.test(line)) return true;
  }
  return false;
}

function relOf(root, fullPath) {
  const rel = path.relative(root, fullPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function keepFile(fullPath, root) {
  const rel = relOf(root, fullPath);
  if (rel == null) return false;
  if (excludedByRel(rel)) return false;
  if (excludedByName(path.basename(fullPath))) return false;
  let text = readText(fullPath);
  if (text.length > 8192) text = text.slice(0, 8192);
  if (isGeneratedText(text)) return false;
  return true;
}

function eachMd(dir, recursive, visit) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recursive) eachMd(full, true, visit);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
      visit(full);
    }
  }
}

function fileRecord(root, fullPath) {
  const name = path.basename(fullPath);
  return {
    fullPath,
    name,
    baseName: baseNameOf(name),
    rel: relOf(root, fullPath),
  };
}

function liveFiles(root) {
  const rootPath = path.resolve(root);
  const acc = [];
  eachMd(rootPath, false, (full) => {
    if (keepFile(full, rootPath)) acc.push(full);
  });
  for (const drawer of DRAWERS) {
    const dir = path.join(rootPath, drawer);
    if (!fs.existsSync(dir)) continue;
    eachMd(dir, true, (full) => {
      if (keepFile(full, rootPath)) acc.push(full);
    });
  }
  // Case-insensitive ordinal order. PowerShell Sort-Object is the current
  // culture's word sort, which ignores hyphens, so a few names trade places
  // (the set does not). Rank does not use this order.
  acc.sort((a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  });
  return acc.map((full) => fileRecord(rootPath, full));
}

// Flat listing of a history directory. Not sorted: PowerShell Get-ChildItem
// leaves filesystem order. Caller passes the history folder itself.
function listHistoryFlat(historyDir) {
  const dir = path.resolve(historyDir);
  const acc = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const ent of entries) {
    if (ent.isSymbolicLink() || !ent.isFile()) continue;
    if (!ent.name.toLowerCase().endsWith(".md")) continue;
    if (ent.name.toLowerCase() === "memory.md") continue;
    acc.push(fileRecord(dir, path.join(dir, ent.name)));
  }
  return acc;
}

module.exports = {
  DRAWERS,
  readText,
  decodeUtf8,
  baseNameOf,
  excludedByName,
  excludedByRel,
  isGeneratedText,
  relOf,
  keepFile,
  liveFiles,
  listHistoryFlat,
};
