#!/usr/bin/env node
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
const { Ledger } = require("./ledger.js");

function baseDir() {
  // In a bundled single-executable, __dirname is virtual; resolve next to the exe.
  try { const sea = require("node:sea"); if (sea.isSea()) return path.dirname(process.execPath); } catch { }
  return __dirname;
}
const CONFIG_PATH = process.env.RESONANCE_MEMORY_CONFIG || path.join(baseDir(), "config.json");
const STORE_PATH = process.env.MEMORY_FILE_PATH ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".lmstudio", "resonance-memory.jsonl");
const DEMO_PATH = path.join(baseDir(), "demo-seed.jsonl");
const PORT = Number(process.env.RESONANCE_MEMORY_PANEL_PORT || 9090);
const KOFI = "https://ko-fi.com/thearchitectofresonance";
const PAYPAL = "https://paypal.me/SamuelGrim91";

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; } }
function writeConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf8"); }
function fieldOn() { const c = readConfig(); return typeof c.field === "boolean" ? c.field : false; }

function loadRecords(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && !r.deleted);
  } catch { return []; }
}
function memCount() { return loadRecords(STORE_PATH).length; }

// Build the association graph for the view: nodes = memories, edges = kNN semantic links,
// annotated with any learned Hebbian weight so the UI can highlight what use has reinforced.
function graphData(demo) {
  const recs = loadRecords(demo ? DEMO_PATH : STORE_PATH).filter((r) => Array.isArray(r.embedding));
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
    nodes: recs.map((r) => ({ id: String(r.id), text: r.text })),
    edges: [...seen.values()],
    source: demo ? "demo" : "your memories",
    field: !!ledger,
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
  .sec { margin-top: 20px; }
  .sechead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .ctitle { font-weight: 600; } .clients { margin-bottom: 4px; }
  .client { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 14px; border-radius: 12px; background: #f7f8fa; border: 1px solid rgba(0,0,0,.05); margin-bottom: 8px; }
  .cname { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  button { font: inherit; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 9px;
    border: 1px solid rgba(0,0,0,.12); background: #fff; color: #1c1e21; cursor: pointer; }
  button.primary { background: var(--acc); border-color: var(--acc); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .graphwrap { border-radius: 14px; overflow: hidden; border: 1px solid rgba(0,0,0,.08); background: #fbfbfd; }
  canvas { display: block; width: 100%; height: 300px; touch-action: none; }
  .cap { min-height: 34px; padding: 8px 12px; font-size: 12.5px; color: #4b5563;
    border-top: 1px solid rgba(0,0,0,.06); background: #f7f8fa; }
  .cap b { color: var(--acc); }
  .legend { font-size: 11.5px; color: #9aa1ab; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
  .foot { margin-top: 20px; font-size: 12px; color: #9aa1ab; line-height: 1.5; }
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

    <div class="row">
      <div>
        <div class="label">Associative field</div>
        <div class="hint">Recall also surfaces related memories, and the graph learns which ideas go together as you use it.</div>
      </div>
      <label class="switch"><input type="checkbox" id="tog"><span class="slider"></span></label>
    </div>

    <div class="sec">
      <div class="sechead">
        <span class="ctitle">Association graph</span>
        <button id="demoBtn">Show demo graph</button>
      </div>
      <div class="graphwrap">
        <canvas id="cv"></canvas>
        <div class="cap" id="cap">Hover a dot to read the memory. Lines connect related ideas &mdash; thicker means more similar.</div>
      </div>
      <div class="legend">
        <span><span class="dot" style="background:var(--acc)"></span>related (meaning)</span>
        <span><span class="dot" style="background:var(--heb)"></span>reinforced by use</span>
        <span id="counts"></span>
      </div>
    </div>

    <div class="support">
      <div class="label">Support the Architect</div>
      <div class="why">If this is useful to you, it stays free &mdash; but coffee helps it keep improving.</div>
      <a class="kofi" href="${KOFI}" target="_blank" rel="noopener">&#9749; Ko-fi</a>
      <a href="${PAYPAL}" target="_blank" rel="noopener">PayPal</a>
    </div>

    <div class="foot">Turn the whole system on or off in your AI app's MCP server list. The field switch above applies instantly &mdash; no restart. This panel closes itself a few seconds after you close the tab.</div>
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
  }
  tog.addEventListener('change', async function(){
    await fetch('/api/toggle', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ field: tog.checked }) });
    if(!showDemo) loadGraph();
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
    loadGraph();
  });

  // --- graph rendering (lightweight force layout) ---
  var cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  var G = { nodes: [], edges: [] }, hover = -1, raf = null, W = 0, H = 0;
  function fit(){ var r = cv.getBoundingClientRect(); W = cv.width = r.width * devicePixelRatio; H = cv.height = r.height * devicePixelRatio; }
  window.addEventListener('resize', fit);

  function color(i){ var h = (i * 47) % 360; return 'hsl('+h+' 55% 55%)'; }
  function components(nodes, edges){
    var idx = {}; nodes.forEach(function(n,i){ n._i=i; idx[n.id]=i; n.c=-1; });
    var comp = 0;
    nodes.forEach(function(n){ if(n.c>=0) return; var stack=[n]; n.c=comp;
      while(stack.length){ var x=stack.pop();
        edges.forEach(function(e){ var o=null; if(e.a===x.id)o=nodes[idx[e.b]]; else if(e.b===x.id)o=nodes[idx[e.a]];
          if(o && o.c<0){ o.c=comp; stack.push(o); } });
      } comp++; });
  }

  async function loadGraph(){
    var g = await (await fetch('/api/graph?demo=' + (showDemo?1:0))).json();
    counts.textContent = g.nodes.length + ' memories, ' + g.edges.length + ' links';
    if(!g.nodes.length){
      cap.innerHTML = showDemo ? 'Demo unavailable.' : 'No memories yet. Click <b>Show demo graph</b> to see what this looks like in action.';
      G = { nodes: [], edges: [] }; draw(); return;
    }
    cap.innerHTML = showDemo
      ? 'This is a <b>demo</b> (a made-up game developer\\'s notes). Notice bridges &mdash; e.g. &ldquo;debugging on a run&rdquo; links the running notes to the game-crash notes.'
      : 'Your memories. Hover a dot to read it.';
    fit();
    var idx = {}; g.nodes.forEach(function(n,i){ idx[n.id]=i; n.x = W*(0.2+0.6*Math.random()); n.y = H*(0.2+0.6*Math.random()); n.vx=0; n.vy=0; });
    g.edges.forEach(function(e){ e.ai=idx[e.a]; e.bi=idx[e.b]; });
    components(g.nodes, g.edges);
    G = g;
    if(raf) cancelAnimationFrame(raf); tick(0);
  }

  function tick(step){
    var n = G.nodes, e = G.edges;
    for(var i=0;i<n.length;i++){
      for(var j=i+1;j<n.length;j++){
        var dx=n[j].x-n[i].x, dy=n[j].y-n[i].y, d2=dx*dx+dy*dy+0.01, d=Math.sqrt(d2);
        var rep = 1500*devicePixelRatio*devicePixelRatio/d2; var fx=dx/d*rep, fy=dy/d*rep;
        n[i].vx-=fx; n[i].vy-=fy; n[j].vx+=fx; n[j].vy+=fy;
      }
    }
    e.forEach(function(ed){
      var a=n[ed.ai], b=n[ed.bi]; if(!a||!b) return;
      var dx=b.x-a.x, dy=b.y-a.y, d=Math.sqrt(dx*dx+dy*dy)+0.01;
      var rest = 62*devicePixelRatio, k=0.02*(0.5+(ed.w-0.5));
      var f=(d-rest)*k; var fx=dx/d*f, fy=dy/d*f;
      a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy;
    });
    // Radial containment: pull toward center, and push back softly near the walls so
    // nodes settle into a centered cloud instead of pinning to the corners.
    var cx=W/2, cy=H/2, rad=Math.min(W,H)*0.42;
    for(var i=0;i<n.length;i++){
      var dx=n[i].x-cx, dy=n[i].y-cy, dist=Math.sqrt(dx*dx+dy*dy)+0.01;
      n[i].vx+=(cx-n[i].x)*0.004; n[i].vy+=(cy-n[i].y)*0.004;
      if(dist>rad){ var pull=(dist-rad)*0.06; n[i].vx-=dx/dist*pull; n[i].vy-=dy/dist*pull; }
      n[i].vx*=0.85; n[i].vy*=0.85;
      n[i].x+=n[i].vx; n[i].y+=n[i].vy;
      var m=14*devicePixelRatio; n[i].x=Math.max(m,Math.min(W-m,n[i].x)); n[i].y=Math.max(m,Math.min(H-m,n[i].y));
    }
    draw();
    if(step<260) raf=requestAnimationFrame(function(){ tick(step+1); });
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    var heb = css('--heb'), acc = css('--acc');
    G.edges.forEach(function(ed){
      var a=G.nodes[ed.ai], b=G.nodes[ed.bi]; if(!a||!b) return;
      var lit = hover>=0 && (ed.ai===hover||ed.bi===hover);
      ctx.strokeStyle = ed.hebbian>0 ? heb : acc;
      ctx.globalAlpha = lit ? 0.95 : (hover>=0 ? 0.12 : 0.42);
      ctx.lineWidth = (0.6 + Math.max(0,(ed.w-0.5))*7 + (ed.hebbian>0?1.2:0)) * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    G.nodes.forEach(function(nd,i){
      var r = (hover===i?7:5)*devicePixelRatio;
      ctx.beginPath(); ctx.arc(nd.x,nd.y,r,0,7); ctx.fillStyle = color(nd.c);
      ctx.globalAlpha = (hover>=0 && hover!==i && !isNeighbor(i)) ? 0.35 : 1;
      ctx.fill();
      ctx.globalAlpha=1; ctx.lineWidth=1.5*devicePixelRatio; ctx.strokeStyle='rgba(255,255,255,.7)'; ctx.stroke();
    });
  }
  function isNeighbor(i){ return G.edges.some(function(e){ return (e.ai===hover&&e.bi===i)||(e.bi===hover&&e.ai===i); }); }

  cv.addEventListener('mousemove', function(ev){
    var r = cv.getBoundingClientRect();
    var mx=(ev.clientX-r.left)*devicePixelRatio, my=(ev.clientY-r.top)*devicePixelRatio;
    var best=-1, bd=1e9;
    G.nodes.forEach(function(nd,i){ var d=(nd.x-mx)*(nd.x-mx)+(nd.y-my)*(nd.y-my); if(d<bd){bd=d;best=i;} });
    var nh = (bd < (16*devicePixelRatio)*(16*devicePixelRatio)) ? best : -1;
    if(nh!==hover){ hover=nh; draw();
      if(hover>=0){ cap.innerHTML = '<b>&#8220;</b>' + G.nodes[hover].text.replace(/</g,'&lt;') + '<b>&#8221;</b>'; }
    }
  });
  cv.addEventListener('mouseleave', function(){ hover=-1; draw(); cap.textContent='Hover a dot to read the memory.'; });

  // --- heartbeat: keep the (hidden) process alive only while a tab is open ---
  function ping(){ fetch('/api/ping', { method:'POST' }).catch(function(){}); }
  setInterval(ping, 4000); ping();

  loadState(); loadClients(); loadGraph();
  setInterval(function(){ loadState(); if(!showDemo) loadGraph(); }, 8000);
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
    res.end(JSON.stringify({ field: fieldOn(), memories: memCount() })); return;
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
  process.stdout.write("Resonance Memory control panel running at " + url + "\n");
  if (process.env.RESONANCE_MEMORY_NO_OPEN !== "1") {
    const cmd = process.platform === "win32" ? 'start "" "' + url + '"'
      : process.platform === "darwin" ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
    exec(cmd, () => { });
  }
});
