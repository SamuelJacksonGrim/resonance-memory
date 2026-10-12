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
"""Setting up a cabinet in a new memory folder, and keeping MEMORY.md's links pointed at the right files.

init:   creates the drawer folders and a starter cabinet.tsv in the memory folder. Every existing memory starts as
        "." (stays at the top level, pinned), so nothing moves until someone decides where each file goes.
relink: after files move, rewrites the markdown links in MEMORY.md ("](name.md)") to each file's mapped location.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from cabinet.mapping import load_mapping
from cabinet.rules import DRAWERS, live_records

HEADER = """# Cabinet placement: one row per memory, "<name><TAB><destination>".
# "."  = stays at the top level: the baseline (who the user is, how they want to be treated, how you work
#        together, standing safety lines). Pinned: the cabinet scripts never move, rename, delete or rewrite these.
# else = a drawer folder: projects/<subject>, tools/<subject> or reference/<subject> (folders follow subject).
# After editing: python -m cabinet migrate (dry run), then --apply, then index, relink and check.
"""


def init_cabinet(memory: Path, mapping: Path, apply: bool) -> list[str]:
    actions = []
    for drawer in DRAWERS:
        d = memory / drawer
        if not d.exists():
            actions.append(f"create folder {drawer}/")
            if apply:
                d.mkdir(parents=True)
    if mapping.exists():
        actions.append(f"keep existing {mapping.name} (not overwritten)")
    else:
        names = sorted(r["rel"][:-3] for r in live_records(memory) if "/" not in r["rel"])
        actions.append(f"write {mapping.name} with {len(names)} rows, all '.' (nothing moves yet)")
        if apply:
            body = HEADER + "".join(f"{n}\t.\n" for n in names)
            mapping.write_text(body, encoding="utf-8", newline="\n")
    return actions


@dataclass
class RelinkResult:
    changed: int = 0
    unresolved: list = field(default_factory=list)
    text: str = ""


_LINK = re.compile(r"\]\(([^)\s]+\.md)\)")


def relink_index(memory: Path, mapping: Path, apply: bool, index_name: str = "MEMORY.md") -> RelinkResult:
    index = memory / index_name
    res = RelinkResult()
    if not index.exists():
        res.unresolved.append(f"{index_name} not found")
        return res
    dest = {row.name: row.dest_rel() for row in load_mapping(mapping)}
    text = index.read_text(encoding="utf-8")

    def swap(m):
        target = m.group(1)
        if "://" in target or target.startswith(("../", "/")):
            return m.group(0)                      # outside the memory folder: leave it
        name = Path(target).stem
        new = dest.get(name)
        if new and new != target:
            res.changed += 1
            return f"]({new})"
        return m.group(0)

    out = _LINK.sub(swap, text)
    for target in _LINK.findall(out):
        if "://" in target or target.startswith(("../", "/")):
            continue
        if not (memory / target).exists():
            res.unresolved.append(target)
    res.text = out
    if apply and res.changed:
        index.write_text(out, encoding="utf-8", newline="\n")
    return res
