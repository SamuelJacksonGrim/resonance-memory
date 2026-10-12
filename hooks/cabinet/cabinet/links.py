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
"""[[name]] resolution and History footers.

A basename link resolves to the one live file with that stem, or, if the memory
was faded whole, to the one history file. A live file and its fade pair share
a stem on purpose; the link means the live file.

The documented template `history/<name>.md` is not a footer.
"""

from __future__ import annotations

import re
from pathlib import Path

_LINK = re.compile(r"\[\[([^\]\n]+)\]\]")
_FOOTER = re.compile(r"History:\s*`history/([^`/\\]+)\.md`")
_TEMPLATE_NAME = "<name>"


def link_targets(text: str) -> list[str]:
    """Basename targets. Path-like links (with a slash) are returned with the slash kept."""
    found = []
    for match in _LINK.finditer(text):
        body = match.group(1).strip()
        if "|" in body:
            body = body.split("|", 1)[0].strip()
        if "#" in body:
            body = body.split("#", 1)[0].strip()
        if body:
            found.append(body)
    return found


def footer_targets(text: str) -> list[str]:
    """History filenames named by a real footer. The `<name>` template is skipped."""
    names = []
    for match in _FOOTER.finditer(text):
        name = match.group(1)
        if name == _TEMPLATE_NAME:
            continue
        names.append(name)
    return names


def index_by_stem(paths: list[Path]) -> dict[str, list[Path]]:
    groups: dict[str, list[Path]] = {}
    for path in paths:
        groups.setdefault(path.stem, []).append(path)
    return groups
