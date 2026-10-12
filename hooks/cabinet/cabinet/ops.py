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
"""The only mutation helpers cabinet scripts use.

move, rename, delete, and rewrite all go through the pin guard. Reading does not.
"""

from __future__ import annotations

from pathlib import Path

from cabinet.embedtext import sha256_bytes
from cabinet.errors import CabinetError
from cabinet.guard import PinGuard


def move_file(src: Path, dest: Path, guard: PinGuard) -> str:
    """Rename src to dest. Refuses pins and overwrites. Returns the sha256."""
    guard.require_path(src, "move")
    if dest.exists():
        raise CabinetError(f"refusing to overwrite {dest}")
    before = sha256_bytes(src)
    dest.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dest)
    after = sha256_bytes(dest)
    if after != before or src.exists() or not dest.is_file():
        if dest.is_file() and not src.exists():
            dest.rename(src)
        raise CabinetError(f"byte check failed for {src.name}")
    return after


def rename_file(src: Path, dest: Path, guard: PinGuard) -> str:
    """A new basename is a rename of the pin, which is refused, and a move."""
    guard.require_path(src, "rename")
    if dest.stem != src.stem:
        guard.require(dest.stem, "rename")
    return move_file(src, dest, guard)


def delete_file(path: Path, guard: PinGuard) -> None:
    guard.require_path(path, "delete")
    path.unlink()


def rewrite_file(path: Path, text: str, guard: PinGuard) -> None:
    guard.require_path(path, "rewrite")
    path.write_text(text, encoding="utf-8", newline="\n")
