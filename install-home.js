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
 * install-home.js — put the packaged program in one folder and keep it there.
 *
 * Connect's MCP config and the two Claude Code memory hooks both record the
 * path of the program that was running. A copy launched from Downloads dies
 * the day that file is deleted. This copies the executable into a per-user
 * folder (no admin), writes a Desktop shortcut (not a second copy), and
 * repoints the configs we own at the installed path.
 *
 * Running from source (node entry.js) never installs. A decline is remembered
 * once. Not an MCP tool.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const MARKER_NAME = "resonance-memory.install.json";
const RECORD_NAME = "install-home.json";
const WARNING = "The installed file has to stay where you put it. Moving or deleting it breaks Connect and the memory hooks until you put the file back. The Desktop shortcut can be moved or deleted freely.";

function detectSea() {
  try { return require("node:sea").isSea(); } catch { return false; }
}

function pkgVersion() {
  try { return require("./package.json").version || "0.0.0"; }
  catch { return "0.0.0"; }
}

// A partial env (unit tests pass one) must not fall through to this process's
// real home. Same rule as hooks/memory-system/recall.js homeFromEnv.
function homeFromEnv(env, platform) {
  const e = env || process.env;
  const plat = platform || process.platform;
  if (plat === "win32") {
    if (e.USERPROFILE) return e.USERPROFILE;
    if (e.HOMEDRIVE && e.HOMEPATH) return e.HOMEDRIVE + e.HOMEPATH;
    if (e.HOME) return e.HOME;
  } else {
    if (e.HOME) return e.HOME;
    if (e.USERPROFILE) return e.USERPROFILE;
  }
  if (e !== process.env) return "";
  try { return os.homedir() || ""; } catch { return ""; }
}

function pathFor(platform) {
  return (platform || process.platform) === "win32" ? path.win32 : path.posix;
}

function exeName(platform) {
  return (platform || process.platform) === "win32" ? "resonance-memory.exe" : "resonance-memory";
}

function shortcutKind(platform) {
  const plat = platform || process.platform;
  if (plat === "win32") return "lnk";
  if (plat === "darwin") return "symlink";
  return "desktop";
}

// Per-user, no admin, and not inside ~/.resonance-memory (that folder is the
// memories). Windows: the per-user Programs dir. macOS: ~/Applications, which
// is where a person expects an installed program, not a dot-folder mixed with
// the database. Linux: ~/.local/bin, the XDG user bin, already on PATH for
// most desktop sessions, and still outside the data directory.
function defaultInstallDir(env, platform) {
  const plat = platform || process.platform;
  const p = pathFor(plat);
  const home = homeFromEnv(env, plat);
  if (!home) return "";
  if (plat === "win32") {
    const local = (env && env.LOCALAPPDATA) || p.join(home, "AppData", "Local");
    return p.join(local, "Programs", "Resonance Memory");
  }
  if (plat === "darwin") return p.join(home, "Applications", "Resonance Memory");
  return p.join(home, ".local", "bin");
}

function dataDir(env, platform) {
  const home = homeFromEnv(env, platform);
  if (!home) return "";
  return pathFor(platform || process.platform).join(home, ".resonance-memory");
}

function recordPath(env, platform) {
  const dir = dataDir(env, platform);
  if (!dir) return "";
  return pathFor(platform || process.platform).join(dir, RECORD_NAME);
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch { return null; }
}

function readRecord(env, platform) {
  const file = recordPath(env, platform);
  if (!file) return null;
  return readJson(file);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + ".bak"); } catch { /* the new note still has to land */ }
  }
  fs.writeFileSync(file, text, "utf8");
}

function writeRecord(env, platform, value) {
  const file = recordPath(env, platform);
  if (!file) {
    const err = new Error("No home directory is set, so there is nowhere to record the install.");
    err.code = "no_home";
    throw err;
  }
  writeJson(file, value);
  return file;
}

function markerPath(exe) {
  if (!exe) return "";
  return path.join(path.dirname(exe), MARKER_NAME);
}

function hasMarker(exe) {
  const file = markerPath(exe);
  if (!file || !fs.existsSync(file)) return false;
  const marker = readJson(file);
  return !!(marker && marker.installed === true && typeof marker.version === "string");
}

function readMarkerVersion(exe) {
  const marker = readJson(markerPath(exe));
  if (!marker || marker.installed !== true || typeof marker.version !== "string") return "";
  return marker.version;
}

