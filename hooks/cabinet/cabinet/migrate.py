# Resonance Memory - memory filing cabinet for Claude Code
# Copyright (C) 2026 Samuel Jackson Grim
#
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero
# General Public License as published by the Free Software Foundation, version 3 of the License.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
# implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public
# License for more details. You should have received a copy of the GNU Affero General Public License along with
# this program. If not, see <https://www.gnu.org/licenses/>.
"""Move files according to the mapping.

Dry-run unless apply=True. Refuses to move a pin, refuses to overwrite, and
checks each applied move is byte-identical. Writes a report outside the memory
directory. Does not edit file contents and does not touch the embedding cache.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from cabinet.embedtext import sha256_bytes
from cabinet.errors import CabinetError, PinError, ReportPathError
from cabinet.guard import PinGuard
from cabinet.mapping import Row, load_mapping, pin_names
from cabinet.ops import move_file
from cabinet.rules import live_files, rel_of


@dataclass
class Item:
    name: str
    action: str  # pin, move, already, error
    source: str
    dest: str
    sha256: str
    detail: str = ""
    verified: bool = False


@dataclass
class Plan:
    memory: Path
    mapping_path: Path
    items: list[Item] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    applied: bool = False
    partial: bool = False

    @property
    def ok(self) -> bool:
        return not self.errors and not self.partial


def _outside(path: Path, memory: Path) -> None:
    resolved = path.resolve()
    root = memory.resolve()
    if resolved == root or root in resolved.parents:
        raise ReportPathError(f"refusing to write {resolved} inside the memory dir")


def build_plan(memory: Path, mapping_path: Path) -> tuple[Plan, list[Row], PinGuard]:
    memory = memory.resolve()
    if not memory.is_dir():
        raise CabinetError(f"memory dir does not exist: {memory}")
    rows = load_mapping(mapping_path)
    guard = PinGuard(pin_names(rows))
    plan = Plan(memory=memory, mapping_path=mapping_path.resolve())
    live_stems = {path.stem: path for path in live_files(memory)}

    mapped = {row.name for row in rows}
    for stem, path in sorted(live_stems.items()):
        if stem not in mapped:
            plan.warnings.append(f"unmapped live file left where it is: {rel_of(memory, path)}")

    seen_dest: dict[str, str] = {}
    for row in rows:
        dest = memory.joinpath(*row.dest_rel().split("/"))
        dest_key = row.dest_rel().lower()
        if dest_key in seen_dest:
            plan.errors.append(
                f"{row.name}: destination {row.dest_rel()} also claimed by {seen_dest[dest_key]}"
            )
            plan.items.append(Item(row.name, "error", "", row.dest_rel(), "", "duplicate destination"))
            continue
        seen_dest[dest_key] = row.name

        top = memory / f"{row.name}.md"
        if row.pinned:
            _plan_pin(plan, row, top)
            continue
        try:
            # A name in the pin set with a drawer destination is a move, and it is refused.
            guard.require(row.name, "move")
        except PinError as exc:
            plan.errors.append(str(exc))
            plan.items.append(Item(row.name, "error", f"{row.name}.md", row.dest_rel(), "", str(exc)))
            continue
        _plan_move(plan, row, top, dest)
    return plan, rows, guard


def _plan_pin(plan: Plan, row: Row, top: Path) -> None:
    # A '.' row is not a mutation. The file is left where it is, unread by any writer.
    if not top.is_file():
        plan.errors.append(f"pin missing at top level: {row.name}.md")
        plan.items.append(Item(row.name, "error", f"{row.name}.md", f"{row.name}.md", "", "missing pin"))
        return
    digest = sha256_bytes(top)
    plan.items.append(Item(row.name, "pin", f"{row.name}.md", f"{row.name}.md", digest))


def _plan_move(plan: Plan, row: Row, top: Path, dest: Path) -> None:
    rel_dest = row.dest_rel()
    if top.is_file() and dest.is_file():
        plan.errors.append(f"refusing to overwrite {rel_dest} (source {row.name}.md also exists)")
        plan.items.append(Item(row.name, "error", f"{row.name}.md", rel_dest, sha256_bytes(top), "overwrite"))
        return
    if top.is_file():
        plan.items.append(Item(row.name, "move", f"{row.name}.md", rel_dest, sha256_bytes(top)))
        return
    if dest.is_file():
        plan.items.append(Item(
            row.name, "already", "", rel_dest, sha256_bytes(dest), "already at destination"
        ))
        return
    plan.errors.append(f"missing source: {row.name}.md (not at top level and not at {rel_dest})")
    plan.items.append(Item(row.name, "error", f"{row.name}.md", rel_dest, "", "missing"))


def apply_plan(plan: Plan, guard: PinGuard) -> None:
    """Move every 'move' item. Caller must have refused to call this when plan.errors."""
    if plan.errors:
        raise CabinetError("refusing to apply a plan that has errors")
    pin_before = {
        item.name: item.sha256 for item in plan.items if item.action == "pin"
    }
    for item in plan.items:
        if item.action != "move":
            continue
        src = plan.memory / item.source
        dest = plan.memory.joinpath(*item.dest.split("/"))
        try:
            before = sha256_bytes(src)
            if before != item.sha256:
                raise CabinetError(f"{item.name}: source changed between plan and apply")
            after = move_file(src, dest, guard)
            item.verified = True
            item.sha256 = after
        except (CabinetError, PinError, OSError) as exc:
            plan.partial = True
            plan.errors.append(f"stopped during apply on {item.name}: {exc}")
            item.detail = str(exc)
            break
    for item in plan.items:
        if item.action != "pin":
            continue
        path = plan.memory / f"{item.name}.md"
        if not path.is_file():
            plan.partial = True
            plan.errors.append(f"pin disappeared during apply: {item.name}")
            continue
        digest = sha256_bytes(path)
        if digest != pin_before.get(item.name):
            plan.partial = True
            plan.errors.append(f"pin bytes changed during apply: {item.name}")
        else:
            item.verified = True
            item.sha256 = digest
    plan.applied = True


def render_report(plan: Plan, mode: str) -> str:
    counts: dict[str, int] = {}
    for item in plan.items:
        counts[item.action] = counts.get(item.action, 0) + 1
    lines = [
        "# Migration report",
        "",
        f"- mode: {mode}",
        f"- memory: `{plan.memory}`",
        f"- mapping: `{plan.mapping_path}`",
        f"- pins: {counts.get('pin', 0)}",
        f"- moves: {counts.get('move', 0)}",
        f"- already at destination: {counts.get('already', 0)}",
        f"- errors: {len(plan.errors)}",
        f"- warnings: {len(plan.warnings)}",
        f"- applied: {str(plan.applied).lower()}",
        f"- partial: {str(plan.partial).lower()}",
        "",
    ]
    if plan.errors:
        lines.append("## Errors")
        lines.append("")
        for err in plan.errors:
            lines.append(f"- {err}")
        lines.append("")
    if plan.warnings:
        lines.append("## Warnings")
        lines.append("")
        for warning in plan.warnings:
            lines.append(f"- {warning}")
        lines.append("")
    lines.append("## Files")
    lines.append("")
    lines.append("| name | action | from | to | sha256 | verified |")
    lines.append("|---|---|---|---|---|---|")
    for item in plan.items:
        verified = "yes" if item.verified else ""
        lines.append(
            f"| {item.name} | {item.action} | {item.source} | {item.dest} | {item.sha256} | {verified} |"
        )
        if item.detail:
            lines.append(f"|  |  |  | {item.detail} |  |  |")
    lines.append("")
    return "\n".join(lines)


def run_migrate(memory: Path, mapping_path: Path, apply: bool, report: Path | None) -> Plan:
    if report is not None:
        _outside(report, memory)
    plan, _rows, guard = build_plan(memory, mapping_path)
    # A '.' row must not be treated as a move. Re-check every pin against a move
    # request that a bad mapping would have represented as a non-dot dest: those
    # already became errors inside build_plan via guard.require.
    mode = "apply" if apply else "dry-run"
    if apply and plan.ok:
        apply_plan(plan, guard)
        mode = "apply"
    elif apply and not plan.ok:
        mode = "apply-refused"
    text = render_report(plan, mode)
    if report is not None:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(text, encoding="utf-8", newline="\n")
    return plan
