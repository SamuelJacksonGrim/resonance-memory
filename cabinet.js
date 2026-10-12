#!/usr/bin/env node
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
/*
 * cabinet.js — filing metadata for a store that has no directories.
 *
 * Resonance Memory keeps short facts as rows. The filing cabinet is three
 * fields on the row (normalize() backfills them), not a folder tree:
 *
 *   drawer   subject path ("people", "projects/towerdef"). Empty means
 *            never filed. "inbox" is the explicit catch-all for a new
 *            fact that did not match a drawer. The baseline is NOT a
 *            drawer — that is `pinned`.
 *   pinned   cabinet front. Who the user is and how they want to be
 *            treated. Recall prints these in their own section, in
 *            created order, and removes them from the ranked pool so
 *            they cannot take a slot or move a cosine result (I2).
 *            A shelved pin leaves that section until the recall asks
 *            for shelved — otherwise shelve would not work on the front.
 *   status   active / paused / shelved / done. A label, plus one filter:
 *            `shelved` is out of the default ranked pool (same spirit as
 *            skipping history). paused and done stay eligible — the fact
 *            is still true, and a label must not demote a better match.
 *            Invalid or missing status backfills to active so a typo
 *            cannot hide a memory.
 *
 * No separate visibility field. It would duplicate the three axes that
 * already exist and invent illegal combinations (pinned + history):
 *   pinned                         always-in-view section
 *   status shelved                 out of default recall; still browsable
 *   valid_to / superseded_by       history, already excluded from current()
 *   everything else                in the ranked pool
 *
 * Assignment (save of a NEW row only — never a rewrite of an existing
 * pin). Pins restrain this function; they are not a sign-off gate.
 *   1. An explicit drawer the caller passed (the model heard the user,
 *      or the panel moved the row).
 *   2. Else the drawer that already holds the same person, when that
 *      vote is unambiguous. Entity ids are exact; they are not a rank.
 *   3. Else `people`, when the text names a family / friend / work
 *      relation and no drawer vote disagreed. A bare name is not enough
 *      — that would file half the store under people.
 *   4. Else the nearest non-inbox drawer whose closest memory is at
 *      least ASSIGN_MIN_COS (0.72, the same neighborhood as the 0.70
 *      recall floor). Below that, a guess is worse than inbox.
 *   5. Else inbox.
 * Corrections copy the retired row's drawer and pin (and a shelved
 * status) onto the new current row unless the caller set them. A
 * restatement must not refile the fact out from under itself.
 *
 * Default drawers are a constant, not rows. An empty install shows them
 * without anyone creating folders and without dummy memories that would
 * show up in recall. Children (projects/towerdef) appear when a fact
 * lands there. Split a subject when a subset is wanted together, not
 * at a count.
 */

"use strict";

const { resolveEntities, relationsOf } = require("./entity.js");

const DEFAULT_DRAWERS = Object.freeze([
  "people",
  "preferences",
  "projects",
  "tools",
  "reference",
  "inbox",
]);

const INBOX = "inbox";
const STATUSES = Object.freeze(["active", "paused", "shelved", "done"]);
// Below this, nearest-drawer is a guess. Inbox is the honest bucket.
// 0.72 sits just above the 0.70 meaning floor used by the file cabinet's
// recall hook, and just below the 0.88 merge band so a near-duplicate
// still restates instead of being "filed" as a new row.
const ASSIGN_MIN_COS = 0.72;
const MAX_DEPTH = 3;
const SEG = /^[a-z0-9][a-z0-9_-]{0,40}$/;
// These names are paths the export tree owns. A drawer must not collide
// with them, or a fact and the history mirror land on the same folder.
const RESERVED = new Set(["history", "pinned", "deleted", "unfiled", "cabinet"]);

function asBool(v) {
  if (typeof v === "bigint") v = Number(v);
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  return false;
}

function normalizeDrawer(raw) {
  if (raw == null) return "";
  let s = String(raw).trim().toLowerCase().replace(/\\/g, "/");
  s = s.replace(/^\/+|\/+$/g, "");
  if (!s || s === "." || s === "..") return "";
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > MAX_DEPTH) return "";
  for (const p of parts) {
    if (!SEG.test(p) || RESERVED.has(p) || p === "." || p === "..") return "";
  }
  return parts.join("/");
}

function normalizeStatus(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  return STATUSES.indexOf(s) >= 0 ? s : "active";
}

function isShelved(rec) {
  return normalizeStatus(rec && rec.status) === "shelved";
}