function cmpVersion(a, b) {
  const pa = String(a || "0").split(".").map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pb = String(b || "0").split(".").map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

function fileExists(file) {
  try { return !!file && fs.statSync(file).isFile(); } catch { return false; }
}

function samePath(a, b, platform) {
  if (!a || !b) return false;
  const p = pathFor(platform || process.platform);
  const na = p.resolve(a);
  const nb = p.resolve(b);
  if ((platform || process.platform) === "win32") return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

function sameFile(a, b) {
  if (!a || !b) return false;
  if (samePath(a, b)) return true;
  try {
    const ra = fs.realpathSync.native ? fs.realpathSync.native(a) : fs.realpathSync(a);
    const rb = fs.realpathSync.native ? fs.realpathSync.native(b) : fs.realpathSync(b);
    if (process.platform === "win32") return ra.toLowerCase() === rb.toLowerCase();
    return ra === rb;
  } catch { return false; }
}

// Known-folder Desktop follows OneDrive redirection. It does NOT follow a
// test's USERPROFILE. Only the live process, and only when the panel is
// allowed to open a browser, may ask. Tests set RESONANCE_MEMORY_NO_OPEN=1
// and pass their own env object, so they get <temp home>/Desktop.
function knownDesktop() {
  if (process.platform !== "win32") return "";
  if (process.env.RESONANCE_MEMORY_NO_OPEN === "1") return "";
  const exe = powershellExe();
  if (!exe) return "";
  let r;
  try {
    r = spawnSync(exe, [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command", "[Environment]::GetFolderPath('Desktop')",
    ], { windowsHide: true, encoding: "utf8", timeout: 8000 });
  } catch { return ""; }
  if (!r || r.status !== 0) return "";
  const line = String(r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return "";
  try { if (!fs.statSync(line).isDirectory()) return ""; } catch { return ""; }
  return line;
}

function desktopDir(env, platform) {
  const e = env || process.env;
  const plat = platform || process.platform;
  if (e.RESONANCE_MEMORY_DESKTOP) return e.RESONANCE_MEMORY_DESKTOP;
  if (e === process.env && e.RESONANCE_MEMORY_NO_OPEN !== "1") {
    const known = knownDesktop();
    if (known) return known;
  }
  const home = homeFromEnv(e, plat);
  if (!home) return "";
  return pathFor(plat).join(home, "Desktop");
}

function shortcutPathFor(env, platform) {
  const plat = platform || process.platform;
  const desk = desktopDir(env, plat);
  if (!desk) return "";
  const p = pathFor(plat);
  if (plat === "win32") return p.join(desk, "Resonance Memory.lnk");
  if (plat === "linux") return p.join(desk, "Resonance Memory.desktop");
  return p.join(desk, "Resonance Memory");
}

function isAbsoluteInput(input, platform) {
  const s = String(input || "").trim();
  if ((platform || process.platform) === "win32") return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s);
  return s.startsWith("/");
}

function normalizeInstallDir(input, platform) {
  const plat = platform || process.platform;
  let d = String(input || "").trim();
  if (!d) return "";
  const p = pathFor(plat);
  const name = exeName(plat);
  if (p.basename(d).toLowerCase() === name.toLowerCase()) d = p.dirname(d);
  return p.resolve(d);
}

function insideDir(parent, child, platform) {
  if (!parent || !child) return false;
  const p = pathFor(platform || process.platform);
  const root = p.resolve(parent);
  const target = p.resolve(child);
  const rel = p.relative(root, target);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (p.isAbsolute(rel)) return false;
  return true;
}

function validateDir(input, env, platform) {
  const plat = platform || process.platform;
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "Type a folder. The program file will go inside it." };
  if (/[\r\n\0]/.test(raw)) return { ok: false, error: "That folder path is not usable." };
  if (!isAbsoluteInput(raw, plat)) {
    const hint = plat === "win32"
      ? "Use a full path, starting with a drive letter."
      : "Use a full path, starting with /.";
    return { ok: false, error: hint };
  }
  let dir;
  try { dir = normalizeInstallDir(raw, plat); }
  catch { return { ok: false, error: "That folder path could not be read." }; }
  if (!dir) return { ok: false, error: "Type a folder. The program file will go inside it." };
  const p = pathFor(plat);
  if (p.dirname(dir) === dir) {
    return { ok: false, error: "That is the whole disk. Pick a folder inside it." };
  }
  const data = dataDir(env, plat);
  if (data && (insideDir(data, dir, plat) || samePath(dir, data, plat))) {
    return {
      ok: false,
      error: "That folder is where your memories are stored. Pick a different folder so removing the program cannot delete them.",
    };
  }
  return { ok: true, dir: dir };
}

// Test seam, and only then. A normal double-click does not set
// RESONANCE_MEMORY_NO_OPEN, so this cannot fire on a real launch.
// RESONANCE_MEMORY_ASSUME_SEA alone does nothing; the source file has to
// be named too. The CLI does not consult this.
function runtimeFromEnv(env) {
  const e = env || process.env;
  const version = pkgVersion();
  const source = e.RESONANCE_MEMORY_INSTALL_SOURCE;
  const seam = e.RESONANCE_MEMORY_NO_OPEN === "1"
    && e.RESONANCE_MEMORY_ASSUME_SEA === "1"
    && source
    && fileExists(source);
  if (seam) return { isSea: true, sourceExe: path.resolve(source), version: version };
  return { isSea: detectSea(), sourceExe: process.execPath, version: version };
}

function stableCommand(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const sea = o.isSea != null ? !!o.isSea : detectSea();
  const exe = o.sourceExe || process.execPath;
  if (!sea) return "";
  if (hasMarker(exe)) return path.resolve(exe);
  const rec = readRecord(env, platform);
  if (rec && rec.declined && !(rec.exe && fileExists(rec.exe))) return "";
  if (rec && rec.exe && fileExists(rec.exe)) return path.resolve(rec.exe);
  return "";
}

function inspect(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const runtime = o.isSea == null && o.sourceExe == null ? runtimeFromEnv(env) : null;
  const sea = o.isSea != null ? !!o.isSea : (runtime ? runtime.isSea : detectSea());
  const sourceExe = o.sourceExe || (runtime ? runtime.sourceExe : process.execPath);
  const version = o.version || (runtime ? runtime.version : pkgVersion());
  const home = homeFromEnv(env, platform);
  const record = readRecord(env, platform);
  const def = defaultInstallDir(env, platform);
  const base = {
    isSea: sea,
    version: version,
    defaultDir: def,
    suggestedDir: def,
    home: home || "",
    warning: WARNING,
    shortcutDefault: true,
    exeName: exeName(platform),
    platform: platform,
    shortcutPath: shortcutPathFor(env, platform),
  };
  if (!sea) return Object.assign(base, { mode: "source" });
  if (hasMarker(sourceExe)) {
    const exe = path.resolve(sourceExe);
    return Object.assign(base, {
      mode: "home",
      exe: exe,
      dir: path.dirname(exe),
      installedVersion: readMarkerVersion(exe) || version,
    });
  }
  const installedExe = record && record.exe && fileExists(record.exe) ? path.resolve(record.exe) : "";
  if (!installedExe && record && record.declined) {
    return Object.assign(base, { mode: "declined" });
  }
  if (installedExe) {
    const instVer = readMarkerVersion(installedExe) || (record && record.version) || "0.0.0";
    const cmp = cmpVersion(version, instVer);
    const dir = path.dirname(installedExe);
    if (cmp > 0) {
      return Object.assign(base, {
        mode: "update",
        exe: installedExe,
        dir: dir,
        installedVersion: instVer,
        suggestedDir: dir,
        shortcut: record.shortcut || "",
      });
    }
    return Object.assign(base, {
      mode: "spare",
      exe: installedExe,
      dir: dir,
      installedVersion: instVer,
      newerInstalled: cmp < 0,
      suggestedDir: dir,
      shortcut: record.shortcut || "",
    });
  }
  const suggested = (record && record.dir) || def;
  return Object.assign(base, { mode: "offer", suggestedDir: suggested });
}

function finishUnixBits(dest, execFileSyncFn) {
  if (process.platform === "win32") return { quarantine: { ok: true, skipped: true } };
  try { fs.chmodSync(dest, 0o755); } catch { /* reported by the caller if the file is missing */ }
  if (process.platform !== "darwin") return { quarantine: { ok: true, skipped: true } };
  const exec = execFileSyncFn || require("child_process").execFileSync;
  try {
    exec("xattr", ["-d", "com.apple.quarantine", dest], { stdio: "ignore" });
    return { quarantine: { ok: true, cleared: true } };
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || err);
    if (err && (err.status === 1 || /No such xattr|attribute not found/i.test(msg))) {
      return { quarantine: { ok: true, cleared: false } };
    }
    return { quarantine: { ok: false, error: msg } };
  }
}

