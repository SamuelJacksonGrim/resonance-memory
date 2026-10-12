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
"""Frontmatter only. Body lines that look like `key: value` are not fields.

Recall's embed text still uses the legacy first-match scanner in embedtext.py,
because that is what today's vectors were built with. Indexes and the generated
flag use this parser so a sentence in the body cannot mark a memory as generated.
"""

from __future__ import annotations

import re

_KEY = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")
_TRUE = {"true", "yes", "1"}


def read_text(path) -> str:
    """Decode the way .NET ReadAllText(UTF8) does: strip a BOM, keep newlines."""
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return data.decode("utf-8", errors="replace")


def split_frontmatter(text: str) -> tuple[str, str]:
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return "", text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "".join(lines[1:i]), "".join(lines[i + 1 :])
    return "", text


def parse_frontmatter(text: str) -> dict[str, str]:
    """Top-level scalar keys. Indented metadata blocks are ignored."""
    block, _body = split_frontmatter(text)
    out: dict[str, str] = {}
    for line in block.splitlines():
        if not line or line[0] in " \t" or line.lstrip().startswith("#"):
            continue
        match = _KEY.match(line)
        if not match:
            continue
        key, raw = match.group(1), match.group(2).strip()
        out[key] = _unquote(raw)
    return out


def _unquote(raw: str) -> str:
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    return raw


def is_generated_text(text: str) -> bool:
    """True when frontmatter marks the file as a generated index."""
    fields = parse_frontmatter(text)
    for key in ("generated", "cabinet-index"):
        if fields.get(key, "").strip().lower() in _TRUE:
            return True
    return False


def prefix_text(path, limit: int = 8192) -> str:
    """Enough of the file to see frontmatter, not the whole body."""
    with path.open("rb") as handle:
        data = handle.read(limit * 4)
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return data.decode("utf-8", errors="replace")[:limit]
