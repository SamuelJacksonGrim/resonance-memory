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
"""One index per drawer, plus a skills pointer index.

Written only under <memory>/_indexes/, which the live-source rules skip.
MEMORY.md is not generated. Skill bodies are not copied. No tag indexes.
"""

from __future__ import annotations

from pathlib import Path

from cabinet.errors import CabinetError
from cabinet.frontmatter import parse_frontmatter, read_text
from cabinet.guard import PinGuard
from cabinet.ops import rewrite_file
from cabinet.rules import DRAWERS, live_files, rel_of

TITLES = {
    "people": "People",
    "projects": "Projects",
    "tools": "Tools and machine",
    "reference": "Reference",
}
SKIP_SKILL_DIRS = {"synced"}
_CLIP = 500


def _line(desc: str) -> str:
    text = " ".join(desc.split())
    if len(text) > _CLIP:
        return text[: _CLIP - 3].rstrip() + "..."
    return text


def _description(path: Path) -> str:
    fields = parse_frontmatter(read_text(path))
    desc = fields.get("description") or fields.get("name") or path.stem
    return _line(desc)


def _subject(rel: str) -> str:
    parts = rel.split("/")
    middle = parts[1:-1]
    if not middle:
        return "(drawer root)"
    return "/".join(middle)


def render_drawer(memory: Path, drawer: str) -> str:
    groups: dict[str, list[tuple[str, str]]] = {}
    for path in live_files(memory):
        rel = rel_of(memory, path)
        if not rel.startswith(drawer + "/"):
            continue
        groups.setdefault(_subject(rel), []).append((path.stem, _description(path)))
    lines = [
        "---",
        f"name: _index-{drawer}",
        "description: \"Generated browse index. Not a memory. Recall must not embed this file.\"",
        "generated: true",
        "cabinet-index: true",
        f"drawer: {drawer}",
        "---",
        "",
        f"# {TITLES[drawer]}",
        "",
        "Generated index. Do not edit by hand; the next index run replaces this file.",
        "Baseline memories stay at the top of the memory directory and are not listed here.",
        "Recall does not embed this file.",
        "",
    ]
    if drawer == "tools":
        lines.extend([
            "Tool scripts stay where they live. This index does not copy them.",
            "Skills stay in `~\\.claude\\skills\\` so the harness can load them. Their pointer index is `_index-skills.md` in this folder.",
            "",
        ])
    if not groups:
        lines.append("No files in this drawer yet.")
        lines.append("")
        return "\n".join(lines)
    for subject in sorted(groups, key=str.lower):
        lines.append(f"## {subject}")
        lines.append("")
        for name, desc in sorted(groups[subject], key=lambda item: item[0].lower()):
            lines.append(f"- [[{name}]] -- {desc}")
        lines.append("")
    return "\n".join(lines)


def iter_skills(skills_dir: Path) -> list[Path]:
    if not skills_dir.is_dir():
        return []          # no skills folder (common for other users): an empty skills index, not an error
    found = []
    for child in sorted(skills_dir.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir() or child.name in SKIP_SKILL_DIRS or child.name.startswith("."):
            continue
        skill = child / "SKILL.md"
        if skill.is_file():
            found.append(skill)
    return found


def render_skills(skills_dir: Path) -> str:
    lines = [
        "---",
        "name: _index-skills",
        "description: \"Generated pointer index of ~/.claude/skills. Not a memory. Recall must not embed this file.\"",
        "generated: true",
        "cabinet-index: true",
        "drawer: skills",
        "---",
        "",
        "# Skills",
        "",
        "Pointers only. The harness loads each skill from `~\\.claude\\skills\\<name>\\SKILL.md`.",
        "Nothing here was copied. The synced tree is not indexed.",
        "These names are skills, not memory files, so they are not written as wiki links.",
        "",
    ]
    skills = iter_skills(skills_dir)
    if not skills:
        lines.append("No skills found.")
        lines.append("")
        return "\n".join(lines)
    for skill in skills:
        name = skill.parent.name
        # Skill descriptions are not memory links. Strip wiki-link marks so the
        # link check is not asked to resolve a skill's own examples.
        desc = _description(skill).replace("[[", "").replace("]]", "")
        lines.append(f"- `{name}` -- {desc}")
        lines.append(f"  - path: `{skill}`")
    lines.append("")
    return "\n".join(lines)


def index_texts(memory: Path, skills_dir: Path | None) -> dict[str, str]:
    texts = {f"_index-{drawer}.md": render_drawer(memory, drawer) for drawer in DRAWERS}
    if skills_dir is not None:
        texts["_index-skills.md"] = render_skills(skills_dir)
    return texts


def write_indexes(
    memory: Path,
    skills_dir: Path | None,
    guard: PinGuard,
    apply: bool,
) -> dict[str, str]:
    memory = memory.resolve()
    texts = index_texts(memory, skills_dir)
    out_dir = memory / "_indexes"
    if apply:
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, text in texts.items():
            if not name.startswith("_index") or not name.endswith(".md"):
                raise CabinetError(f"refusing to write a non-index name: {name}")
            path = out_dir / name
            if path.parent.resolve() != out_dir.resolve():
                raise CabinetError(f"index path escapes _indexes: {path}")
            # Same helper migrate uses. The stem is _index-*, which is not a pin.
            # A pin that somehow shared that stem would be refused here.
            rewrite_file(path, text, guard)
    return texts