// Copy src onto dest. On Windows a running exe cannot be overwritten, but it
// can usually be renamed. Rename the live file to <dest>.old, put the new
// bytes at dest, and leave .old for a later launch to delete. On macOS and
// Linux, rename the new file over the old one (the running process keeps the
// old inode). Injected hooks are for tests.
function placeExe(src, dest, hooks) {
  const h = hooks || {};
  const copy = h.copyFileSync || fs.copyFileSync.bind(fs);
  const rename = h.renameSync || fs.renameSync.bind(fs);
  const unlink = h.unlinkSync || fs.unlinkSync.bind(fs);
  const exists = h.existsSync || fs.existsSync.bind(fs);
  if (!src || !exists(src)) {
    const err = new Error("The program file to install was not found.");
    err.code = "no_source";
    throw err;
  }
  if (sameFile(src, dest)) return { ok: true, same: true, replaced: false, leftOld: false };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const staging = dest + ".new";
  try { if (exists(staging)) unlink(staging); } catch { /* a leftover .new from a crash */ }
  copy(src, staging);
  if (process.platform !== "win32") {
    try { fs.chmodSync(staging, 0o755); } catch { /* */ }
  }
  const existed = exists(dest);
  let leftOld = false;
  let oldName = "";
  if (process.platform === "win32" && existed) {
    let old = dest + ".old";
    if (exists(old)) {
      try { unlink(old); }
      catch { old = dest + ".old-" + Date.now(); }
    }
    try {
      rename(dest, old);
      leftOld = true;
      oldName = old;
    } catch (err) {
      try { unlink(staging); } catch { /* */ }
      const e = new Error("The installed copy is open and could not be replaced. Close Claude, LM Studio, and Claude Code, then try again.");
      e.code = "locked";
      e.cause = err;
      throw e;
    }
  }
  try {
    rename(staging, dest);
  } catch (err) {
    if (leftOld && oldName) {
      try { rename(oldName, dest); } catch { /* best effort restore */ }
    }
    try { if (exists(staging)) unlink(staging); } catch { /* */ }
    if (process.platform !== "win32") {
      const e = new Error("The installed copy is open and could not be replaced. Close the program that is using it, then try again.");
      e.code = "locked";
      e.cause = err;
      throw e;
    }
    throw err;
  }
  const bits = finishUnixBits(dest, h.execFileSync);
  return { ok: true, same: false, replaced: !!(existed || leftOld), leftOld: leftOld, quarantine: bits.quarantine };
}

function cleanupOld(exe) {
  if (!exe || !hasMarker(exe)) return false;
  const dir = path.dirname(exe);
  const base = path.basename(exe);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return false; }
  let removed = false;
  for (const name of names) {
    if (name !== base + ".old" && name.indexOf(base + ".old-") !== 0 && name !== base + ".new") continue;
    try { fs.unlinkSync(path.join(dir, name)); removed = true; }
    catch { /* still mapped by the process we renamed out of the way */ }
  }
  return removed;
}

