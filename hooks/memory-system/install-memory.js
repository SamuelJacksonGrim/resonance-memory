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
 * install-memory.js — lay the Resonance memory system down for Claude Code.
 *
 *   node entry.js --install-memory-system --memory-dir <dir> [--apply]
 *
 * Dry-run is the default and writes nothing. --apply copies the folder
 * template (never overwrites a file that is already there), merges the
 * recall hooks into ~/.claude/settings.json, appends the memory block to
 * ~/.claude/CLAUDE.md once, writes ~/.resonance-memory/memory-system.json,
 * copies the Python cabinet package, and full-rebuilds the recall cache.
 *
 * Hook entries are Claude Code exec form (command + args, no shell). The
 * command is this program: the exe when packaged, `node entry.js` from
 * source. Paths the hooks cannot put in the environment live in the config
 * file, which recall.js reads when the flag and the env are both absent.
 *
 * Not an MCP tool.
 */

const fs = require("fs");
const path = require("path");

const recall = require("./recall.js");

const BLOCK_MARKER = "## Memory (the Resonance memory system)";
const POST_MATCHER = "Write|Edit|MultiEdit";
const SKIP_DIRS = new Set([".git", "__pycache__", "node_modules"]);

function isSea() {
  try { return require("node:sea").isSea(); } catch { return false; }
}

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function entryScript() {
  return path.resolve(repoRoot(), "entry.js");
}

function quotePath(p) {
  return "\"" + String(p).replace(/"/g, "\\\"") + "\"";
}

function quoteIfNeeded(p) {
  const s = String(p);
  if (/[\s"]/.test(s)) return quotePath(s);
  return s;
}

function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (typeof v !== "string") continue;
    if (v.trim() === "") continue;
    return v;
  }
  return "";
}

function selfExe() {
  if (isSea()) return { command: process.execPath, args: [] };
  return { command: process.execPath, args: [entryScript()] };
}

function invocationPrefix() {
  const spec = selfExe();
  return quotePath(spec.command) + spec.args.map((a) => " " + quotePath(a)).join("");
}

function hookSpec(flag, timeout, statusMessage) {
  const spec = selfExe();
  return {
    type: "command",
    command: spec.command,
    args: spec.args.concat([flag]),
    timeout: timeout,
    statusMessage: statusMessage,
  };
}

function formatLaunch(spec) {
  return [spec.command].concat(spec.args || []).map(quotePath).join(" ");
}

function hookBlob(h) {
  if (!h || typeof h !== "object") return "";
  const parts = [];
  if (typeof h.command === "string") parts.push(h.command);
  if (Array.isArray(h.args)) parts.push(h.args.join(" "));
  return parts.join(" ");
}

function isRecallHook(h) {
  const blob = hookBlob(h);
  return /--recall-hook\b/.test(blob) || /recall-hook\.(js|ps1)\b/i.test(blob);
}

function isRebuildHook(h) {
  const blob = hookBlob(h);
  return /--rebuild-on-write\b/.test(blob)
    || /rebuild-on-write\.js\b/i.test(blob)
    || /rebuild-on-memory-write\.ps1\b/i.test(blob);
}

function describeHook(h) {
  if (!h || typeof h !== "object") return "(unreadable hook)";
  const args = Array.isArray(h.args) ? h.args.map(String) : [];
  return [h.command == null ? "" : String(h.command)].concat(args).filter((s) => s !== "").join(" ");
}

function readTree(root) {
  if (!root || !fs.existsSync(root)) return null;
  let st;
  try { st = fs.statSync(root); } catch { return null; }
  if (!st.isDirectory()) return null;
  const files = {};
  const dirs = [];
  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (rel) dirs.push(rel);
    for (const ent of entries) {
      if (ent.name === ".DS_Store") continue;
      const child = rel ? rel + "/" + ent.name : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full, child);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(".pyc")) continue;
        files[child] = fs.readFileSync(full, "utf8");
      }
    }
  }
  walk(root, "");
  return { files, dirs };
}

function loadEmbedded() {
  try { return require("../../embedded-assets.js"); }
  catch { return null; }
}

function loadTemplate() {
  const disk = readTree(path.join(repoRoot(), "memory-system", "template"));
  if (disk && Object.keys(disk.files).length) return disk;
  const emb = loadEmbedded();
  const packed = emb && emb.memoryTemplate;
  if (packed && packed.files && Object.keys(packed.files).length) return packed;
  return null;
}