function donorRecords(records) {
  const out = [];
  for (const r of records || []) {
    if (!r || r.deleted || r.valid_to || r.pinned) continue;
    const d = normalizeDrawer(r.drawer);
    if (!d || d === INBOX) continue;
    out.push(r);
  }
  return out;
}

function hasPersonRelation(features) {
  const rel = relationsOf(features);
  return !!(rel && rel.size);
}

/*
 * Where a new fact goes. `hasExplicit` means the caller passed a drawer
 * key, including "" (leave it unfiled on purpose). A non-empty value that
 * does not survive normalizeDrawer is ignored — a bad path must not block
 * the fallback, and must not be stored.
 */
function assignDrawer(opts) {
  opts = opts || {};
  if (opts.hasExplicit) {
    const d = normalizeDrawer(opts.explicit);
    if (d) return { drawer: d, how: "explicit" };
    const raw = opts.explicit == null ? "" : String(opts.explicit).trim();
    if (!raw) return { drawer: "", how: "explicit" };
  }

  const donors = donorRecords(opts.records);
  let ambiguous = false;
  try {
    const virtual = { id: "__new__", text: opts.text || "" };
    const resolved = resolveEntities([virtual].concat(donors));
    const mine = resolved.get("__new__");
    const ids = (mine && mine.entity_ids) || [];
    if (ids.length && donors.length) {
      const votes = new Map();
      for (const r of donors) {
        const er = resolved.get(String(r.id));
        const eids = (er && er.entity_ids) || [];
        let hit = false;
        for (const id of ids) {
          if (eids.indexOf(id) >= 0) { hit = true; break; }
        }
        if (!hit) continue;
        const d = normalizeDrawer(r.drawer);
        votes.set(d, (votes.get(d) || 0) + 1);
      }
      const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      if (ranked.length === 1 || (ranked.length > 1 && ranked[0][1] >= ranked[1][1] * 2)) {
        return { drawer: ranked[0][0], how: "entity" };
      }
      if (ranked.length > 1) ambiguous = true;
    }
    if (!ambiguous && mine && hasPersonRelation(mine.features)) {
      return { drawer: "people", how: "entity-class" };
    }
  } catch { /* a filing heuristic must never break save */ }

  const vec = opts.vector;
  const cosine = opts.cosine;
  if (vec && vec.length && typeof cosine === "function" && donors.length) {
    let bestD = null;
    let bestS = -1;
    for (const r of donors) {
      if (!r.embedding || !r.embedding.length) continue;
      let s = 0;
      try { s = cosine(vec, r.embedding); } catch { s = 0; }
      if (typeof s !== "number" || !Number.isFinite(s)) continue;
      if (s > bestS) { bestS = s; bestD = normalizeDrawer(r.drawer); }
    }
    if (bestD && bestS >= ASSIGN_MIN_COS) {
      return { drawer: bestD, how: "nearest", score: bestS };
    }
  }

  return { drawer: INBOX, how: "inbox" };
}

/*
 * A correction is the same fact in a new row. Keep the filing of the row
 * it replaced unless this save said otherwise. Shelved sticks — updating
 * the words is not permission to put a shelved fact back in every recall.
 * paused / done do not stick: they are labels, and the new row is the
 * current statement (active unless the caller set a status).
 */
function carryCabinet(oldRec, newRec, explicit) {
  explicit = explicit || {};
  const explicitDrawer = Object.prototype.hasOwnProperty.call(explicit, "drawer");
  const explicitPin = Object.prototype.hasOwnProperty.call(explicit, "pinned");
  const explicitStatus = Object.prototype.hasOwnProperty.call(explicit, "status");
  const out = {
    drawer: normalizeDrawer(newRec && newRec.drawer),
    pinned: asBool(newRec && newRec.pinned),
    status: normalizeStatus(newRec && newRec.status),
  };
  if (!explicitDrawer) {
    const prev = normalizeDrawer(oldRec && oldRec.drawer);
    if (prev) out.drawer = prev;
  }
  if (!explicitPin && oldRec && asBool(oldRec.pinned)) out.pinned = true;
  if (!explicitStatus && oldRec && isShelved(oldRec)) out.status = "shelved";
  return out;
}

/*
 * Patch for edit / the panel. Only keys the caller actually sent.
 * An illegal drawer or status is an error, not a silent clear — a
 * misspelled move must not unfile the row.
 */