function powershellExe() {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidate = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(candidate)) return candidate;
  return "powershell.exe";
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function writeWindowsShortcut(lnkPath, target, workDir) {
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    "$s = $ws.CreateShortcut(" + psQuote(lnkPath) + ")",
    "$s.TargetPath = " + psQuote(target),
    "$s.WorkingDirectory = " + psQuote(workDir),
    "$s.WindowStyle = 1",
    "$s.Description = " + psQuote("Resonance Memory"),
    "$s.Save()",
  ].join("; ");
  const r = spawnSync(powershellExe(), [
    "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps,
  ], { windowsHide: true, encoding: "utf8", timeout: 20000 });
  if (r.error) throw r.error;
  if (r.status !== 0 || !fs.existsSync(lnkPath)) {
    throw new Error("Could not create the Desktop shortcut. " + String(r.stderr || r.stdout || ("exit " + r.status)).trim());
  }
}

function desktopFileText(target, workDir) {
  const execLine = /[\s"]/.test(target) ? JSON.stringify(target) : target;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Resonance Memory",
    "Comment=A local memory for your AI",
    "Exec=" + execLine,
    "Path=" + workDir,
    "Terminal=false",
    "Categories=Utility;",
    "X-Resonance-Memory=install-home",
    "",
  ].join("\n");
}

function isOurDesktopFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return /X-Resonance-Memory=install-home/.test(text);
  } catch { return false; }
}

function writeShortcut(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const dest = o.shortcutPath;
  const target = o.target;
  if (!dest || !target) {
    const err = new Error("No Desktop folder to put the shortcut in.");
    err.code = "no_desktop";
    throw err;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const kind = shortcutKind(platform);
    let ours = false;
    if (kind === "desktop") ours = isOurDesktopFile(dest);
    else if (kind === "symlink") {
      try { ours = fs.lstatSync(dest).isSymbolicLink(); } catch { ours = false; }
    } else if (o.replaceExisting) ours = true;
    if (!ours && !o.replaceExisting) {
      const err = new Error("Something is already on the Desktop where the shortcut would go. Move that file, or install without the shortcut. Nothing there was deleted.");
      err.code = "shortcut_exists";
      throw err;
    }
    fs.rmSync(dest, { recursive: false, force: true });
  }
  const kind = shortcutKind(platform);
  if (kind === "lnk") {
    writeWindowsShortcut(dest, target, o.workDir || path.dirname(target));
    return { path: dest, kind: kind };
  }
  if (kind === "desktop") {
    fs.writeFileSync(dest, desktopFileText(target, o.workDir || path.dirname(target)), "utf8");
    try { fs.chmodSync(dest, 0o755); } catch { /* */ }
    return { path: dest, kind: kind };
  }
  fs.symlinkSync(target, dest);
  return { path: dest, kind: kind };
}

function clientConfigs(env, platform) {
  const e = env || process.env;
  const plat = platform || process.platform;
  if (e.RESONANCE_MEMORY_CONFIGS_JSON) {
    try {
      const parsed = JSON.parse(e.RESONANCE_MEMORY_CONFIGS_JSON);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through to the known paths */ }
  }
  const home = homeFromEnv(e, plat);
  if (!home) return [];
  const p = pathFor(plat);
  const appdata = e.APPDATA || p.join(home, "AppData", "Roaming");
  const list = [{ id: "lmstudio", name: "LM Studio", file: p.join(home, ".lmstudio", "mcp.json") }];
  if (plat === "win32") {
    list.push({ id: "claude", name: "Claude Desktop", file: p.join(appdata, "Claude", "claude_desktop_config.json") });
  } else if (plat === "darwin") {
    list.push({
      id: "claude",
      name: "Claude Desktop",
      file: p.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    });
  } else {
    list.push({ id: "claude", name: "Claude Desktop", file: p.join(home, ".config", "Claude", "claude_desktop_config.json") });
  }
  return list;
}

function backupFile(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
}

function repointMcp(env, platform, exe) {
  const results = [];
  const warnings = [];
  const launch = { command: exe, args: ["--mcp"] };
  for (const c of clientConfigs(env, platform)) {
    if (!c || !c.file || !fs.existsSync(c.file)) continue;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(c.file, "utf8")); }
    catch (err) {
      warnings.push(c.file + " is not valid JSON, so it was left alone.");
      continue;
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      warnings.push(c.file + " is not a JSON object, so it was left alone.");
      continue;
    }
    if (!cfg.mcpServers || typeof cfg.mcpServers !== "object" || !cfg.mcpServers["resonance-memory"]) {
      continue;
    }
    const cur = cfg.mcpServers["resonance-memory"];
    if (cur && cur.command === launch.command && Array.isArray(cur.args) && cur.args.length === 1 && cur.args[0] === "--mcp") {
      results.push({ id: c.id, name: c.name, file: c.file, action: "already" });
      continue;
    }
    cfg.mcpServers["resonance-memory"] = launch;
    try {
      backupFile(c.file);
      fs.writeFileSync(c.file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      results.push({ id: c.id, name: c.name, file: c.file, action: "repointed" });
    } catch (err) {
      warnings.push("Could not update " + c.file + ": " + String(err && err.message || err));
    }
  }
  return { results: results, warnings: warnings };
}

