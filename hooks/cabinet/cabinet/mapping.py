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
"""Placement table. '.' rows are the surface (they stay put). There is no second list."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from cabinet.errors import MappingError
from cabinet.rules import DRAWERS

_FORBIDDEN_SEGMENTS = frozenset({".", ".."})


@dataclass(frozen=True)
class Row:
    name: str
    dest_dir: str  # "" means stay at the top level (surface)
    line: int

    @property
    def pinned(self) -> bool:
        return self.dest_dir == ""

    def dest_rel(self) -> str:
        if self.pinned:
            return f"{self.name}.md"
        return f"{self.dest_dir}/{self.name}.md"


def load_mapping(path: Path) -> list[Row]:
    text = path.read_text(encoding="utf-8-sig")
    rows: list[Row] = []
    seen: dict[str, int] = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "\t" in raw:
            name, dest = raw.split("\t", 1)
        else:
            parts = line.split(None, 1)
            if len(parts) != 2:
                raise MappingError(f"{path}:{lineno}: expected name and destination")
            name, dest = parts
        name = name.strip()
        dest = dest.strip()
        if not name or "/" in name or "\\" in name or name.endswith(".md"):
            raise MappingError(f"{path}:{lineno}: '{name}' is not a bare basename")
        if name in seen:
            raise MappingError(
                f"{path}:{lineno}: '{name}' repeated (first at line {seen[name]})"
            )
        seen[name] = lineno
        dest_dir = _dest_dir(path, lineno, dest)
        rows.append(Row(name=name, dest_dir=dest_dir, line=lineno))
    if not rows:
        raise MappingError(f"{path}: no rows")
    return rows


def _dest_dir(path: Path, lineno: int, dest: str) -> str:
    if dest == ".":
        return ""
    dest = dest.replace("\\", "/").strip("/")
    if not dest or dest.startswith("/") or ":" in dest:
        raise MappingError(f"{path}:{lineno}: destination '{dest}' is not a relative drawer path")
    parts = dest.split("/")
    if any(part in _FORBIDDEN_SEGMENTS or part == "" for part in parts):
        raise MappingError(f"{path}:{lineno}: destination '{dest}' escapes the memory dir")
    if parts[0] not in DRAWERS:
        raise MappingError(
            f"{path}:{lineno}: destination '{dest}' is not under "
            + ", ".join(DRAWERS)
            + ". history/ and the top level are not filing targets"
        )
    return dest


def pin_names(rows: list[Row]) -> set[str]:
    return {row.name for row in rows if row.pinned}
