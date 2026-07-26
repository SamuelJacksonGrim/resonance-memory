#!/usr/bin/env node
/*
 * panel.js - the zero-terminal control panel for Simple Memory.
 *
 * A tiny local web server (127.0.0.1 only) that serves one page with a real toggle
 * switch for the associative field. The switch writes the same config.json the MCP
 * server reads on every recall, so flipping it takes effect live - no restart.
 *
 * Double-click a launcher (start-panel.bat / .command) and the browser opens to it.
 * No CLI knowledge required of the end user.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const install = require("./install.js");

function baseDir() {
  // In a bundled single-executable, __dirname is virtual; resolve next to the exe.
  try { const sea = require("node:sea"); if (sea.isSea()) return path.dirname(process.execPath); } catch { }
  return __dirname;
}
const CONFIG_PATH = process.env.SIMPLE_MEMORY_CONFIG || path.join(baseDir(), "config.json");
const STORE_PATH = process.env.MEMORY_FILE_PATH ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".lmstudio", "simple-memory.jsonl");
const PORT = Number(process.env.SIMPLE_MEMORY_PANEL_PORT || 9090);

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; } }
function writeConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf8"); }
function fieldOn() { const c = readConfig(); return typeof c.field === "boolean" ? c.field : false; }
function memCount() {
  try {
    return fs.readFileSync(STORE_PATH, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && !r.deleted).length;
  } catch { return 0; }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simple Memory</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #f4f5f7; color: #1c1e21; }
  .card { width: min(92vw, 440px); background: #fff; border-radius: 18px; padding: 32px;
    box-shadow: 0 12px 40px rgba(0,0,0,.10); border: 1px solid rgba(0,0,0,.06); }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #6b7280; font-size: 13px; margin: 0 0 24px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 18px; border-radius: 14px; background: #f7f8fa; border: 1px solid rgba(0,0,0,.05); }
  .label { font-weight: 600; }
  .hint { color: #6b7280; font-size: 12.5px; margin-top: 3px; }
  .switch { position: relative; width: 60px; height: 34px; flex: none; cursor: pointer; }
  .switch input { display: none; }
  .slider { position: absolute; inset: 0; background: #cbd0d8; border-radius: 999px; transition: .22s; }
  .slider::before { content: ""; position: absolute; height: 26px; width: 26px; left: 4px; top: 4px;
    background: #fff; border-radius: 50%; transition: .22s; box-shadow: 0 2px 5px rgba(0,0,0,.25); }
  input:checked + .slider { background: #2f9e6b; }
  input:checked + .slider::before { transform: translateX(26px); }
  .status { margin-top: 18px; font-size: 13px; color: #6b7280; text-align: center; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; }
  .on { background: #dcf5e8; color: #1c7a4f; } .off { background: #eceef1; color: #6b7280; }
  .foot { margin-top: 22px; font-size: 12px; color: #9aa1ab; line-height: 1.5; }
  .clients { margin: 4px 0 20px; }
  .ctitle { font-weight: 600; margin-bottom: 10px; }
  .client { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 14px; border-radius: 12px; background: #f7f8fa; border: 1px solid rgba(0,0,0,.05); margin-bottom: 8px; }
  .cname { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  button { font: inherit; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 9px;
    border: 1px solid rgba(0,0,0,.12); background: #fff; color: #1c1e21; cursor: pointer; }
  button.primary { background: #2f9e6b; border-color: #2f9e6b; color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e8eb; }
    .card { background: #1f2227; border-color: rgba(255,255,255,.07); box-shadow: 0 12px 40px rgba(0,0,0,.4); }
    .row { background: #171a1e; border-color: rgba(255,255,255,.06); }
    .sub, .hint, .status, .foot { color: #9aa1ab; }
    .off { background: #2a2e35; color: #9aa1ab; }
    .client { background: #171a1e; border-color: rgba(255,255,255,.06); }
    button { background: #2a2e35; color: #e6e8eb; border-color: rgba(255,255,255,.12); }
    button.primary { background: #2f9e6b; border-color: #2f9e6b; color: #fff; }
  }
</style></head>
<body>
  <div class="card">
    <h1>&#128220; Simple Memory</h1>
    <p class="sub">Your local model's memory. Nothing leaves this machine.</p>
    <div id="clients" class="clients"></div>
    <div class="row">
      <div>
        <div class="label">Associative field</div>
        <div class="hint">Recall also surfaces related memories, and the graph learns which ideas go together as you use it.</div>
      </div>
      <label class="switch"><input type="checkbox" id="tog"><span class="slider"></span></label>
    </div>
    <div class="status">Field is <span id="pill" class="pill off">OFF</span> &nbsp;&middot;&nbsp; <span id="count">0</span> memories stored</div>
    <div class="foot">Turn the whole system on or off in your app's MCP server list. This switch only controls the associative field, and it applies instantly &mdash; no restart needed.</div>
  </div>
<script>
  const tog = document.getElementById('tog'), pill = document.getElementById('pill'), count = document.getElementById('count');
  function render(s) {
    tog.checked = s.field;
    pill.textContent = s.field ? 'ON' : 'OFF';
    pill.className = 'pill ' + (s.field ? 'on' : 'off');
    count.textContent = s.memories;
  }
  async function load() { render(await (await fetch('/api/state')).json()); }
  tog.addEventListener('change', async () => {
    render(await (await fetch('/api/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: tog.checked }) }).then(r => r.json()).then(f => ({ field: f.field, memories: count.textContent }))));
    load();
  });
  async function loadClients() {
    const list = await (await fetch('/api/clients')).json();
    const el = document.getElementById('clients');
    el.innerHTML = '<div class="ctitle">Connect to your AI app</div>' + list.map(function (c) {
      var status = c.installed ? '<span class="pill on">connected</span>'
        : (c.present ? '<span class="pill off">not connected</span>' : '<span class="pill off">not found</span>');
      var btn = c.installed ? '<button data-id="' + c.id + '" data-act="disconnect">Disconnect</button>'
        : (c.present ? '<button class="primary" data-id="' + c.id + '" data-act="connect">Connect</button>' : '');
      return '<div class="client"><div><div class="cname">' + c.name + '</div>' + status + '</div>' + btn + '</div>';
    }).join('') + '<div class="hint">After connecting, restart that app once so it loads your memory.</div>';
    el.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', async function () {
        b.disabled = true; b.textContent = '…';
        var act = b.dataset.act === 'connect' ? 'connect' : 'disconnect';
        await fetch('/api/' + act, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id }) });
        loadClients();
      });
    });
  }
  load(); loadClients(); setInterval(load, 4000);
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE); return;
  }
  if (req.method === "GET" && req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ field: fieldOn(), memories: memCount() })); return;
  }
  if (req.method === "POST" && req.url === "/api/toggle") {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      let want; try { want = JSON.parse(body).field; } catch { }
      const c = readConfig(); c.field = typeof want === "boolean" ? want : !fieldOn(); writeConfig(c);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ field: c.field }));
    }); return;
  }
  if (req.method === "GET" && req.url === "/api/clients") {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(install.detect())); return;
  }
  if (req.method === "POST" && (req.url === "/api/connect" || req.url === "/api/disconnect")) {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      let id; try { id = JSON.parse(body).id; } catch { }
      const r = req.url === "/api/connect" ? install.install(id) : install.uninstall(id);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r));
    }); return;
  }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + PORT + "/";
  process.stdout.write("Simple Memory control panel running at " + url + "\n(Close this window to stop it.)\n");
  if (process.env.SIMPLE_MEMORY_NO_OPEN !== "1") {
    const cmd = process.platform === "win32" ? 'start "" "' + url + '"'
      : process.platform === "darwin" ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
    exec(cmd, () => { });
  }
});
