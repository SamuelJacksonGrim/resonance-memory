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
"""What counts as a live memory.

Explicit include and exclude. This is not "every .md under the root".

Included:
  <root>/<name>.md
  <root>/projects/**/<name>.md
  <root>/tools/**/<name>.md
  <root>/reference/**/<name>.md
  <root>/people/**/<name>.md   (one file per person, relation as the name tag: brother--brian.md)

Excluded even when the path would otherwise match:
  MEMORY.md (any depth)
  a file whose name starts with _index
  frontmatter generated: true, or cabinet-index: true
  top-level history/          (fade store; flat; searched only with -History)
  top-level _session-archive/
  _indexes/ at any depth
  _session-archive/ at any depth
  any other top-level folder (notes/, proposals/, stray/, ...)

history/ is excluded only as the first path segment. A subject folder that
happens to be named history under a drawer is still live. Do not create one;
the fade store is the top-level folder.

KEEP IN SYNC with recall-sources.ps1. tests compare the two on a fixture.
"""

from __future__ import annotations

from pathlib import Path

from cabinet.frontmatter import is_generated_text, prefix_text

DRAWERS = ("people", "projects", "tools", "reference")
EXCLUDED_TOP = ("history", "_session-archive", "_indexes")
EXCLUDED_ANYWHERE = ("_indexes", "_session-archive")


def _rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _excluded_by_path(rel: str) -> bool:
    parts = rel.split("/")
    if len(parts) == 1:
        return False
    dirs = parts[:-1]
    if dirs[0] in EXCLUDED_TOP:
        return True
    if dirs[0] not in DRAWERS:
        return True
    for segment in dirs:
        if segment in EXCLUDED_ANYWHERE:
            return True
    return False


def _excluded_by_name(name: str) -> bool:
    if name.lower() == "memory.md":
        return True
    if name.lower().startswith("_index"):
        return True
    return False


def is_live_path(root: Path, path: Path) -> bool:
    """Path test plus filename. Does not open the file."""
    if path.suffix.lower() != ".md":
        return False
    if not path.is_file():
        return False
    rel = _rel(root, path)
    if _excluded_by_path(rel):
        return False
    if _excluded_by_name(path.name):
        return False
    return True


def is_generated_file(path: Path) -> bool:
    if _excluded_by_name(path.name):
        return True
    try:
        text = prefix_text(path)
    except OSError:
        return False
    return is_generated_text(text)


def iter_md(root: Path):
    """Every markdown file under root, including ones the live set rejects."""
    if not root.is_dir():
        return
    for path in root.rglob("*.md"):
        if path.is_file():
            yield path


def live_files(root: Path) -> list[Path]:
    """Live memories, sorted by relative path. Generated indexes are out."""
    root = root.resolve()
    found = []
    for path in iter_md(root):
        if not is_live_path(root, path):
            continue
        if is_generated_file(path):
            continue
        found.append(path)
    found.sort(key=lambda p: _rel(root, p).lower())
    return found


def live_records(root: Path) -> list[dict]:
    root = root.resolve()
    rows = []
    for path in live_files(root):
        rows.append({
            "name": path.stem,
            "rel": _rel(root, path),
            "path": path,
        })
    return rows


def history_files(root: Path) -> list[Path]:
    """Flat fade store. Not recursive. README.md stays, matching recall -History."""
    folder = root / "history"
    if not folder.is_dir():
        return []
    found = [
        path for path in folder.glob("*.md")
        if path.is_file() and path.name.lower() != "memory.md"
    ]
    found.sort(key=lambda p: p.name.lower())
    return found


def duplicate_basenames(paths: list[Path]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for path in paths:
        groups.setdefault(path.stem, []).append(str(path))
    return {name: locs for name, locs in groups.items() if len(locs) > 1}


def rel_of(root: Path, path: Path) -> str:
    return _rel(root.resolve(), path.resolve())
