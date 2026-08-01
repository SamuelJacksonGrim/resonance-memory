/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
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
 * flag (not a live config read) and an injected ledger path (not a fixed data dir).
 *
 * Because save/recall are now literally the same code the server runs, the RM-00
 * golden is a regression guard on the server itself, not on a copy of it.
 */

const { Ledger } = require("../ledger.js");
const { createCore, cosine } = require("../memory-core.js");

function createMemory({ store, embed, fieldEnabled = false, ledgerPath }) {
  // Lazy ledger, exactly as server.js does it, so a field-off run never touches disk.
  let _ledger = null;
  const getLedger = () => { if (!_ledger) _ledger = new Ledger(ledgerPath); return _ledger; };
  const core = createCore({ store, embed, fieldEnabled: () => fieldEnabled, getLedger });
  return { save: core.save, recall: core.recall };
}

module.exports = { createMemory, cosine };