function loadCabinet() {
  const disk = readTree(path.join(repoRoot(), "hooks", "cabinet", "cabinet"));
  if (disk && Object.keys(disk.files).length) return disk;
  const emb = loadEmbedded();
  const packed = emb && emb.cabinetPackage;
  if (packed && packed.files && Object.keys(packed.files).length) return packed;
  return null;
}

function loadClaudeBlock() {
  const diskPath = path.join(repoRoot(), "memory-system", "CLAUDE-memory-block.md");
  if (fs.existsSync(diskPath)) return fs.readFileSync(diskPath, "utf8");
  const emb = loadEmbedded();
  if (emb && typeof emb.claudeMemoryBlock === "string" && emb.claudeMemoryBlock) return emb.claudeMemoryBlock;
  return "";
}

function fillClaudeBlock(template, info) {
  const recallCmd = info.recallPrefix || (invocationPrefix() + " --recall");
  const mem = quoteIfNeeded(info.memoryDir);
  const cab = quoteIfNeeded(info.cabinetDir);
  return String(template)
    .split("node RECALL_JS").join(recallCmd)
    .split("MEMORY_DIR").join(mem)
    .split("CABINET_DIR").join(cab);
}

function isHandMerge(rel) {
  const n = String(rel || "").replace(/\\/g, "/").toLowerCase();
  return n === "memory.md" || n === "memory-architecture.md";
}

function filePlan(tree, destRoot) {
  const rows = [];
  const rels = Object.keys(tree.files).sort();
  for (const rel of rels) {
    const dest = path.join(destRoot, ...rel.split("/"));
    const content = tree.files[rel];
    // A .keep only exists so an empty drawer survives git; a drawer that is already there doesn't need one.
    if (path.basename(dest) === ".keep" && fs.existsSync(path.dirname(dest))) continue;
    let state = "write";
    if (fs.existsSync(dest)) {
      let cur = null;
      try { cur = fs.readFileSync(dest, "utf8"); }
      catch { cur = null; }
      state = cur === content ? "same" : "keep";
    }
    rows.push({ rel, dest, content, state, hand: isHandMerge(rel) });
  }
  return rows;
}

function fileLine(apply, row) {
  if (row.state === "write") return (apply ? "wrote " : "would write ") + row.dest;
  if (row.state === "same") return (apply ? "unchanged " : "would leave ") + row.dest + " (already matches)";
  let s = (apply ? "kept " : "would keep ") + row.dest + " (existing file left in place)";
  if (row.hand) s += "; merge by hand";
  return s;
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return { exists: false, value: null, text: "" };
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (err) { return { exists: true, error: err, text: "" }; }
  const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { exists: true, value: JSON.parse(raw), text };
  } catch (err) {
    return { exists: true, error: err, text };
  }
}

function groupsOk(settings, event) {
  if (!settings.hooks || settings.hooks[event] == null) return "";
  const groups = settings.hooks[event];
  if (!Array.isArray(groups)) return "hooks." + event + " is not an array";
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || typeof g !== "object" || Array.isArray(g)) return "hooks." + event + "[" + i + "] is not an object";
    if (g.hooks != null && !Array.isArray(g.hooks)) return "hooks." + event + "[" + i + "].hooks is not an array";
  }
  return "";
}

function findHook(settings, event, pred) {
  const groups = settings && settings.hooks && settings.hooks[event];
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) if (pred(h)) return h;
  }
  return null;
}

function addCommandHook(settings, event, matcher, hook) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const groups = settings.hooks[event];
  let group = null;
  if (matcher) {
    group = groups.find((g) => g && g.matcher === matcher && Array.isArray(g.hooks));
    if (!group) {
      group = { matcher: matcher, hooks: [] };
      groups.push(group);
    }
  } else {
    group = groups.find((g) => g && (g.matcher == null || g.matcher === "" || g.matcher === "*") && Array.isArray(g.hooks));
    if (!group) {
      group = { hooks: [] };
      groups.push(group);
    }
  }
  group.hooks.push(hook);
}

