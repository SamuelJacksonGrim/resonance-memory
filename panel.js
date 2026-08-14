#!/usr/bin/env node
/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/*
 * panel.js - the zero-terminal control panel for Resonance Memory.
 *
 * A tiny local web server (127.0.0.1 only) that:
 *   - toggles the associative field (writes the shared config.json the MCP server reads live),
 *   - connects/disconnects the server from LM Studio / Claude Desktop,
 *   - draws the association graph (your memories, or a synthetic demo), and
 *   - shuts itself down shortly after you close the page (heartbeat), so nothing lingers.
 *
 * Launch it hidden with start-panel.vbs (no console window). No CLI knowledge required.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const install = require("./install.js");
const field = require("./field.js");
const engine = require("./engine.js");
const { Ledger } = require("./ledger.js");
const { normalize, isCurrent } = require("./record.js");

function baseDir() {
  // In a bundled single-executable, __dirname is virtual; resolve next to the exe.
  try { const sea = require("node:sea"); if (sea.isSea()) return path.dirname(process.execPath); } catch { }
  return __dirname;
}
const STORE_PATH = process.env.MEMORY_FILE_PATH ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".lmstudio", "resonance-memory.jsonl");
// Keep runtime state WITH the data (not next to the exe) so the downloaded exe leaves
// nothing beside itself, and the field on/off setting survives moving the exe.
const CONFIG_PATH = process.env.RESONANCE_MEMORY_CONFIG ||
  path.join(path.dirname(STORE_PATH), "resonance-memory.config.json");
const DEMO_PATH = path.join(baseDir(), "demo-seed.jsonl");
const PORT = Number(process.env.RESONANCE_MEMORY_PANEL_PORT || 9090);
const KOFI = "https://ko-fi.com/thearchitectofresonance";
const PAYPAL = "https://paypal.me/SamuelGrim91";

// Runtime assets baked into the exe by build-exe.js (single-file distribution).
// Absent when running from source (node panel.js) - then we just read from disk.
let EMBEDDED = { demoSeed: "", systemPrompt: "" };
try { EMBEDDED = require("./embedded-assets.js"); } catch { }

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; } }
function writeConfig(c) { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf8"); }
function fieldOn() { const c = readConfig(); return typeof c.field === "boolean" ? c.field : false; }

function parseJsonl(text) {
  return String(text).split("\n").filter(Boolean)
    .map((l) => { try { return normalize(JSON.parse(l)); } catch { return null; } })
    .filter((r) => r && !r.deleted);
}
function loadRecords(file) {
  try { return parseJsonl(fs.readFileSync(file, "utf8")); } catch { return []; }
}
// Demo: prefer a loose demo-seed.jsonl (dev) but fall back to the embedded copy so a
// bare, single-file exe still draws the demo graph with nothing beside it.
function loadDemo() {
  const disk = loadRecords(DEMO_PATH);
  return disk.length ? disk : parseJsonl(EMBEDDED.demoSeed);
}
// Currently-true memories. Superseded ones are still on disk (history is kept),
// but "how many memories do I have" means the ones that are actually true now.
function memCount() { return loadRecords(STORE_PATH).filter(isCurrent).length; }

// Build the association graph for the view: nodes = memories, edges = kNN semantic links,
// annotated with any learned Hebbian weight so the UI can highlight what use has reinforced.
function graphData(demo) {
  const recs = (demo ? loadDemo() : loadRecords(STORE_PATH)).filter((r) => Array.isArray(r.embedding));
  const byId = new Map(recs.map((r) => [String(r.id), r]));
  let ledger = null;
  if (!demo && fieldOn()) { try { ledger = new Ledger(STORE_PATH + ".assoc.json"); } catch { } }
  const bonus = ledger ? (a, b) => ledger.bonus(a, b) : () => 0;
  const m = field.buildEdges(recs, { k: 3, minSim: 0.55, bonus });
  const seen = new Map();
  for (const [a, list] of m) {
    for (const e of list) {
      const key = [String(a), String(e.id)].sort().join(":");
      if (seen.has(key)) continue;
      const ra = byId.get(String(a)), rb = byId.get(String(e.id));
      const base = field.cosine(ra.embedding, rb.embedding);
      const heb = ledger ? ledger.weight(a, e.id) : 0;
      seen.set(key, { a: String(a), b: String(e.id), w: Number(base.toFixed(4)), hebbian: Number(heb.toFixed(4)) });
    }
  }
  return {
    nodes: recs.map((r) => ({
      id: String(r.id),
      text: r.text,
      current: isCurrent(r),                       // superseded ones render dimmed
      superseded_by: r.superseded_by != null ? String(r.superseded_by) : null,
    })),
    edges: [...seen.values()],
    source: demo ? "demo" : "your memories",
    field: !!ledger,
    current_count: recs.filter(isCurrent).length,
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resonance Memory</title>
<style>
  :root { color-scheme: light dark; --acc: #2f9e6b; --heb: #d9873b; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 12px;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f4f5f7; color: #1c1e21; }
  .card { width: min(94vw, 560px); background: #fff; border-radius: 18px; padding: 28px;
    box-shadow: 0 12px 40px rgba(0,0,0,.10); border: 1px solid rgba(0,0,0,.06); }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #6b7280; font-size: 13px; margin: 0 0 22px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 16px 18px; border-radius: 14px; background: #f7f8fa; border: 1px solid rgba(0,0,0,.05); }
  .label { font-weight: 600; } .hint { color: #6b7280; font-size: 12.5px; margin-top: 3px; }
  .switch { position: relative; width: 60px; height: 34px; flex: none; cursor: pointer; }
  .switch input { display: none; }
  .slider { position: absolute; inset: 0; background: #cbd0d8; border-radius: 999px; transition: .22s; }
  .slider::before { content: ""; position: absolute; height: 26px; width: 26px; left: 4px; top: 4px;
    background: #fff; border-radius: 50%; transition: .22s; box-shadow: 0 2px 5px rgba(0,0,0,.25); }
  input:checked + .slider { background: var(--acc); }
  input:checked + .slider::before { transform: translateX(26px); }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; }
  .on { background: #dcf5e8; color: #1c7a4f; } .off { background: #eceef1; color: #6b7280; }
  .warn { background: #fceccb; color: #8a5a00; }
  .label .pill { margin-left: 7px; vertical-align: middle; }
  .sec { margin-top: 20px; }
  .sechead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .ctitle { font-weight: 600; } .clients { margin-bottom: 4px; }
  .linkish { background: none; border: none; padding: 0; margin: 0; font: inherit; font-weight: 600;
    color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .linkish:hover { color: var(--acc); } #caret { font-size: 11px; color: #9aa1ab; }
  .client { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 14px; border-radius: 12px; background: #f7f8fa; border: 1px solid rgba(0,0,0,.05); margin-bottom: 8px; }
  .cname { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  button { font: inherit; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 9px;
    border: 1px solid rgba(0,0,0,.12); background: #fff; color: #1c1e21; cursor: pointer; }
  button.primary { background: var(--acc); border-color: var(--acc); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .graphwrap { border-radius: 14px; overflow: hidden; border: 1px solid rgba(0,0,0,.08); background: #fbfbfd; }
  canvas { display: block; width: 100%; height: 340px; touch-action: none; cursor: grab; }
  canvas:active { cursor: grabbing; }
  .cap { min-height: 34px; padding: 8px 12px; font-size: 12.5px; color: #4b5563;
    border-top: 1px solid rgba(0,0,0,.06); background: #f7f8fa; }
  .cap b { color: var(--acc); }
  .legend { font-size: 11.5px; color: #9aa1ab; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
  .foot { margin-top: 20px; font-size: 12px; color: #9aa1ab; line-height: 1.5; }
  .foot a { color: var(--acc); } #spMsg { color: var(--acc); font-weight: 600; }
  .foot code { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px;
    background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 5px; word-break: break-all; }
  .support { margin-top: 18px; text-align: center; font-size: 13px; }
  .support a { display: inline-block; margin: 6px 5px 0; padding: 8px 16px; border-radius: 10px;
    text-decoration: none; font-weight: 600; border: 1px solid rgba(0,0,0,.12); color: #1c1e21; }
  .support a.kofi { background: #ffdd66; border-color: #ffcf33; color: #4a3a00; }
  .support .why { color: #6b7280; font-size: 12px; margin-top: 2px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e8eb; }
    .card { background: #1f2227; border-color: rgba(255,255,255,.07); box-shadow: 0 12px 40px rgba(0,0,0,.4); }
    .row, .client, .cap, .graphwrap { background: #171a1e; border-color: rgba(255,255,255,.06); }
    .sub, .hint, .foot, .support .why, .cap { color: #9aa1ab; }
    .off { background: #2a2e35; color: #9aa1ab; }
    .warn { background: #4a3a12; color: #f0c674; }
    .foot code { background: rgba(255,255,255,.08); }
    button { background: #2a2e35; color: #e6e8eb; border-color: rgba(255,255,255,.12); }
    button.primary { background: var(--acc); border-color: var(--acc); color: #fff; }
    .support a { background: #2a2e35; color: #e6e8eb; border-color: rgba(255,255,255,.12); }
    .support a.kofi { background: #ffdd66; color: #4a3a00; border-color: #ffcf33; }
  }
</style></head>
<body>
  <div class="card">
    <h1>&#128220; Resonance Memory</h1>
    <p class="sub">A local memory for your AI. Nothing leaves this machine.</p>

    <div id="clients" class="clients sec"></div>

    <div class="row" id="engineRow" style="margin-bottom:10px">
      <div>
        <div class="label">Meaning engine <span id="enginePill" class="pill off">checking&hellip;</span></div>
        <div class="hint" id="engineHint">The model that lets recall match by meaning, not just exact words.</div>
      </div>
      <button id="engineBtn" style="display:none"></button>
    </div>

    <div class="row">
      <div>
        <div class="label">Associative field</div>
        <div class="hint">Recall also surfaces related memories, and the graph learns which ideas go together as you use it.</div>
      </div>
      <label class="switch"><input type="checkbox" id="tog"><span class="slider"></span></label>
    </div>

    <div class="sec">
      <div class="sechead">
        <button id="graphToggle" class="linkish" aria-expanded="true">Association graph <span id="caret">&#9662;</span></button>
        <button id="demoBtn">Show demo graph</button>
      </div>
      <div id="graphBody">
        <div class="graphwrap">
          <canvas id="cv"></canvas>
          <div class="cap" id="cap">Drag to rotate. Hover a dot to read a memory. Related ideas cluster together in 3D &mdash; thicker lines mean more similar.</div>
        </div>
        <div class="legend">
          <span><span class="dot" style="background:var(--acc)"></span>related (meaning)</span>
          <span><span class="dot" style="background:var(--heb)"></span>reinforced by use</span>
          <span>bigger dot = more connected</span>
          <span id="counts"></span>
        </div>
      </div>
    </div>

    <div class="support">
      <div class="label">Support the Architect</div>
      <div class="why">If this is useful to you, it stays free &mdash; but coffee helps it keep improving.</div>
      <a class="kofi" href="${KOFI}" target="_blank" rel="noopener">&#9749; Ko-fi</a>
      <a href="${PAYPAL}" target="_blank" rel="noopener">PayPal</a>
    </div>

    <div class="foot">
      <div><b>For weaker models</b> that forget to save or recall: <a href="#" id="spBtn">copy a ready-made system prompt</a> and paste it into your app's system-prompt box. <span id="spMsg"></span></div>
      <div style="margin-top:11px"><b>Removing it?</b> Click <b>Disconnect</b> next to each app above, then delete <code>resonance-memory.exe</code> &mdash; that's the whole app. Your memories live at <code id="storePath">&hellip;</code> and stay put unless you delete that file too &mdash; along with the two small <code>.assoc.json</code> / <code>.access.json</code> companions beside it.</div>
      <div style="margin-top:11px">The field switch applies instantly &mdash; no restart. This panel closes itself a few seconds after you close the tab.</div>
    </div>
  </div>
<script>
  var tog = document.getElementById('tog');
  var demoBtn = document.getElementById('demoBtn');
  var cap = document.getElementById('cap'), counts = document.getElementById('counts');
  var showDemo = false;

  function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  async function loadState(){
    var s = await (await fetch('/api/state')).json();
    tog.checked = s.field;
    if(s.store){ var sp = document.getElementById('storePath'); if(sp) sp.textContent = s.store; }
  }

  var spBtn = document.getElementById('spBtn'), spMsg = document.getElementById('spMsg');
  spBtn.addEventListener('click', async function(ev){
    ev.preventDefault();
    try {
      var t = (await (await fetch('/api/system-prompt')).json()).text || '';
      if(!t){ spMsg.textContent = '(none available)'; return; }
      await navigator.clipboard.writeText(t);
      spMsg.textContent = 'copied to clipboard \\u2713';
    } catch(e){ spMsg.textContent = 'copy failed \\u2014 select the text in system-prompt.md instead'; }
    setTimeout(function(){ spMsg.textContent=''; }, 4000);
  });
  tog.addEventListener('change', async function(){
    await fetch('/api/toggle', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ field: tog.checked }) });
    if(!showDemo && !graphCollapsed) loadGraph(true);
  });

  async function loadClients(){
    var list = await (await fetch('/api/clients')).json();
    var el = document.getElementById('clients');
    el.innerHTML = '<div class="ctitle" style="margin-bottom:10px">Connect to your AI app</div>' + list.map(function(c){
      var status = c.installed ? '<span class="pill on">connected</span>'
        : (c.present ? '<span class="pill off">not connected</span>' : '<span class="pill off">not found</span>');
      var btn = c.installed ? '<button data-id="'+c.id+'" data-act="disconnect">Disconnect</button>'
        : (c.present ? '<button class="primary" data-id="'+c.id+'" data-act="connect">Connect</button>' : '');
      return '<div class="client"><div><div class="cname">'+c.name+'</div>'+status+'</div>'+btn+'</div>';
    }).join('') + '<div class="hint" style="margin-bottom:4px">After connecting, restart that app once so it loads your memory.</div>';
    el.querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', async function(){
        b.disabled = true; b.textContent = '\\u2026';
        var act = b.dataset.act === 'connect' ? 'connect' : 'disconnect';
        await fetch('/api/'+act, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: b.dataset.id }) });
        loadClients();
      });
    });
  }

  demoBtn.addEventListener('click', function(){
    showDemo = !showDemo;
    demoBtn.textContent = showDemo ? 'Show my memories' : 'Show demo graph';
    demoBtn.className = showDemo ? 'primary' : '';
    loadGraph(true);
  });

  // --- collapsible graph section (remembers your choice) ---
  var graphToggle = document.getElementById('graphToggle');
  var graphBody = document.getElementById('graphBody');
  var caret = document.getElementById('caret');
  var graphCollapsed = localStorage.getItem('rm_graph_collapsed') === '1';
  function applyGraphCollapsed(){
    graphBody.style.display = graphCollapsed ? 'none' : '';
    demoBtn.style.display = graphCollapsed ? 'none' : '';
    caret.innerHTML = graphCollapsed ? '&#9656;' : '&#9662;'; // right when hidden, down when shown
    graphToggle.setAttribute('aria-expanded', String(!graphCollapsed));
    if(!graphCollapsed) loadGraph(true);
    else if(raf){ cancelAnimationFrame(raf); raf=null; }   // stop animating while hidden
  }
  graphToggle.addEventListener('click', function(){
    graphCollapsed = !graphCollapsed;
    localStorage.setItem('rm_graph_collapsed', graphCollapsed ? '1' : '0');
    applyGraphCollapsed();
  });

  // --- meaning engine (embedding model) setup ---
  var enginePill = document.getElementById('enginePill');
  var engineHint = document.getElementById('engineHint');
  var engineBtn = document.getElementById('engineBtn');
  var engineBusy = false;

  function renderEngine(s){
    if(engineBusy) return;
    if(s.state === 'ready'){
      enginePill.className = 'pill on'; enginePill.textContent = 'ready';
      engineHint.textContent = 'Recall matches by meaning. You\\u2019re all set.';
      engineBtn.style.display = 'none';
    } else if(s.state === 'needs-setup'){
      enginePill.className = 'pill warn'; enginePill.textContent = 'not set up';
      engineHint.innerHTML = 'Recall is matching on exact words only. One click downloads &amp; loads the embedding model in LM Studio.';
      engineBtn.style.display = ''; engineBtn.className = 'primary'; engineBtn.textContent = 'Set up'; engineBtn.disabled = false;
    } else {
      enginePill.className = 'pill off'; enginePill.textContent = 'LM Studio needed';
      engineHint.innerHTML = 'Install <a href="https://lmstudio.ai" target="_blank" rel="noopener">LM Studio</a> (free), then reopen this page to finish setup in one click.';
      engineBtn.style.display = 'none';
    }
  }
  async function loadEngine(){
    if(engineBusy) return;
    try { renderEngine(await (await fetch('/api/engine')).json()); } catch(e){}
  }
  engineBtn.addEventListener('click', async function(){
    engineBusy = true; engineBtn.disabled = true; engineBtn.textContent = 'Setting up\\u2026';
    enginePill.className = 'pill warn'; enginePill.textContent = 'working';
    engineHint.textContent = 'Downloading and loading the model. The first time this can take a minute or two\\u2026';
    var r; try { r = await (await fetch('/api/engine/setup', { method:'POST' })).json(); } catch(e){ r = { ok:false }; }
    engineBusy = false;
    if(r && r.ok){ renderEngine({ state:'ready' }); if(!graphCollapsed) loadGraph(); }
    else {
      renderEngine({ state:'needs-setup' });
      engineHint.textContent = (r && r.message) ? r.message : 'Setup didn\\u2019t complete. Make sure LM Studio is installed, then try again.';
    }
  });

  // --- graph rendering (3D force-directed layout) -------------------------
  // Memories are placed in 3D by association: every semantic/Hebbian link is a
  // spring whose rest length shrinks as similarity rises, so strongly-related
  // notes collapse together while unrelated ones drift apart - reachable only
  // through the memories that bridge them. Positions persist across polls, so
  // the cloud only re-settles ("bounces") when a memory is added or removed.
  var cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  var G = { nodes: [], edges: [] }, hover = -1, raf = null, W = 0, H = 0, lastKey = '';
  var alpha = 0;                       // simulation heat: >0 settling, 0 at rest
  var yaw = 0.6, pitch = -0.32;        // camera angles
  var autoRotate = true, dragging = false, lastX = 0, lastY = 0;
  var saved = {};                      // id -> {x,y,z}, preserved across reloads

  // physics constants (world units)
  var REP = 60, L0 = 20, SPRING = 0.03, CENTER = 0.004, DAMP = 0.85, MAXV = 8;

  function fit(){ var r = cv.getBoundingClientRect(); W = cv.width = r.width * devicePixelRatio; H = cv.height = r.height * devicePixelRatio; }
  window.addEventListener('resize', fit);

  function color(i){ var h = (i * 47) % 360; return 'hsl('+h+' 55% 55%)'; }

  // connected components -> cluster color; edge endpoints -> indices; degree -> mass
  function analyze(nodes, edges){
    var idx = {}; nodes.forEach(function(n,i){ idx[n.id]=i; n.c=-1; n.deg=0; });
    edges.forEach(function(e){ e.ai=idx[e.a]; e.bi=idx[e.b];
      if(nodes[e.ai]){ nodes[e.ai].deg += 0.5 + e.w; }
      if(nodes[e.bi]){ nodes[e.bi].deg += 0.5 + e.w; } });
    var comp = 0;
    nodes.forEach(function(n){ if(n.c>=0) return; var stack=[n]; n.c=comp;
      while(stack.length){ var x=stack.pop();
        edges.forEach(function(e){ var o=null; if(e.a===x.id)o=nodes[idx[e.b]]; else if(e.b===x.id)o=nodes[idx[e.a]];
          if(o && o.c<0){ o.c=comp; stack.push(o); } });
      } comp++; });
  }

  async function loadGraph(force){
    var g = await (await fetch('/api/graph?demo=' + (showDemo?1:0))).json();
    var stale = g.nodes.length - (g.current_count != null ? g.current_count : g.nodes.length);
    counts.textContent = g.nodes.length + ' memories, ' + g.edges.length + ' links'
      + (stale > 0 ? ', ' + stale + ' superseded' : '');
    // Re-settle only when the SET of memories changes. Edge-only churn (Hebbian
    // reinforcement nudging weights) refreshes the springs in place - no bounce.
    var key = g.nodes.map(function(n){ return n.id; }).sort().join(',');
    if(!force && key === lastKey){ analyze(G.nodes, g.edges); G.edges = g.edges; return; }
    lastKey = key;
    if(!g.nodes.length){
      cap.innerHTML = showDemo ? 'Demo unavailable.' : 'No memories yet. Click <b>Show demo graph</b> to see what this looks like in action.';
      G = { nodes: [], edges: [] }; alpha = 0; if(raf){ cancelAnimationFrame(raf); raf=null; } draw(); return;
    }
    cap.innerHTML = showDemo
      ? 'A <b>demo</b> cloud in 3D. Related memories pull together; unrelated ones drift apart, reachable only through what bridges them. <b>Drag to rotate.</b>'
      : 'Your memories in 3D - related ones cluster together. <b>Drag to rotate</b>, hover a dot to read it.';
    fit();
    // Keep where existing nodes already settled; only brand-new ones get a fresh
    // spot near the origin, so an add is a gentle local settle, not a re-scatter.
    g.nodes.forEach(function(n){
      var p = saved[n.id];
      if(p){ n.x=p.x; n.y=p.y; n.z=p.z; }
      else { n.x=(Math.random()-0.5)*24; n.y=(Math.random()-0.5)*24; n.z=(Math.random()-0.5)*24; }
      n.vx=0; n.vy=0; n.vz=0;
    });
    analyze(g.nodes, g.edges);
    G = g; alpha = 1;                    // reheat: the only place a bounce begins
    if(!raf) raf = requestAnimationFrame(frame);
  }

  function simulate(){
    var n = G.nodes, e = G.edges, i, j;
    // repulsion: every memory pushes every other apart (inverse-square, 3D)
    for(i=0;i<n.length;i++){
      var a = n[i];
      for(j=i+1;j<n.length;j++){
        var b = n[j];
        var dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z;
        var d2=dx*dx+dy*dy+dz*dz+0.1, d=Math.sqrt(d2);
        var rep=REP/d2, ux=dx/d, uy=dy/d, uz=dz/d;
        a.vx-=ux*rep; a.vy-=uy*rep; a.vz-=uz*rep;
        b.vx+=ux*rep; b.vy+=uy*rep; b.vz+=uz*rep;
      }
    }
    // springs: each association pulls to a rest length that shrinks with
    // similarity (and shrinks further where use has reinforced the link)
    e.forEach(function(ed){
      var a=n[ed.ai], b=n[ed.bi]; if(!a||!b) return;
      var dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z;
      var d=Math.sqrt(dx*dx+dy*dy+dz*dz)+0.01;
      var rest=L0*(1.5-Math.min(ed.w,1)); if(ed.hebbian>0){ rest*=(1-Math.min(ed.hebbian,0.4)); }
      var f=(d-rest)*SPRING*(0.4+ed.w), ux=dx/d, uy=dy/d, uz=dz/d;
      a.vx+=ux*f; a.vy+=uy*f; a.vz+=uz*f;
      b.vx-=ux*f; b.vy-=uy*f; b.vz-=uz*f;
    });
    // integrate: pull gently to center, damp, clamp; heavier (more-connected)
    // nodes carry more mass, so hubs sit steady while leaves swing into place
    for(i=0;i<n.length;i++){
      var p=n[i], mass=0.6+0.5*Math.min(p.deg,6);
      p.vx-=p.x*CENTER; p.vy-=p.y*CENTER; p.vz-=p.z*CENTER;
      p.vx*=DAMP; p.vy*=DAMP; p.vz*=DAMP;
      var sp=Math.sqrt(p.vx*p.vx+p.vy*p.vy+p.vz*p.vz);
      if(sp>MAXV){ var s=MAXV/sp; p.vx*=s; p.vy*=s; p.vz*=s; }
      p.x+=p.vx/mass; p.y+=p.vy/mass; p.z+=p.vz/mass;
      saved[p.id]={ x:p.x, y:p.y, z:p.z };
    }
  }

  // rotate by the camera angles, then perspective-project to the canvas
  function project(nx,ny,nz,D,scale){
    var cy=Math.cos(yaw), sy=Math.sin(yaw), cx=Math.cos(pitch), sx=Math.sin(pitch);
    var x1=nx*cy - nz*sy, z1=nx*sy + nz*cy;
    var y1=ny*cx - z1*sx, z2=ny*sx + z1*cx;
    var denom=D-z2, lo=D*0.2; if(denom<lo){ denom=lo; }
    var k=D/denom;
    return { x:W/2 + x1*k*scale, y:H/2 + y1*k*scale, depth:z2, k:k };
  }

  function kick(){ if(!raf){ raf = requestAnimationFrame(frame); } }  // wake the loop
  function frame(){
    var settling = alpha > 0.01;
    if(settling){ simulate(); alpha *= 0.96; }        // cools to rest; no perpetual jitter
    var spinning = autoRotate && !dragging && hover<0;
    if(spinning){ yaw += 0.0024; }                    // gentle spin sells the 3D
    draw();
    // Keep animating only while there's motion; otherwise idle to zero CPU and
    // let a hover/drag/reheat wake us via kick(). A settled, still cloud costs nothing.
    raf = (settling || spinning || dragging) ? requestAnimationFrame(frame) : null;
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    var n=G.nodes, e=G.edges, i;
    if(!n.length){ return; }
    // auto-fit: scale the cloud to the canvas from its own bounding radius
    var R=1; for(i=0;i<n.length;i++){ var rr=Math.sqrt(n[i].x*n[i].x+n[i].y*n[i].y+n[i].z*n[i].z); if(rr>R){ R=rr; } }
    var scale=0.42*Math.min(W,H)/R, D=R*2.6;
    for(i=0;i<n.length;i++){ var pr=project(n[i].x,n[i].y,n[i].z,D,scale); n[i].sx=pr.x; n[i].sy=pr.y; n[i].sz=pr.depth; n[i].sk=pr.k; }
    var heb=css('--heb'), acc=css('--acc');
    e.forEach(function(ed){
      var a=n[ed.ai], b=n[ed.bi]; if(!a||!b) return;
      var lit = hover>=0 && (ed.ai===hover||ed.bi===hover);
      ctx.strokeStyle = ed.hebbian>0 ? heb : acc;
      ctx.globalAlpha = lit ? 0.95 : (hover>=0 ? 0.05 : 0.26);
      ctx.lineWidth = (0.5 + Math.max(0,(ed.w-0.5))*5 + (ed.hebbian>0?1:0)) * devicePixelRatio * (a.sk+b.sk)/2;
      ctx.beginPath(); ctx.moveTo(a.sx,a.sy); ctx.lineTo(b.sx,b.sy); ctx.stroke();
    });
    ctx.globalAlpha=1;
    // paint far-to-near so nearer memories sit on top
    var order=[]; for(i=0;i<n.length;i++){ order.push(i); }
    order.sort(function(p,q){ return n[p].sz - n[q].sz; });
    order.forEach(function(i){
      var nd=n[i];
      var base=3 + Math.min(nd.deg,6)*0.6;      // more-connected memories draw larger
      var r=(hover===i?base+2:base)*devicePixelRatio*nd.sk; if(r<0.5){ r=0.5; }
      var stale = nd.current === false;         // superseded: still there, visibly past
      ctx.beginPath(); ctx.arc(nd.sx,nd.sy,r,0,7); ctx.fillStyle=color(nd.c);
      var a=(hover>=0 && hover!==i && !isNeighbor(i)) ? 0.28 : 1;
      ctx.globalAlpha = stale ? a*0.3 : a; ctx.fill();
      ctx.globalAlpha = stale ? 0.4 : 1; ctx.lineWidth=1.2*devicePixelRatio;
      ctx.strokeStyle = stale ? 'rgba(150,150,150,.6)' : 'rgba(255,255,255,.7)'; ctx.stroke();
    });
  }
  function isNeighbor(i){ return G.edges.some(function(e){ return (e.ai===hover&&e.bi===i)||(e.bi===hover&&e.ai===i); }); }

  // hover to read a memory (uses the last projected screen positions)
  cv.addEventListener('mousemove', function(ev){
    if(dragging) return;
    var r = cv.getBoundingClientRect();
    var mx=(ev.clientX-r.left)*devicePixelRatio, my=(ev.clientY-r.top)*devicePixelRatio;
    var best=-1, bd=1e9;
    G.nodes.forEach(function(nd,i){ if(nd.sx==null) return; var d=(nd.sx-mx)*(nd.sx-mx)+(nd.sy-my)*(nd.sy-my); if(d<bd){ bd=d; best=i; } });
    var thr=15*devicePixelRatio, nh=(bd<thr*thr)?best:-1;
    if(nh!==hover){ hover=nh; kick();
      if(hover>=0){
        var hn = G.nodes[hover];
        cap.innerHTML = '<b>&#8220;</b>' + hn.text.replace(/</g,'&lt;') + '<b>&#8221;</b>'
          + (hn.current === false ? ' <span style="opacity:.7">&mdash; no longer current</span>' : '');
      }
      else { cap.innerHTML = 'Drag to rotate. Hover a dot to read the memory.'; }
    }
  });
  cv.addEventListener('mouseleave', function(){ hover=-1; kick(); });

  // drag to rotate (mouse + touch); taking control ends the gentle auto-spin
  function startDrag(x,y){ dragging=true; autoRotate=false; lastX=x; lastY=y; kick(); }
  function moveDrag(x,y){ if(!dragging) return; yaw += (x-lastX)*0.01; pitch += (y-lastY)*0.01; pitch=Math.max(-1.45,Math.min(1.45,pitch)); lastX=x; lastY=y; kick(); }
  cv.addEventListener('mousedown', function(ev){ startDrag(ev.clientX, ev.clientY); });
  window.addEventListener('mousemove', function(ev){ moveDrag(ev.clientX, ev.clientY); });
  window.addEventListener('mouseup', function(){ dragging=false; });
  cv.addEventListener('touchstart', function(ev){ if(ev.touches[0]){ startDrag(ev.touches[0].clientX, ev.touches[0].clientY); } }, { passive:true });
  cv.addEventListener('touchmove', function(ev){ if(ev.touches[0]){ moveDrag(ev.touches[0].clientX, ev.touches[0].clientY); ev.preventDefault(); } }, { passive:false });
  window.addEventListener('touchend', function(){ dragging=false; });

  // --- heartbeat: keep the (hidden) process alive only while a tab is open ---
  function ping(){ fetch('/api/ping', { method:'POST' }).catch(function(){}); }
  setInterval(ping, 4000); ping();

  loadState(); loadClients(); loadEngine(); applyGraphCollapsed();
  setInterval(function(){ loadState(); loadEngine(); if(!showDemo && !graphCollapsed) loadGraph(); }, 8000);
</script>
</body></html>`;

// --- heartbeat shutdown: exit ~12s after the last tab stops pinging ---
let lastPing = Date.now();
let connectedOnce = false;
setInterval(() => {
  if (connectedOnce && Date.now() - lastPing > 12000) process.exit(0);
}, 3000);

function body(req, cb) { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => cb(b)); }

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE); return;
  }
  if (req.method === "POST" && url === "/api/ping") {
    lastPing = Date.now(); connectedOnce = true;
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return;
  }
  if (req.method === "GET" && url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ field: fieldOn(), memories: memCount(), store: STORE_PATH })); return;
  }
  if (req.method === "GET" && url === "/api/system-prompt") {
    let text = "";
    try { text = fs.readFileSync(path.join(baseDir(), "system-prompt.md"), "utf8"); } catch { text = EMBEDDED.systemPrompt || ""; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ text })); return;
  }
  if (req.method === "GET" && url.startsWith("/api/graph")) {
    const demo = /[?&]demo=1/.test(url);
    let data; try { data = graphData(demo); } catch { data = { nodes: [], edges: [], source: demo ? "demo" : "your memories" }; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); return;
  }
  if (req.method === "POST" && url === "/api/toggle") {
    body(req, (b) => {
      let want; try { want = JSON.parse(b).field; } catch { }
      const c = readConfig(); c.field = typeof want === "boolean" ? want : !fieldOn(); writeConfig(c);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ field: c.field }));
    }); return;
  }
  if (req.method === "GET" && url === "/api/clients") {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(install.detect())); return;
  }
  if (req.method === "GET" && url === "/api/engine") {
    engine.status().then((s) => {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(s));
    }).catch(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ state: "no-lmstudio" })); });
    return;
  }
  if (req.method === "POST" && url === "/api/engine/setup") {
    engine.setup().then((r) => {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r));
    }).catch((e) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, state: "needs-setup", message: String(e && e.message || e) })); });
    return;
  }
  if (req.method === "POST" && (url === "/api/connect" || url === "/api/disconnect")) {
    body(req, (b) => {
      let id; try { id = JSON.parse(b).id; } catch { }
      const r = url === "/api/connect" ? install.install(id) : install.uninstall(id);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r));
    }); return;
  }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + PORT + "/";
  // Guarded: as a windowless (GUI-subsystem) exe there's no console to write to.
  try { process.stdout.write("Resonance Memory control panel running at " + url + "\n"); } catch { }
  if (process.env.RESONANCE_MEMORY_NO_OPEN !== "1") {
    const cmd = process.platform === "win32" ? 'start "" "' + url + '"'
      : process.platform === "darwin" ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
    exec(cmd, () => { });
  }
});
