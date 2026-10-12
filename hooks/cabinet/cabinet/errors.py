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
"""Errors the cabinet tools raise. None of these are Claude-hook failures."""


class CabinetError(Exception):
    """A planned operation cannot proceed. Nothing was left half-applied unless the message says so."""


class PinError(CabinetError):
    """Automation tried to move, rename, delete, or rewrite a surface file."""

    def __init__(self, name: str, op: str):
        self.name = name
        self.op = op
        super().__init__(
            f"surface guard: refusing to {op} '{name}'. "
            "The surface guard restrains scripts only; they are not a sign-off gate on Claude's own edits."
        )


class MappingError(CabinetError):
    """The placement table is not usable."""


class ReportPathError(CabinetError):
    """A report or generated file would land inside the memory directory, where recall could eat it."""
