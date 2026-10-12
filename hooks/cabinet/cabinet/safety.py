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
"""Refuses a live embedding cache as a --cache argument.

Only relevant if you run your own embedding recall over the memory folder. Name the caches to protect in the
CABINET_LIVE_CACHE environment variable (several paths separated by the OS path separator); with nothing set,
nothing is refused.
"""

from __future__ import annotations

import os
from pathlib import Path

from cabinet.errors import CabinetError


def _live_caches() -> list[Path]:
    raw = os.environ.get("CABINET_LIVE_CACHE", "")
    return [Path(p) for p in raw.split(os.pathsep) if p.strip()]


def assert_not_live_cache(path: Path) -> None:
    resolved = path.resolve()
    for live in _live_caches():
        if resolved == live.resolve():
            raise CabinetError(
                "refusing to read or write the live embedding cache "
                f"({resolved}). Pass a scratch cache instead."
            )
