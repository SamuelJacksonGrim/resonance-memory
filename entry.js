// Bundled single-executable entry point.
//   memory              (double-click)  -> opens the control panel in the browser
//   memory --mcp        (AI client)     -> runs the MCP server over stdio
//   memory --install    (CLI)           -> connect to detected AI apps
//   memory --uninstall  (CLI)           -> disconnect from AI apps
const mode = process.argv[2];

if (mode === "--mcp") {
  require("./server.js");
} else if (mode === "--install" || mode === "--uninstall") {
  const inst = require("./install.js");
  const r = mode === "--install" ? inst.install() : inst.uninstall();
  if (!r.ok && r.message) console.log(r.message);
  for (const x of r.results) console.log(x.name + ": " + x.action + (x.file ? "  (" + x.file + ")" : ""));
  if (r.ok && mode === "--install") console.log("\nDone. Restart your AI app to load the memory server.");
} else {
  require("./panel.js");
}
