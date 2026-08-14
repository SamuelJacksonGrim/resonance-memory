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
