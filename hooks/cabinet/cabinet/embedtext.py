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
"""The exact string recall.ps1 embeds, and the SHA-256 it stores.

Must match tools\\recall.ps1 (2026-10-11 incremental rebuild):

  doc  = "search_document: {basename}. {description}. " + first 2200 UTF-16 units
  hash = SHA-256 hex of "{model}|{doc}" as UTF-8

Description comes from the legacy first-match line scanner, not from the
frontmatter parser. Changing that would change vectors.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from cabinet.frontmatter import read_text

DEFAULT_MODEL = "text-embedding-nomic-embed-text-v1.5"
EMBED_CHARS = 2200


def get_field(text: str, key: str, default: str) -> str:
    """Same scan as recall.ps1 Get-Field. First matching line in the whole file."""
    pattern = re.compile(rf"(?m)^\s*{re.escape(key)}:\s*[\"']?(.+?)[\"']?\s*$")
    match = pattern.search(text)
    if not match:
        return default
    return match.group(1)


def utf16_units(text: str) -> int:
    count = 0
    for char in text:
        count += 2 if ord(char) > 0xFFFF else 1
    return count


def utf16_prefix(text: str, units: int) -> str:
    """First `units` UTF-16 code units, matching .NET String.Substring on BMP text.

    If the cut would split a surrogate pair, the pair is left off. .NET would
    include a lone surrogate; these files do not end a window on one.
    """
    if utf16_units(text) <= units:
        return text
    out = []
    count = 0
    for char in text:
        need = 2 if ord(char) > 0xFFFF else 1
        if count + need > units:
            break
        out.append(char)
        count += need
    return "".join(out)


def document(name: str, text: str, description: str | None = None) -> str:
    desc = description if description is not None else get_field(text, "description", name)
    window = utf16_prefix(text, EMBED_CHARS)
    return f"search_document: {name}. {desc}. {window}"


def content_hash(name: str, text: str, model: str = DEFAULT_MODEL) -> str:
    doc = document(name, text)
    payload = f"{model}|{doc}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def file_hash(path: Path, model: str = DEFAULT_MODEL) -> str:
    text = read_text(path)
    return content_hash(path.stem, text, model)


def sha256_bytes(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()
