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
"""Pin guard. Restrains automation only.

A pinned basename cannot be moved, renamed, deleted, or rewritten by a script.
Nothing here hooks Claude's Edit tool or asks for a sign-off. Conversation
edits under Samuel's standing authority are unchanged.
"""

from __future__ import annotations

from pathlib import Path

from cabinet.errors import PinError

MUTATIONS = frozenset({"move", "rename", "delete", "rewrite"})


class PinGuard:
    def __init__(self, names: set[str]):
        self.names = set(names)

    def pinned(self, name: str) -> bool:
        return name in self.names

    def require(self, name: str, op: str) -> None:
        if op in MUTATIONS and name in self.names:
            raise PinError(name, op)

    def require_path(self, path: Path, op: str) -> None:
        self.require(path.stem, op)