function cabinetPatch(opts) {
  if (!opts) return { patch: null };
  const patch = {};
  let any = false;
  if (Object.prototype.hasOwnProperty.call(opts, "drawer")) {
    any = true;
    const raw = opts.drawer == null ? "" : String(opts.drawer).trim();
    const d = normalizeDrawer(opts.drawer);
    if (raw && !d) return { error: "That drawer path is not usable. Use a subject like people or projects/towerdef." };
    patch.drawer = d;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "pinned")) {
    any = true;
    patch.pinned = asBool(opts.pinned);
  }
  if (Object.prototype.hasOwnProperty.call(opts, "status")) {
    any = true;
    const s = String(opts.status == null ? "" : opts.status).trim().toLowerCase();
    if (STATUSES.indexOf(s) < 0) return { error: "Status must be active, paused, shelved, or done." };
    patch.status = s;
  }
  return { patch: any ? patch : null };
}

/*
 * Ranked-pool membership. This REMOVES rows. It does not score them.
 * Pinned rows are printed by formatPinSection and must not also occupy
 * a ranked slot. Shelved rows wait for an explicit status filter or
 * includeShelved. paused and done stay in.
 */
function rankPool(mems, opts) {
  opts = opts || {};
  const rawStatus = opts.status == null ? "" : String(opts.status).trim().toLowerCase();
  const only = STATUSES.indexOf(rawStatus) >= 0 ? rawStatus : null;
  const includeShelved = !!opts.includeShelved;
  const out = [];
  for (const m of mems || []) {
    if (!m) continue;
    if (m.pinned && !m.valid_to) continue;
    const st = normalizeStatus(m.status);
    if (only) {
      if (st === only) out.push(m);
      continue;
    }
    if (!includeShelved && st === "shelved") continue;
    out.push(m);
  }
  return out;
}

function statusAllows(rec, opts) {
  opts = opts || {};
  const rawStatus = opts.status == null ? "" : String(opts.status).trim().toLowerCase();
  const only = STATUSES.indexOf(rawStatus) >= 0 ? rawStatus : null;
  const st = normalizeStatus(rec && rec.status);
  if (only) return st === only;
  if (!opts.includeShelved && st === "shelved") return false;
  return true;
}

function formatPinSection(mems, opts) {
  const pins = [];
  for (const m of mems || []) {
    if (!m || m.deleted || m.valid_to || !m.pinned) continue;
    // A shelved pin is not "always in view". Shelve has to work on the
    // front of the cabinet too, or the user cannot put a pin away.
    // paused and done stay: the fact is still one they asked to see.
    if (!statusAllows(m, opts)) continue;
    pins.push(m);
  }
  pins.sort((a, b) => {
    const c = String(a.created || "").localeCompare(String(b.created || ""));
    if (c) return c;
    return String(a.id).localeCompare(String(b.id));
  });
  if (!pins.length) return "";
  return "Pinned (always in view, not ranked):\n" +
    pins.map((m) => "- [id " + m.id + "] " + m.text).join("\n");
}

function summary(r) {
  return {
    id: r.id,
    text: r.text,
    drawer: normalizeDrawer(r.drawer),
    pinned: asBool(r.pinned),
    status: normalizeStatus(r.status),
    created: r.created || null,
    superseded: !!(r.valid_to || r.superseded_by),
  };
}

function byCreated(a, b) {
  const c = String(a.created || "").localeCompare(String(b.created || ""));
  if (c) return c;
  return String(a.id).localeCompare(String(b.id));
}

function drawerSortKey(path) {
  const top = String(path || "").split("/")[0];
  const i = DEFAULT_DRAWERS.indexOf(top);
  const group = i < 0 ? DEFAULT_DRAWERS.length : i;
  return String(group).padStart(3, "0") + "\t" + path;
}

function buildTree(records) {
  const pinned = [];
  const unfiled = [];
  const history = [];
  const byDrawer = new Map();
  function bucket(path) {
    if (!byDrawer.has(path)) byDrawer.set(path, []);
    return byDrawer.get(path);
  }
  for (const d of DEFAULT_DRAWERS) bucket(d);
  for (const r of records || []) {
    if (!r || r.deleted) continue;
    const row = summary(r);
    if (row.superseded) { history.push(row); continue; }
    if (row.pinned) pinned.push(row);
    if (!row.drawer) {
      if (!row.pinned) unfiled.push(row);
      continue;
    }
    bucket(row.drawer);
    const parts = row.drawer.split("/");
    for (let i = 1; i < parts.length; i++) bucket(parts.slice(0, i).join("/"));
    if (!row.pinned) byDrawer.get(row.drawer).push(row);
  }
  pinned.sort(byCreated);
  unfiled.sort(byCreated);
  history.sort(byCreated);
  const paths = [...byDrawer.keys()].sort((a, b) => drawerSortKey(a).localeCompare(drawerSortKey(b)));
  const nodes = new Map();
  for (const p of paths) {
    const memories = (byDrawer.get(p) || []).slice().sort(byCreated);
    nodes.set(p, {
      path: p,
      label: p.split("/").pop(),
      memories,
      children: [],
    });
  }
  const roots = [];
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const parent = slash >= 0 ? p.slice(0, slash) : "";
    const node = nodes.get(p);
    if (parent && nodes.has(parent)) nodes.get(parent).children.push(node);
    else roots.push(node);
  }
  return {
    pinned,
    drawers: roots,
    unfiled,
    history,
    defaults: DEFAULT_DRAWERS.slice(),
    paths,
  };
}