function disconnectMcp(env, platform) {
  const results = [];
  const warnings = [];
  for (const c of clientConfigs(env, platform)) {
    if (!c || !c.file || !fs.existsSync(c.file)) {
      results.push({ id: c && c.id, name: c && c.name, action: "not-present" });
      continue;
    }
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(c.file, "utf8")); }
    catch (err) {
      warnings.push(c.file + " is not valid JSON, so it was left alone.");
      results.push({ id: c.id, name: c.name, file: c.file, action: "skipped" });
      continue;
    }
    if (!cfg || typeof cfg !== "object" || !cfg.mcpServers || !cfg.mcpServers["resonance-memory"]) {
      results.push({ id: c.id, name: c.name, file: c.file, action: "not-connected" });
      continue;
    }
    delete cfg.mcpServers["resonance-memory"];
    try {
      backupFile(c.file);
      fs.writeFileSync(c.file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      results.push({ id: c.id, name: c.name, file: c.file, action: "disconnected" });
    } catch (err) {
      warnings.push("Could not update " + c.file + ": " + String(err && err.message || err));
    }
  }
  return { results: results, warnings: warnings };
}

function settingsPath(env, platform) {
  const home = homeFromEnv(env, platform);
  if (!home) return "";
  return pathFor(platform || process.platform).join(home, ".claude", "settings.json");
}

function loadHookPreds() {
  const mem = require("./hooks/memory-system/install-memory.js");
  return { isRecallHook: mem.isRecallHook, isRebuildHook: mem.isRebuildHook };
}

function eachOwnedHook(settings, pred, fn) {
  if (!settings || !settings.hooks || typeof settings.hooks !== "object") return 0;
  let n = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (pred(h)) { fn(h, event); n++; }
      }
    }
  }
  return n;
}

function repointHooks(env, platform, exe) {
  const warnings = [];
  const file = settingsPath(env, platform);
  if (!file || !fs.existsSync(file)) return { changed: 0, file: file, warnings: warnings };
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) {
    warnings.push(file + " is not valid JSON, so the memory hooks were left alone.");
    return { changed: 0, file: file, warnings: warnings };
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    warnings.push(file + " is not a JSON object, so the memory hooks were left alone.");
    return { changed: 0, file: file, warnings: warnings };
  }
  let preds;
  try { preds = loadHookPreds(); }
  catch (err) {
    warnings.push("Could not read the hook matcher: " + String(err && err.message || err));
    return { changed: 0, file: file, warnings: warnings };
  }
  const jobs = [
    [preds.isRecallHook, "--recall-hook"],
    [preds.isRebuildHook, "--rebuild-on-write"],
  ];
  let changed = 0;
  for (const [pred, flag] of jobs) {
    eachOwnedHook(settings, pred, (h) => {
      const args = Array.isArray(h.args) ? h.args.map(String) : [];
      if (h.command === exe && args.length === 1 && args[0] === flag) return;
      h.type = "command";
      h.command = exe;
      h.args = [flag];
      changed++;
    });
  }
  if (!changed) return { changed: 0, file: file, warnings: warnings };
  try {
    backupFile(file);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch (err) {
    warnings.push("Could not update " + file + ": " + String(err && err.message || err));
    return { changed: 0, file: file, warnings: warnings };
  }
  return { changed: changed, file: file, warnings: warnings };
}

function removeOwnedHooks(env, platform) {
  const warnings = [];
  const file = settingsPath(env, platform);
  if (!file || !fs.existsSync(file)) return { removed: 0, file: file, warnings: warnings };
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch {
    warnings.push(file + " is not valid JSON, so the memory hooks were left alone.");
    return { removed: 0, file: file, warnings: warnings };
  }
  if (!settings || typeof settings !== "object" || !settings.hooks) {
    return { removed: 0, file: file, warnings: warnings };
  }
  let preds;
  try { preds = loadHookPreds(); }
  catch (err) {
    warnings.push("Could not read the hook matcher: " + String(err && err.message || err));
    return { removed: 0, file: file, warnings: warnings };
  }
  const owned = (h) => preds.isRecallHook(h) || preds.isRebuildHook(h);
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const nextGroups = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { nextGroups.push(g); continue; }
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !owned(h));
      removed += before - g.hooks.length;
      if (g.hooks.length) nextGroups.push(g);
    }
    if (nextGroups.length) settings.hooks[event] = nextGroups;
    else delete settings.hooks[event];
  }
  if (!removed) return { removed: 0, file: file, warnings: warnings };
  try {
    backupFile(file);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch (err) {
    warnings.push("Could not update " + file + ": " + String(err && err.message || err));
    return { removed: 0, file: file, warnings: warnings };
  }
  return { removed: removed, file: file, warnings: warnings };
}