function usage() {
  return [
    "Usage: --install-memory-system --memory-dir <dir> [--apply]",
    "",
    "  Lays down the Resonance memory system for Claude Code.",
    "  Dry-run is the default: prints the plan and writes nothing.",
    "  --apply copies the template (never overwrites an existing file),",
    "  merges recall hooks into ~/.claude/settings.json (keeps every other",
    "  hook, leaves a .bak), appends the memory block to ~/.claude/CLAUDE.md",
    "  once, writes ~/.resonance-memory/memory-system.json, copies the",
    "  cabinet tools, and full-rebuilds the recall cache.",
    "",
    "  --memory-dir <dir>   Claude Code memory folder (required; no default)",
    "  --cache <file>       Recall cache (default: ~/.resonance-memory/memory-embeddings.json)",
    "  --endpoint <url>     Embedder base URL (default: " + recall.DEFAULT_ENDPOINT + ")",
    "  --model <name>       Embed model (default: " + recall.DEFAULT_MODEL + ")",
    "  --apply              Do it. Without this, nothing is written.",
    "",
    "  Hooks run this same program (--recall-hook, --rebuild-on-write).",
    "  Search by hand with --recall (--query, --rebuild, --history, --plan).",
    "  Cabinet re-index needs Python 3.9+ (python -m cabinet). Not an MCP tool.",
  ].join("\n");
}

function parseInstallArgs(argv) {
  const out = { apply: false, help: false, memoryDir: "", cache: "", endpoint: "", model: "" };
  const args = Array.from(argv || []);
  for (let i = 0; i < args.length; i++) {
    let tok = args[i];
    let inline = null;
    const eq = tok.indexOf("=");
    if (tok.startsWith("-") && eq > 1) {
      inline = tok.slice(eq + 1);
      tok = tok.slice(0, eq);
    }
    const key = tok.replace(/^-+/, "").toLowerCase();
    const need = () => {
      if (inline != null) return inline;
      if (i + 1 >= args.length) throw new Error("Missing value for " + args[i]);
      return args[++i];
    };
    if (tok === "-h" || key === "help") { out.help = true; continue; }
    if (key === "apply") { out.apply = true; continue; }
    if (key === "memory-dir" || key === "memorydir") { out.memoryDir = need(); continue; }
    if (key === "cache") { out.cache = need(); continue; }
    if (key === "endpoint") { out.endpoint = need(); continue; }
    if (key === "model") { out.model = need(); continue; }
    throw new Error("Unknown argument: " + args[i]);
  }
  return out;
}

function absPath(value, cwd) {
  if (!value) return "";
  return path.resolve(cwd, value);
}

function writeUtf8(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
}

function applyFiles(rows) {
  for (const row of rows) {
    if (row.state !== "write") continue;
    writeUtf8(row.dest, row.content);
  }
}