function matchesStatusFilter(row, filter) {
  const f = String(filter || "all").trim().toLowerCase();
  if (!f || f === "all") return true;
  return normalizeStatus(row && row.status) === f;
}

const SLUG_CAP = 40;
const WINDOWS_RESERVED = /^(con|prn|nul|com[1-9]|lpt[1-9])$/i;

function cabinetFileName(id, text) {
  let s = String(text || "").toLowerCase().replace(/\s+/g, "-");
  s = s.replace(/[^a-z0-9._-]+/g, "");
  s = s.replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (s.length > SLUG_CAP) s = s.slice(0, SLUG_CAP).replace(/[-.]+$/g, "");
  const ident = String(id);
  if (!s || WINDOWS_RESERVED.test(s)) return ident + ".md";
  return ident + "-" + s + ".md";
}

/*
 * Export tree. Pinned facts live under cabinet/pinned/, not under their
 * drawer — the baseline is not a drawer. Superseded facts mirror the
 * drawer under cabinet/history/. Deleted facts stay in memories.jsonl
 * only (the date-folder JSON already carries them).
 */
function cabinetRelPath(rec) {
  if (!rec || rec.deleted) return null;
  const file = cabinetFileName(rec.id, rec.text);
  const drawer = normalizeDrawer(rec.drawer) || "unfiled";
  if (rec.valid_to || rec.superseded_by) return "cabinet/history/" + drawer + "/" + file;
  if (asBool(rec.pinned)) return "cabinet/pinned/" + file;
  return "cabinet/" + drawer + "/" + file;
}

function yamlScalar(v) {
  if (v == null) return "null";
  return JSON.stringify(String(v));
}

function cabinetMarkdown(rec) {
  const drawer = normalizeDrawer(rec && rec.drawer);
  const lines = [
    "---",
    "id: " + yamlScalar(rec && rec.id),
    "drawer: " + (drawer ? yamlScalar(drawer) : '""'),
    "pinned: " + (asBool(rec && rec.pinned) ? "true" : "false"),
    "status: " + yamlScalar(normalizeStatus(rec && rec.status)),
    "created: " + yamlScalar(rec && rec.created || ""),
    "valid_to: " + (rec && rec.valid_to ? yamlScalar(rec.valid_to) : "null"),
    "---",
    "",
    String((rec && rec.text) || ""),
    "",
  ];
  return lines.join("\n");
}

function oneLine(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 80) : s;
}

function cabinetIndexMarkdown(records) {
  const tree = buildTree(records);
  const lines = [
    "# Cabinet",
    "",
    "Pinned memories are the front of the cabinet. They are not a drawer.",
    "Drawers follow subject. A new install starts with the empty subject",
    "drawers listed here; a child such as projects/towerdef appears when",
    "a memory is filed there.",
    "History is superseded memories, mirrored under history/.",
    "Deleted memories stay in memories.jsonl, not in this tree.",
    "",
    "## Pinned",
    "",
  ];
  if (!tree.pinned.length) lines.push("(none)");
  else {
    for (const m of tree.pinned) lines.push("- " + m.id + " — " + oneLine(m.text));
  }
  lines.push("", "## Drawers", "");
  function walk(node, depth) {
    lines.push("  ".repeat(depth) + "- " + node.path + " (" + node.memories.length + ")");
    for (const c of node.children) walk(c, depth + 1);
  }
  for (const d of tree.drawers) walk(d, 0);
  lines.push("", "## Unfiled", "", String(tree.unfiled.length), "");
  lines.push("## History", "", String(tree.history.length), "");
  return lines.join("\n");
}

module.exports = {
  DEFAULT_DRAWERS,
  INBOX,
  STATUSES,
  ASSIGN_MIN_COS,
  asBool,
  normalizeDrawer,
  normalizeStatus,
  assignDrawer,
  carryCabinet,
  cabinetPatch,
  rankPool,
  formatPinSection,
  summary,
  buildTree,
  matchesStatusFilter,
  cabinetFileName,
  cabinetRelPath,
  cabinetMarkdown,
  cabinetIndexMarkdown,
};