function uninstallBatText() {
  return [
    "@echo off",
    "echo.",
    "echo   Resonance Memory - uninstall",
    "echo   -------------------------",
    "echo   Disconnecting from your AI apps and removing the Desktop shortcut.",
    "echo   Your memories are not deleted.",
    "echo.",
    "\"%~dp0resonance-memory.exe\" --uninstall-app",
    "set ERR=%ERRORLEVEL%",
    "echo.",
    "if exist \"%~dp0resonance-memory.exe\" del /f \"%~dp0resonance-memory.exe\" >nul 2>&1",
    "if exist \"%~dp0resonance-memory.exe.old\" del /f \"%~dp0resonance-memory.exe.old\" >nul 2>&1",
    "if exist \"%~dp0resonance-memory.install.json\" del /f \"%~dp0resonance-memory.install.json\" >nul 2>&1",
    "echo.",
    "echo   Done. Resonance Memory is disconnected from your apps.",
    "echo.",
    "echo   Your saved memories were NOT deleted. They live here (SQLite default):",
    "echo     \"%USERPROFILE%\\.resonance-memory\\resonance-memory.db\"",
    "echo   If you pinned JSONL (or an older install), also look for:",
    "echo     \"%USERPROFILE%\\.resonance-memory\\resonance-memory.jsonl\"",
    "echo     (and the small .edges.json / .access.json companions beside it,",
    "echo      plus a leftover .assoc.json if an older build wrote one.)",
    "echo   An older build stored the same files under:",
    "echo     \"%USERPROFILE%\\.lmstudio\\\"",
    "echo   (copied to the new folder on first start; the original is left as a backup.)",
    "echo   Delete those yourself if you also want to erase your memories.",
    "echo.",
    "echo   The Desktop shortcut is only a pointer. Deleting it does not uninstall,",
    "echo   and deleting it is safe. The installed program file is the one that",
    "echo   must stay put; this script removes it after disconnecting.",
    "echo   You can now delete this folder to remove any leftover program files.",
    "echo.",
    "if not \"%ERR%\"==\"0\" echo   Uninstall reported a problem. Close Claude, LM Studio, and Claude Code, then run this again.",
    "echo.",
    "pause",
    "",
  ].join("\r\n");
}

function writeMarker(exe, version) {
  const file = markerPath(exe);
  fs.writeFileSync(file, JSON.stringify({
    installed: true,
    version: version,
    exe: path.basename(exe),
  }, null, 2) + "\n", "utf8");
  return file;
}

function installApp(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const sea = o.isSea != null ? !!o.isSea : detectSea();
  const sourceExe = o.sourceExe || process.execPath;
  const version = o.version || pkgVersion();
  const warnings = [];
  if (!sea) {
    return {
      ok: false,
      code: "source",
      wrote: false,
      warnings: warnings,
      error: "This is a source checkout (node entry.js), not the packaged program. Install copies the executable into a fixed folder. Run the downloaded resonance-memory program instead. Nothing was written.",
    };
  }
  if (!fileExists(sourceExe)) {
    return { ok: false, code: "no_source", wrote: false, warnings: warnings, error: "The program file to install was not found." };
  }
  const status = inspect({ env: env, platform: platform, isSea: true, sourceExe: sourceExe, version: version });
  let action = o.action || (status.mode === "update" ? "update" : "install");
  if (status.mode === "home" || sameFile(sourceExe, status.exe || "")) {
    return {
      ok: true,
      action: "home",
      wrote: false,
      exe: status.exe || path.resolve(sourceExe),
      dir: status.dir || path.dirname(sourceExe),
      version: version,
      warnings: warnings,
      message: "Already running from the installed copy.",
    };
  }
  if (status.mode === "spare" && status.newerInstalled) {
    return {
      ok: false,
      code: "newer_installed",
      wrote: false,
      exe: status.exe,
      dir: status.dir,
      warnings: warnings,
      error: "The installed copy is newer (" + status.installedVersion + "). This one is " + version + ". Nothing was written.",
    };
  }
  if (status.mode === "spare" && action !== "update") {
    return {
      ok: true,
      action: "spare",
      wrote: false,
      exe: status.exe,
      dir: status.dir,
      version: status.installedVersion,
      warnings: warnings,
      message: "Already installed at " + status.exe + ". Nothing was copied.",
    };
  }
  if (status.mode === "update") action = "update";
  let dir = status.mode === "update" ? status.dir : "";
  if (action !== "update") {
    const wanted = o.dir ? String(o.dir) : (status.suggestedDir || status.defaultDir);
    const checked = validateDir(wanted, env, platform);
    if (!checked.ok) return { ok: false, code: "bad_dir", wrote: false, warnings: warnings, error: checked.error };
    dir = checked.dir;
  }
  if (status.mode === "update" && o.dir) {
    const checked = validateDir(o.dir, env, platform);
    if (checked.ok && !samePath(checked.dir, status.dir, platform)) {
      return {
        ok: false,
        code: "already_installed",
        wrote: false,
        exe: status.exe,
        dir: status.dir,
        warnings: warnings,
        error: "Already installed at " + status.dir + ". Updating replaces that file so Connect and the hooks stay pointed at it. Run again without a different folder, or uninstall first to install somewhere else. Nothing was written.",
      };
    }
  }
  const dest = path.join(dir, exeName(platform));
  let placed;
  try {
    placed = placeExe(sourceExe, dest, o.hooks);
  } catch (err) {
    return {
      ok: false,
      code: err && err.code || "place_failed",
      wrote: false,
      warnings: warnings,
      error: String(err && err.message || err),
    };
  }
  const bits = placed.quarantine;
  if (bits && bits.ok === false) warnings.push("Could not clear the macOS quarantine flag: " + bits.error);
  try { writeMarker(dest, version); }
  catch (err) {
    return {
      ok: false,
      code: "marker",
      wrote: true,
      exe: dest,
      dir: dir,
      warnings: warnings,
      error: "The program was copied, but the install marker could not be written: " + String(err && err.message || err),
    };
  }
  if (process.platform === "win32" && platform === "win32") {
    try { fs.writeFileSync(path.join(dir, "uninstall.bat"), uninstallBatText(), "utf8"); }
    catch (err) { warnings.push("Could not write uninstall.bat: " + String(err && err.message || err)); }
  }
  let shortcut = "";
  const wantShortcut = o.shortcut !== false && !o.noShortcut;
  if (wantShortcut) {
    const link = shortcutPathFor(env, platform);
    try {
      const written = writeShortcut({
        platform: platform,
        shortcutPath: link,
        target: dest,
        workDir: dir,
        replaceExisting: !!(status.shortcut && samePath(status.shortcut, link, platform)),
      });
      shortcut = written.path;
    } catch (err) {
      warnings.push(String(err && err.message || err));
    }
  }
  try {
    writeRecord(env, platform, {
      exe: dest,
      dir: dir,
      version: version,
      shortcut: shortcut || (status.shortcut || ""),
      declined: false,
    });
  } catch (err) {
    warnings.push(String(err && err.message || err));
  }
  const mcp = repointMcp(env, platform, dest);
  const hooks = repointHooks(env, platform, dest);
  warnings.push.apply(warnings, mcp.warnings);
  warnings.push.apply(warnings, hooks.warnings);
  return {
    ok: true,
    action: action === "update" || status.mode === "update" ? "update" : "install",
    wrote: true,
    exe: dest,
    dir: dir,
    version: version,
    shortcut: shortcut,
    leftOld: !!placed.leftOld,
    replaced: !!placed.replaced,
    mcp: mcp.results,
    hooks: hooks.changed,
    warnings: warnings,
    message: action === "update" || status.mode === "update"
      ? "Updated the installed copy. Connect and the memory hooks still point at that folder. Restart the AI app so it loads this version."
      : "Installed. Connect and the memory hooks now point at that copy.",
  };
}

