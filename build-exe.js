/*
 * build-exe.js - regenerate the single-file executable from the source files.
 *
 * Sources stay the editable truth (server.js, field.js, ledger.js, panel.js, entry.js).
 * This just re-bundles them into one exe. Run it again after any edit:
 *     node build-exe.js
 *
 * Pipeline: esbuild (bundle to one file) -> Node SEA blob -> copy node runtime ->
 * postject (inject blob). Produces resonance-memory.exe (Windows) / memory (mac/linux) that
 * needs NO Node installed on the user's machine.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const build = path.join(dir, "build");
fs.mkdirSync(build, { recursive: true });

const exeName = process.platform === "win32" ? "resonance-memory.exe" : "memory";
const outExe = path.join(dir, exeName);
const run = (cmd) => execSync(cmd, { stdio: "inherit", cwd: dir });

console.log("[1/4] bundling sources with esbuild ...");
run(`npx --yes esbuild "${path.join(dir, "entry.js")}" --bundle --platform=node --target=node20 --outfile="${path.join(build, "bundle.js")}"`);

console.log("[2/4] generating SEA blob ...");
run(`"${process.execPath}" --experimental-sea-config "${path.join(dir, "sea-config.json")}"`);

console.log("[3/4] copying the node runtime -> " + exeName + " ...");
if (fs.existsSync(outExe)) fs.rmSync(outExe);
fs.copyFileSync(process.execPath, outExe);

console.log("[4/4] injecting blob (postject) ...");
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
let inject = `npx --yes postject "${outExe}" NODE_SEA_BLOB "${path.join(build, "sea-prep.blob")}" --sentinel-fuse ${fuse}`;
if (process.platform === "darwin") inject += " --macho-segment-name NODE_SEA";
run(inject);

// Flip the Windows PE subsystem console(3) -> GUI(2) so double-clicking the exe opens
// NO console window. MCP mode is unaffected: LM Studio pipes stdin/stdout, and a GUI-
// subsystem process uses those redirected handles fine - it just doesn't auto-allocate
// a console when launched interactively. This makes the exe the single, clean thing to
// double-click (no separate launcher, no stray terminal).
if (process.platform === "win32") {
  const buf = fs.readFileSync(outExe);
  const peOff = buf.readUInt32LE(0x3c);
  const subOff = peOff + 92; // PE sig(4) + COFF header(20) + optional-header Subsystem field(0x44)
  if (buf.readUInt16LE(subOff) === 3) {
    buf.writeUInt16LE(2, subOff);
    fs.writeFileSync(outExe, buf);
    console.log("      subsystem flipped console -> GUI (no console window on double-click)");
  }
}

const mb = (fs.statSync(outExe).size / 1048576).toFixed(0);
console.log("\nDone -> " + outExe + "  (" + mb + " MB)");

// Stage the clean, ship-ready bundle: ONLY what a user needs, nothing else. This is
// the folder you zip and hand out - no source, no build scripts, no sprawl.
console.log("[5/5] staging dist/ (the shippable bundle) ...");
const dist = path.join(dir, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const ship = [exeName, "demo-seed.jsonl", "uninstall.bat", "README.md", "system-prompt.md", "READ ME FIRST.txt"];
let staged = 0;
for (const f of ship) {
  const src = path.join(dir, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dist, f)); staged++; }
}
console.log("Staged " + staged + " files -> " + dist + "  (zip this folder to distribute)");
console.log('\nTest:  "' + outExe + '" --mcp   (MCP server)   |   "' + outExe + '"   (control panel)');
