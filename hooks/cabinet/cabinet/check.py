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
"""Cabinet check.

- live basenames are unique across the top level and every drawer
- history basenames are unique among themselves (a history file may reuse a live basename; that is the fade pair)
- every [[link]] in a live file or a generated index resolves
  (a memory, its history file, a path under the memory root, or a skill)
- every History footer points at a real history file
- every surface memory is present at the top level
- the live embedding set contains no generated file
- a scratch cache, if given, lists only live basenames
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from cabinet.errors import CabinetError
from cabinet.frontmatter import parse_frontmatter, read_text
from cabinet.indexgen import iter_skills
from cabinet.links import footer_targets, index_by_stem, link_targets
from cabinet.mapping import load_mapping, pin_names
from cabinet.rules import history_files, is_generated_file, live_files, rel_of
from cabinet.safety import assert_not_live_cache


@dataclass
class CheckResult:
    failures: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    info: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures

    def render(self) -> str:
        lines = ["# Cabinet check", "", f"- ok: {str(self.ok).lower()}", ""]
        if self.failures:
            lines.append("## Failures")
            lines.append("")
            for item in self.failures:
                lines.append(f"- {item}")
            lines.append("")
        if self.warnings:
            lines.append("## Warnings")
            lines.append("")
            for item in self.warnings:
                lines.append(f"- {item}")
            lines.append("")
        if self.info:
            lines.append("## Info")
            lines.append("")
            for item in self.info:
                lines.append(f"- {item}")
            lines.append("")
        return "\n".join(lines)


def _inside(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _resolve_link(root: Path, target: str, live: dict, hist: dict) -> str | None:
    if "/" in target or "\\" in target:
        rel = target.replace("\\", "/").lstrip("/")
        if not rel.endswith(".md"):
            rel = rel + ".md"
        path = root.joinpath(*rel.split("/"))
        if _inside(root, path) and path.is_file():
            return f"path:{rel}"
        return None
    if target in live:
        if len(live[target]) != 1:
            return "ambiguous-live"
        return "live"
    if target in hist:
        if len(hist[target]) != 1:
            return "ambiguous-history"
        return "history"
    return None


def _cache_names(path: Path) -> list[tuple[str, str]]:
    assert_not_live_cache(path)
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        raise CabinetError(f"cache is not a list: {path}")
    rows = []
    for entry in data:
        if not isinstance(entry, dict) or "name" not in entry:
            continue
        rows.append((str(entry["name"]), str(entry.get("rel") or "")))
    return rows


def run_check(
    memory: Path,
    mapping_path: Path | None = None,
    cache: Path | None = None,
    skills_dir: Path | None = None,
) -> CheckResult:
    memory = memory.resolve()
    result = CheckResult()
    if not memory.is_dir():
        result.failures.append(f"memory dir does not exist: {memory}")
        return result

    live = live_files(memory)
    hist = history_files(memory)
    live_by = index_by_stem(live)
    hist_by = index_by_stem(hist)

    for name, paths in live_by.items():
        if len(paths) > 1:
            rels = ", ".join(rel_of(memory, path) for path in paths)
            result.failures.append(f"duplicate live basename {name}: {rels}")
    folded: dict[str, list[str]] = {}
    for name in live_by:
        folded.setdefault(name.casefold(), []).append(name)
    for key, names in folded.items():
        if len(names) > 1:
            result.failures.append(f"live basenames differ only by case: {', '.join(names)}")
    for name, paths in hist_by.items():
        if len(paths) > 1:
            result.failures.append(f"duplicate history basename {name}")

    fade_pairs = sorted(set(live_by) & set(hist_by))
    result.info.append(f"live files: {len(live)}")
    result.info.append(f"history files: {len(hist)}")
    result.info.append(f"fade pairs (same basename in history, allowed): {len(fade_pairs)}")

    for path in live:
        if is_generated_file(path):
            result.failures.append(f"generated file is in the live embedding set: {rel_of(memory, path)}")
        rel = rel_of(memory, path)
        if rel.startswith("history/") or rel.startswith("_indexes/") or rel.startswith("_session-archive/"):
            result.failures.append(f"excluded path is in the live embedding set: {rel}")
        if path.name.lower().startswith("_index") or path.name.lower() == "memory.md":
            result.failures.append(f"excluded name is in the live embedding set: {rel}")

    scan = list(live)
    index_dir = memory / "_indexes"
    if index_dir.is_dir():
        scan.extend(path for path in sorted(index_dir.glob("*.md")) if path.is_file())

    skills: set[str] = set()
    if skills_dir is not None:
        skills = {path.parent.name for path in iter_skills(skills_dir)}
    history_only = 0
    skill_links = 0
    live_rels = {rel_of(memory, path) for path in live}
    for path in scan:
        text = read_text(path)
        rel = rel_of(memory, path)
        for target in link_targets(text):
            kind = _resolve_link(memory, target, live_by, hist_by)
            if kind is None and "/" not in target and "\\" not in target and target in skills:
                kind = "skill"
            if kind is None:
                result.failures.append(f"unresolved [[{target}]] in {rel}")
            elif kind.startswith("ambiguous"):
                result.failures.append(f"ambiguous [[{target}]] in {rel} ({kind})")
            elif kind == "history":
                history_only += 1
            elif kind == "skill":
                skill_links += 1
        if rel in live_rels:
            for name in footer_targets(text):
                dest = memory / "history" / f"{name}.md"
                if not dest.is_file():
                    result.failures.append(
                        f"History footer in {rel} points at missing history/{name}.md"
                    )
    result.info.append(f"links that resolve only to history: {history_only}")
    result.info.append(f"links that resolve to a skill: {skill_links}")

    # Footers are a live-file rule. Scanning indexes is unnecessary; they have none.
    # The loop above checks footers for every scanned file, including indexes. Fine.

    if mapping_path is not None:
        rows = load_mapping(mapping_path)
        pins = pin_names(rows)
        mapped = {row.name for row in rows}
        for name in sorted(pins):
            top = memory / f"{name}.md"
            if not top.is_file():
                result.failures.append(f"surface memory missing from the top level: {name}.md")
            elif name in live_by and any(rel_of(memory, path) != f"{name}.md" for path in live_by[name]):
                result.failures.append(f"surface memory {name} is not only at the top level")
        for name in sorted(mapped):
            if name not in live_by:
                result.failures.append(f"mapped name is not a live memory: {name}")
        for name in sorted(set(live_by) - mapped):
            result.failures.append(f"live memory is not in the mapping: {name}")
        result.info.append(f"surface: {len(pins)}")

    for path in live:
        fields = parse_frontmatter(read_text(path))
        stated = fields.get("name")
        if stated and stated != path.stem:
            result.warnings.append(f"frontmatter name {stated!r} != filename {path.stem}")

    if cache is not None:
        live_names = set(live_by)
        for name, rel in _cache_names(cache):
            rel_norm = rel.replace("\\", "/")
            generated = (
                name.lower() == "memory"
                or name.lower().startswith("_index")
                or rel_norm.startswith("_indexes/")
                or rel_norm.startswith("history/")
                or rel_norm.startswith("_session-archive/")
            )
            if generated:
                result.failures.append(f"generated or excluded file is in the embedding cache: {name} {rel}")
            elif name not in live_names:
                result.failures.append(f"cache entry is not a live memory: {name}")
        result.info.append(f"cache entries checked: {cache}")

    return result