function declineInstall(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const sea = o.isSea != null ? !!o.isSea : detectSea();
  if (!sea) {
    return {
      ok: false,
      code: "source",
      wrote: false,
      error: "This is a source checkout. Nothing was written.",
    };
  }
  const status = inspect(o);
  if (status.mode !== "offer") {
    return { ok: true, action: "decline", wrote: false, mode: status.mode, message: "Nothing changed." };
  }
  writeRecord(env, platform, { declined: true, warned: true });
  return { ok: true, action: "decline", wrote: true, mode: "declined" };
}

function removeInstalledFiles(record, sourceExe) {
  const warnings = [];
  const removed = [];
  if (!record) return { removed: removed, warnings: warnings };
  const exe = record.exe || "";
  const marker = exe ? markerPath(exe) : "";
  const leftovers = [];
  if (exe) leftovers.push(exe + ".old", exe + ".new");
  if (marker) leftovers.push(marker);
  if (exe && !sameFile(exe, sourceExe || process.execPath)) leftovers.unshift(exe);
  else if (exe && sameFile(exe, sourceExe || process.execPath)) {
    warnings.push("This is the installed program, so it could not delete itself. Delete this file after the window closes: " + exe);
  }
  for (const file of leftovers) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const st = fs.lstatSync(file);
      if (st.isDirectory()) continue;
      fs.unlinkSync(file);
      removed.push(file);
    } catch (err) {
      warnings.push("Could not delete " + file + ". Close Claude, LM Studio, and Claude Code, then delete it. (" + String(err && err.message || err) + ")");
    }
  }
  if (record.dir && record.exe && !sameFile(path.dirname(sourceExe || ""), record.dir)) {
    const bat = path.join(record.dir, "uninstall.bat");
    if (fs.existsSync(bat)) {
      try { fs.unlinkSync(bat); removed.push(bat); }
      catch (err) { warnings.push("Could not delete " + bat + ": " + String(err && err.message || err)); }
    }
  }
  return { removed: removed, warnings: warnings };
}

function removeShortcut(record, env, platform) {
  const warnings = [];
  const target = (record && record.shortcut) || "";
  if (!target) return { removed: false, warnings: warnings };
  const expected = shortcutPathFor(env, platform);
  if (expected && !samePath(target, expected, platform)) {
    warnings.push("The recorded shortcut is not the Desktop shortcut this installer creates, so it was left alone: " + target);
    return { removed: false, warnings: warnings };
  }
  if (!fs.existsSync(target)) return { removed: false, warnings: warnings };
  const kind = shortcutKind(platform);
  let ours = false;
  if (kind === "lnk") ours = true;
  else if (kind === "desktop") ours = isOurDesktopFile(target);
  else {
    try { ours = fs.lstatSync(target).isSymbolicLink(); } catch { ours = false; }
  }
  if (!ours) {
    warnings.push("The Desktop file is not the shortcut this installer created, so it was left alone.");
    return { removed: false, warnings: warnings };
  }
  try {
    fs.unlinkSync(target);
    return { removed: true, warnings: warnings };
  } catch (err) {
    warnings.push("Could not delete the shortcut: " + String(err && err.message || err));
    return { removed: false, warnings: warnings };
  }
}

function uninstallApp(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const sourceExe = o.sourceExe || process.execPath;
  const warnings = [];
  const record = readRecord(env, platform);
  const mcp = disconnectMcp(env, platform);
  const hooks = removeOwnedHooks(env, platform);
  warnings.push.apply(warnings, mcp.warnings);
  warnings.push.apply(warnings, hooks.warnings);
  const shortcut = removeShortcut(record, env, platform);
  warnings.push.apply(warnings, shortcut.warnings);
  const files = removeInstalledFiles(record, sourceExe);
  warnings.push.apply(warnings, files.warnings);
  const recFile = recordPath(env, platform);
  if (recFile && fs.existsSync(recFile)) {
    try { fs.unlinkSync(recFile); }
    catch (err) { warnings.push("Could not remove the install note: " + String(err && err.message || err)); }
  }
  // The .bak of the install note is not a memory. Leave it; it is one small file.
  return {
    ok: warnings.length === 0,
    action: "uninstall-app",
    wrote: true,
    memories: "untouched",
    mcp: mcp.results,
    hooksRemoved: hooks.removed,
    shortcutRemoved: shortcut.removed,
    filesRemoved: files.removed,
    warnings: warnings,
    message: "Disconnected. Memories were not deleted.",
  };
}