async function installMemorySystem(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const apply = !!o.apply;
  const cwd = o.cwd || process.cwd();
  const lines = [];
  const say = (s) => lines.push(s);
  const blockers = [];

  const home = recall.homeFromEnv(env);
  if (!home) blockers.push("No home directory. Set USERPROFILE or HOME. Nothing written.");

  const memoryDir = absPath(pick(o.memoryDir), cwd);
  if (!memoryDir) blockers.push("Missing --memory-dir. Pass the Claude Code memory folder. Nothing written.");

  const template = loadTemplate();
  const cabinet = loadCabinet();
  const blockRaw = loadClaudeBlock();
  if (!template) blockers.push("Memory template is missing (not on disk and not embedded). Nothing written.");
  if (!cabinet) blockers.push("Cabinet package is missing (not on disk and not embedded). Nothing written.");
  if (!blockRaw) blockers.push("CLAUDE memory block is missing. Nothing written.");

  if (memoryDir && fs.existsSync(memoryDir) && !fs.statSync(memoryDir).isDirectory()) {
    blockers.push(memoryDir + " is not a directory. Nothing written.");
  }

  const cache = absPath(pick(o.cache, env.RECALL_CACHE), cwd)
    || (home ? path.join(home, ".resonance-memory", "memory-embeddings.json") : "");
  const endpoint = pick(o.endpoint, env.RECALL_ENDPOINT, env.EMBED_ENDPOINT, recall.DEFAULT_ENDPOINT);
  const model = pick(o.model, env.RECALL_MODEL, recall.DEFAULT_MODEL);
  const configPath = home ? path.join(home, ".resonance-memory", "memory-system.json") : "";
  const claudeDir = home ? path.join(home, ".claude") : "";
  const settingsPath = claudeDir ? path.join(claudeDir, "settings.json") : "";
  const claudeMdPath = claudeDir ? path.join(claudeDir, "CLAUDE.md") : "";
  const cabinetParent = home ? path.join(home, ".resonance-memory", "cabinet") : "";

  const recallHook = hookSpec("--recall-hook", 15, "recalling memory...");
  const rebuildHook = hookSpec("--rebuild-on-write", 10, "refreshing recall index...");

  say("");
  if (memoryDir) {
    if (!fs.existsSync(memoryDir)) say("would create directory " + memoryDir);
    else if (fs.statSync(memoryDir).isDirectory()) say("memory directory exists: " + memoryDir);
  }
  if (cache) say("cache: " + cache);
  say("endpoint: " + endpoint);
  say("model: " + model);

  const templateRows = template && memoryDir ? filePlan(template, memoryDir) : [];
  for (const row of templateRows) say(fileLine(false, row));

  const cabinetRows = cabinet && cabinetParent ? filePlan(cabinet, path.join(cabinetParent, "cabinet")) : [];
  if (cabinetParent) {
    say("cabinet command dir: " + cabinetParent + " (python -m cabinet; needs Python 3.9+, not checked)");
  }
  for (const row of cabinetRows) say(fileLine(false, row));

  let configWrite = null;
  if (configPath) {
    const loaded = readJsonFile(configPath);
    if (loaded.error) {
      blockers.push(configPath + " is not valid JSON (" + loaded.error.message + "). Nothing written.");
    } else {
      const existing = loaded.exists ? loaded.value : {};
      if (loaded.exists && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
        blockers.push(configPath + " is not a JSON object. Nothing written.");
      } else {
        const next = Object.assign({}, loaded.exists ? existing : {}, {
          memoryDir: memoryDir,
          cache: cache,
          endpoint: endpoint,
          model: model,
        });
        const same = loaded.exists
          && existing.memoryDir === next.memoryDir
          && existing.cache === next.cache
          && existing.endpoint === next.endpoint
          && existing.model === next.model;
        if (same) say("would leave " + configPath + " (already matches)");
        else {
          configWrite = { text: JSON.stringify(next, null, 2) + "\n", backup: loaded.exists };
          say("would write " + configPath + (loaded.exists ? " (backup " + configPath + ".bak)" : ""));
        }
      }
    }
  }

  let settingsWrite = null;
  if (settingsPath) {
    const loaded = readJsonFile(settingsPath);
    if (loaded.error) {
      blockers.push(settingsPath + " is not valid JSON (" + loaded.error.message + "). Nothing written.");
    } else if (loaded.exists && (!loaded.value || typeof loaded.value !== "object" || Array.isArray(loaded.value))) {
      blockers.push(settingsPath + " is not a JSON object. Nothing written.");
    } else {
      const settings = loaded.exists ? JSON.parse(JSON.stringify(loaded.value)) : {};
      if (settings.hooks != null && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
        blockers.push(settingsPath + ": hooks is not an object. Nothing written.");
      } else {
        const badRecall = groupsOk(settings, "UserPromptSubmit");
        const badRebuild = groupsOk(settings, "PostToolUse");
        if (badRecall) blockers.push(settingsPath + ": " + badRecall + ". Nothing written.");
        if (badRebuild) blockers.push(settingsPath + ": " + badRebuild + ". Nothing written.");
        const haveRecall = findHook(settings, "UserPromptSubmit", isRecallHook);
        const haveRebuild = findHook(settings, "PostToolUse", isRebuildHook);
        if (haveRecall) {
          say("UserPromptSubmit already has a recall hook (" + describeHook(haveRecall) + "); not adding another");
        } else if (!badRecall) {
          addCommandHook(settings, "UserPromptSubmit", "", recallHook);
          say("would add UserPromptSubmit: " + formatLaunch(recallHook));
        }
        if (haveRebuild) {
          say("PostToolUse already has a rebuild hook (" + describeHook(haveRebuild) + "); not adding another");
        } else if (!badRebuild) {
          addCommandHook(settings, "PostToolUse", POST_MATCHER, rebuildHook);
          say("would add PostToolUse " + POST_MATCHER + ": " + formatLaunch(rebuildHook));
        }
        if ((!haveRecall || !haveRebuild) && !badRecall && !badRebuild) {
          settingsWrite = {
            text: JSON.stringify(settings, null, 2) + "\n",
            backup: loaded.exists,
          };
          if (loaded.exists) say("would update " + settingsPath + " (backup " + settingsPath + ".bak)");
          else say("would write " + settingsPath);
        } else if (haveRecall && haveRebuild && loaded.exists) {
          say("would leave " + settingsPath + " (hooks already present)");
        }
      }
    }
  }

  let claudeWrite = null;
  let filledBlock = "";
  if (claudeMdPath && blockRaw && memoryDir && cabinetParent) {
    filledBlock = fillClaudeBlock(blockRaw, { memoryDir: memoryDir, cabinetDir: cabinetParent });
    if (!filledBlock.endsWith("\n")) filledBlock += "\n";
    const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : "";
    if (existing.includes(BLOCK_MARKER)) {
      say("would leave " + claudeMdPath + " (memory block already present)");
    } else {
      let base = existing;
      if (base && !base.endsWith("\n")) base += "\n";
      if (base && !base.endsWith("\n\n")) base += "\n";
      claudeWrite = { text: base + filledBlock, backup: !!existing };
      say("would append memory block to " + claudeMdPath
        + (existing ? " (backup " + claudeMdPath + ".bak)" : ""));
    }
  }

  if (cache) {
    say("would full-rebuild " + cache + " (model " + model + " at " + endpoint + ")");
  }

  if (blockers.length) {
    lines[0] = apply ? "refusing to apply; nothing written" : "dry run: nothing will be written";
    for (const b of blockers) say("stopped: " + b);
    return { exitCode: 1, lines, wrote: false };
  }
  lines[0] = apply ? "applying" : "dry run: nothing will be written";
  if (!apply) return { exitCode: 0, lines, wrote: false };

  if (memoryDir) fs.mkdirSync(memoryDir, { recursive: true });
  if (template && template.dirs) {
    for (const d of template.dirs) {
      fs.mkdirSync(path.join(memoryDir, ...d.split("/")), { recursive: true });
    }
  }
  applyFiles(templateRows);
  if (cabinetParent) fs.mkdirSync(path.join(cabinetParent, "cabinet"), { recursive: true });
  applyFiles(cabinetRows);
  if (configWrite) {
    if (configWrite.backup) backup(configPath);
    writeUtf8(configPath, configWrite.text);
  }
  if (settingsWrite) {
    if (settingsWrite.backup) backup(settingsPath);
    writeUtf8(settingsPath, settingsWrite.text);
  }
  if (claudeWrite) {
    if (claudeWrite.backup) backup(claudeMdPath);
    writeUtf8(claudeMdPath, claudeWrite.text);
  }

  const rebuilt = await recall.rebuild({
    memoryDir: memoryDir,
    cache: cache,
    endpoint: endpoint,
    model: model,
    full: true,
    embed: o.embed || null,
    env: env,
    skipConfig: true,
    host: (m) => say(String(m)),
    out: () => {},
  });
  if (!rebuilt || rebuilt.exitCode) {
    say("full rebuild failed; template and hooks were left in place. Re-run --apply when the embedder is up.");
    return { exitCode: 1, lines, wrote: true };
  }
  say("applied");
  return { exitCode: 0, lines, wrote: true };
}

async function main(argv, opts) {
  let args;
  try { args = parseInstallArgs(argv || []); }
  catch (err) {
    console.log(String(err.message || err) + "\n\n" + usage());
    return 1;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const extra = opts || {};
  const result = await installMemorySystem({
    apply: args.apply,
    memoryDir: args.memoryDir,
    cache: args.cache,
    endpoint: args.endpoint,
    model: args.model,
    env: extra.env || process.env,
    embed: extra.embed || null,
    cwd: extra.cwd || process.cwd(),
  });
  if (result.lines && result.lines.length) console.log(result.lines.join("\n"));
  return result.exitCode || 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (err) => {
      process.stderr.write(String(err && err.stack || err) + "\n");
      process.exit(1);
    }
  );
}

module.exports = {
  BLOCK_MARKER,
  POST_MATCHER,
  usage,
  parseInstallArgs,
  hookSpec,
  formatLaunch,
  invocationPrefix,
  isRecallHook,
  isRebuildHook,
  fillClaudeBlock,
  loadTemplate,
  loadCabinet,
  loadClaudeBlock,
  filePlan,
  installMemorySystem,
  main,
};
