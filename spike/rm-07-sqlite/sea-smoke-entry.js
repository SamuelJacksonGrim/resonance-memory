#!/usr/bin/env node
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
 * SPIKE — not product. Tiny SEA entry that only proves node:sqlite runs
 * inside a Node SEA binary copied from this process.execPath. Not wired
 * into build-exe.js.
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (42);");
const row = db.prepare("SELECT x FROM t").get();
if (!row || row.x !== 42) {
  process.stderr.write("SEA node:sqlite FAILED\n");
  process.exit(1);
}
process.stdout.write("SEA node:sqlite OK node=" + process.version +
  " sqlite=" + process.versions.sqlite +
  " exec=" + process.execPath + "\n");
db.close();
