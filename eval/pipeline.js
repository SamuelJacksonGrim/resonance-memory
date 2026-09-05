/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See <https://www.gnu.org/licenses/>.
 */
/*
 * eval/pipeline.js - the harness's adapter onto the shared engine.
 *
 * This USED to be a hand-copied "faithful mirror" of server.js's save/recall. That
 * duplication was the exact drift the RM-00 harness exists to catch, so the shared
 * behavior now lives in ../memory-core.js and BOTH server.js and this build on it.
 * What remains here is only the impedance match the harness needs: a boolean field
 * flag (not a live config read) and an injected edge-sidecar path (not a fixed data dir).
 *
 * Because save/recall are now literally the same code the server runs, the RM-00
 * golden is a regression guard on the server itself, not on a copy of it.
 */

const { EdgeStore } = require("../edges.js");
const { createCore, cosine } = require("../memory-core.js");

function createMemory({ store, embed, fieldEnabled = false, edgesPath, ledgerPath }) {
  // Lazy EdgeStore, exactly as server.js does it, so a field-off run never touches disk.
  // ledgerPath is a leftover alias: `.assoc.json` is rewritten to `.edges.json` so
  // diagnose/probe callers that haven't moved still land on the new filename, and
  // EdgeStore migrates a sibling `.assoc.json` one-way if one is sitting there.
  const file = edgesPath || (ledgerPath
    ? String(ledgerPath).replace(/\.assoc\.json$/, ".edges.json")
    : undefined);
  let _edges = null;
  const getEdgeStore = () => { if (!_edges) _edges = new EdgeStore(file); return _edges; };
  const core = createCore({ store, embed, fieldEnabled: () => fieldEnabled, getEdgeStore });
  return { save: core.save, recall: core.recall };
}

module.exports = { createMemory, cosine };