function usageInstall() {
  return [
    "resonance-memory --install-app [--dir <folder>] [--no-shortcut]",
    "",
    "Copy this program into a fixed folder and point Connect and the memory",
    "hooks at that copy. A Desktop shortcut is created unless --no-shortcut.",
    "The shortcut can be moved or deleted. The installed file cannot.",
    "",
    "  --dir <folder>     Folder to install into. Default depends on the OS:",
    "                     Windows  %LOCALAPPDATA%\\Programs\\Resonance Memory",
    "                     macOS    ~/Applications/Resonance Memory",
    "                     Linux    ~/.local/bin",
    "  --no-shortcut      Do not put a shortcut on the Desktop.",
    "",
    "A newer copy updates the installed file in place, so the path does not",
    "change. Running from source (node entry.js) refuses and writes nothing.",
    WARNING,
  ].join("\n");
}

function usageUninstall() {
  return [
    "resonance-memory --uninstall-app",
    "",
    "Disconnect LM Studio and Claude Desktop, remove the two memory hooks",
    "this program added, delete the Desktop shortcut, and delete the installed",
    "program file when it is not the file you are running.",
    "Memories are not deleted. They stay in ~/.resonance-memory/.",
    "Disconnect on the panel is only the app unwiring; it does not do this.",
  ].join("\n");
}

function parseInstallArgs(argv) {
  const out = { help: false, dir: "", noShortcut: false };
  const args = argv || [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--no-shortcut") out.noShortcut = true;
    else if (a === "--dir") {
      const v = args[i + 1];
      if (!v || v.startsWith("--")) throw new Error("--dir needs a folder path");
      out.dir = v;
      i++;
    } else if (a.indexOf("--dir=") === 0) out.dir = a.slice("--dir=".length);
    else throw new Error("unknown argument: " + a);
  }
  return out;
}

function printResult(result) {
  if (!result) return;
  if (result.message) console.log(result.message);
  if (result.error) console.log(result.error);
  if (result.exe && result.wrote) console.log("program: " + result.exe);
  if (result.shortcut) console.log("shortcut: " + result.shortcut);
  const mcp = result.mcp || [];
  for (const row of mcp) {
    if (!row || row.action === "not-present" || row.action === "not-connected" || row.action === "already") continue;
    console.log((row.name || row.id || "config") + ": " + row.action + (row.file ? "  (" + row.file + ")" : ""));
  }
  if (result.hooks) console.log("memory hooks repointed: " + result.hooks);
  if (result.hooksRemoved) console.log("memory hooks removed: " + result.hooksRemoved);
  if (result.shortcutRemoved) console.log("shortcut removed");
  for (const file of result.filesRemoved || []) console.log("removed: " + file);
  for (const w of result.warnings || []) console.log("warning: " + w);
}

function mainInstall(argv) {
  let args;
  try { args = parseInstallArgs(argv || []); }
  catch (err) {
    console.log(String(err && err.message || err) + "\n\n" + usageInstall());
    return Promise.resolve(1);
  }
  if (args.help) {
    console.log(usageInstall());
    return Promise.resolve(0);
  }
  if (!detectSea()) {
    console.log("This is a source checkout (node entry.js), not the packaged program.\nInstall copies the executable into a fixed folder. Run the downloaded resonance-memory program instead.\nNothing was written.");
    return Promise.resolve(1);
  }
  const result = installApp({
    env: process.env,
    isSea: true,
    sourceExe: process.execPath,
    version: pkgVersion(),
    dir: args.dir,
    shortcut: !args.noShortcut,
    noShortcut: args.noShortcut,
  });
  printResult(result);
  if (result.ok && result.wrote) console.log("\n" + WARNING);
  return Promise.resolve(result.ok ? 0 : 1);
}

function mainUninstall(argv) {
  const args = argv || [];
  if (args.indexOf("--help") !== -1 || args.indexOf("-h") !== -1) {
    console.log(usageUninstall());
    return Promise.resolve(0);
  }
  if (args.length) {
    console.log("unknown argument: " + args[0] + "\n\n" + usageUninstall());
    return Promise.resolve(1);
  }
  const result = uninstallApp({ env: process.env, sourceExe: process.execPath });
  printResult(result);
  console.log("\nYour saved memories were NOT deleted.");
  return Promise.resolve(0);
}

module.exports = {
  WARNING,
  MARKER_NAME,
  RECORD_NAME,
  exeName,
  shortcutKind,
  defaultInstallDir,
  homeFromEnv,
  desktopDir,
  shortcutPathFor,
  cmpVersion,
  dataDir,
  recordPath,
  validateDir,
  runtimeFromEnv,
  stableCommand,
  inspect,
  installApp,
  declineInstall,
  uninstallApp,
  placeExe,
  cleanupOld,
  hasMarker,
  repointMcp,
  repointHooks,
  removeOwnedHooks,
  disconnectMcp,
  writeShortcut,
  desktopFileText,
  uninstallBatText,
  clientConfigs,
  parseInstallArgs,
  usageInstall,
  usageUninstall,
  mainInstall,
  mainUninstall,
  knownDesktop,
};
