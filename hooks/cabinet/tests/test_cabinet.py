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
"""Fixture tests for the cabinet. No live memory directory, no live embedding cache."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cabinet.check import run_check  # noqa: E402
from cabinet.embedtext import file_hash, sha256_bytes  # noqa: E402
from cabinet.errors import CabinetError, MappingError, PinError, ReportPathError  # noqa: E402
from cabinet.guard import PinGuard  # noqa: E402
from cabinet.indexgen import write_indexes  # noqa: E402
from cabinet.mapping import load_mapping, pin_names  # noqa: E402
from cabinet.migrate import apply_plan, build_plan, run_migrate  # noqa: E402
from cabinet.ops import delete_file, move_file, rewrite_file  # noqa: E402
from cabinet.rules import DRAWERS, live_files, rel_of  # noqa: E402
from cabinet.safety import assert_not_live_cache  # noqa: E402

PY = sys.executable


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def build_fixture(root: Path) -> None:
    write(root / "MEMORY.md", "# index\nnot a memory\n")
    write(root / "pin-alpha.md", """---
name: pin-alpha
description: "the user's pinned line"
persistence: milestone
weight: 0.9
---

Stay put. [[loose|the loose one]]

History: `history/<name>.md` (what's in it).
History: `history/pin-alpha.md` (the real fade).
""".replace("\n", "\r\n"))
    write(root / "pin-beta.md", """---
name: pin-beta
description: "second pin"
persistence: milestone
weight: 0.8
---

Also stays. [[pin-alpha]]
""")
    write(root / "loose.md", """---
name: loose
description: "the real one"
---

description: the body one
A movable note. [[proj-one]] [[old-only]]
""")
    write(root / "body-flag.md", """---
name: body-flag
description: "real memory whose body mentions the flag"
---

generated: true
This sentence is the body, not frontmatter. BODY_MARKER_SHOULD_NOT_BE_INDEXED
""")
    write(root / "projects" / "alpha" / "proj-one.md", """---
name: proj-one
description: "a project note"
---

Project body. [[deep]]
""")
    write(root / "projects" / "alpha" / "nested" / "deep.md", """---
name: deep
description: "nested under a subject"
---

Nested. [[tool-one]]
""")
    write(root / "projects" / "history" / "not-fade.md", """---
name: not-fade
description: "a subject folder named history is not the fade store"
---

Still live.
""")
    write(root / "projects" / "alpha" / "flagged.md", """---
name: flagged
description: "generated on purpose"
generated: true
---

Not a memory.
""")
    write(root / "projects" / "alpha" / "_index-sneaky.md", "---\nname: sneaky\n---\nnope\n")
    write(root / "projects" / "alpha" / "_indexes" / "secret.md", "---\nname: secret\n---\nnope\n")
    write(root / "tools" / "host" / "tool-one.md", """---
name: tool-one
description: "a tool note"
---

[[person-one]]
""")
    write(root / "reference" / "people" / "person-one.md", """---
name: person-one
description: "a person note"
---

[[pin-beta]]
""")
    write(root / "history" / "pin-alpha.md", "faded text\n")
    write(root / "history" / "old-only.md", "faded whole\n")
    write(root / "history" / "README.md", "See [[wikilink]] in the rules, not a live link.\n")
    write(root / "_session-archive" / "a" / "shard.md", "archive\n")
    write(root / "stray" / "note.md", "---\nname: note\n---\nunknown folder\n")
    write(root / "not-a-memory.txt", "ignore\n")


FIXTURE_MAPPING = """# name\tdest
pin-alpha\t.
pin-beta\t.
loose\treference/people
body-flag\treference/findings
proj-one\tprojects/alpha
deep\tprojects/alpha/nested
not-fade\tprojects/history
tool-one\ttools/host
person-one\treference/people
"""


def live_rels(root: Path) -> set[str]:
    return {rel_of(root, path) for path in live_files(root)}


class RulesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "memory"
        build_fixture(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_include_and_exclude(self):
        rels = live_rels(self.root)
        self.assertIn("pin-alpha.md", rels)
        self.assertIn("loose.md", rels)
        self.assertIn("body-flag.md", rels)
        self.assertIn("projects/alpha/proj-one.md", rels)
        self.assertIn("projects/alpha/nested/deep.md", rels)
        self.assertIn("projects/history/not-fade.md", rels)
        self.assertIn("tools/host/tool-one.md", rels)
        self.assertIn("reference/people/person-one.md", rels)
        for banned in (
            "MEMORY.md",
            "history/pin-alpha.md",
            "history/README.md",
            "_session-archive/a/shard.md",
            "stray/note.md",
            "projects/alpha/flagged.md",
            "projects/alpha/_index-sneaky.md",
            "projects/alpha/_indexes/secret.md",
        ):
            self.assertNotIn(banned, rels, banned)
        self.assertEqual(len(rels), 9)


class PinAndMigrateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "memory"
        build_fixture(self.root)
        self.mapping = Path(self.tmp.name) / "map.tsv"
        self.mapping.write_text(FIXTURE_MAPPING, encoding="utf-8")
        self.guard = PinGuard(pin_names(load_mapping(self.mapping)))

    def tearDown(self):
        self.tmp.cleanup()

    def test_mutations_refuse_pins_and_leave_bytes(self):
        target = self.root / "pin-alpha.md"
        before = target.read_bytes()
        for op in (
            lambda: move_file(target, self.root / "projects" / "alpha" / "pin-alpha.md", self.guard),
            lambda: delete_file(target, self.guard),
            lambda: rewrite_file(target, "rewritten\n", self.guard),
        ):
            with self.assertRaises(PinError):
                op()
            self.assertEqual(target.read_bytes(), before)

    def test_dry_run_moves_nothing(self):
        before = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        report = Path(self.tmp.name) / "dry.md"
        plan = run_migrate(self.root, self.mapping, apply=False, report=report)
        self.assertTrue(plan.ok, plan.errors)
        self.assertFalse(plan.applied)
        self.assertIn("mode: dry-run", report.read_text(encoding="utf-8"))
        self.assertFalse((self.root / "reference" / "findings").exists())
        after = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertIn("loose.md", live_rels(self.root))

    def test_apply_is_byte_identical_and_leaves_pins(self):
        pin_before = (self.root / "pin-alpha.md").read_bytes()
        hist_before = (self.root / "history" / "pin-alpha.md").read_bytes()
        archive_before = (self.root / "_session-archive" / "a" / "shard.md").read_bytes()
        loose_hash = sha256_bytes(self.root / "loose.md")
        report = Path(self.tmp.name) / "apply.md"
        plan = run_migrate(self.root, self.mapping, apply=True, report=report)
        self.assertTrue(plan.ok, plan.errors)
        self.assertTrue(plan.applied)
        self.assertFalse((self.root / "loose.md").exists())
        moved = self.root / "reference" / "people" / "loose.md"
        self.assertTrue(moved.is_file())
        self.assertEqual(sha256_bytes(moved), loose_hash)
        self.assertEqual((self.root / "pin-alpha.md").read_bytes(), pin_before)
        self.assertEqual((self.root / "history" / "pin-alpha.md").read_bytes(), hist_before)
        self.assertEqual((self.root / "_session-archive" / "a" / "shard.md").read_bytes(), archive_before)
        self.assertTrue((self.root / "projects" / "history" / "not-fade.md").is_file())
        verified = [item for item in plan.items if item.action == "move"]
        self.assertTrue(verified)
        self.assertTrue(all(item.verified for item in verified))
        again = run_migrate(self.root, self.mapping, apply=True, report=Path(self.tmp.name) / "again.md")
        self.assertTrue(again.ok, again.errors)
        self.assertTrue(all(item.action != "move" for item in again.items))

    def test_apply_refuses_a_planned_pin_move(self):
        plan, _rows, guard = build_plan(self.root, self.mapping)
        guard.names.add("loose")
        apply_plan(plan, guard)
        self.assertTrue(plan.partial)
        self.assertTrue((self.root / "loose.md").is_file())
        self.assertFalse((self.root / "reference" / "people" / "loose.md").exists())

    def test_overwrite_is_refused(self):
        dest = self.root / "reference" / "people" / "loose.md"
        write(dest, "different bytes\n")
        kept = dest.read_bytes()
        plan = run_migrate(self.root, self.mapping, apply=True, report=None)
        self.assertFalse(plan.ok)
        self.assertFalse(plan.applied)
        self.assertTrue((self.root / "loose.md").is_file())
        self.assertEqual(dest.read_bytes(), kept)

    def test_report_cannot_land_inside_memory(self):
        with self.assertRaises(ReportPathError):
            run_migrate(self.root, self.mapping, apply=False, report=self.root / "report.md")

    def test_bad_destinations(self):
        for text in ("loose\thistory/loose\n", "loose\t../outside\n", "loose\tC:/temp/loose\n"):
            path = Path(self.tmp.name) / "bad.tsv"
            path.write_text("pin-alpha\t.\n" + text, encoding="utf-8")
            with self.assertRaises(MappingError):
                load_mapping(path)


class CheckAndIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "memory"
        build_fixture(self.root)
        self.mapping = Path(self.tmp.name) / "map.tsv"
        self.mapping.write_text(FIXTURE_MAPPING, encoding="utf-8")
        self.skills = Path(self.tmp.name) / "skills"
        write(self.skills / "demo-skill" / "SKILL.md", """---
name: demo-skill
description: "A pointer only. [[not-a-memory]] should not be linked."
---

body of the skill is not copied. BODY_SKILL
""")
        write(self.skills / "synced" / "bundled" / "SKILL.md", "---\nname: bundled\ndescription: skip\n---\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_check_passes_and_fails_the_right_cases(self):
        good = run_check(self.root, self.mapping)
        self.assertTrue(good.ok, good.failures)
        bad_root = Path(self.tmp.name) / "bad"
        write(bad_root / "only.md", """---
name: only
description: "broken"
---

[[missing-memory]]
History: `history/missing.md` (gone).
History: `history/<name>.md` (template).
""")
        write(bad_root / "projects" / "a" / "only.md", "---\nname: only\ndescription: dup\n---\n")
        bad_map = Path(self.tmp.name) / "badmap.tsv"
        bad_map.write_text("only\t.\n", encoding="utf-8")
        bad = run_check(bad_root, bad_map)
        self.assertFalse(bad.ok)
        text = "\n".join(bad.failures)
        self.assertIn("unresolved [[missing-memory]]", text)
        self.assertIn("missing history/missing.md", text)
        self.assertIn("duplicate live basename only", text)
        self.assertIn("pin only is not only at the top level", text)

    def test_a_skill_basename_resolves_and_a_missing_one_does_not(self):
        path = self.root / "loose.md"
        path.write_text(path.read_text(encoding="utf-8") + "\n[[demo-skill]]\n[[no-such-skill]]\n", encoding="utf-8")
        missing = run_check(self.root, self.mapping)
        self.assertIn("unresolved [[demo-skill]]", "\n".join(missing.failures))
        found = run_check(self.root, self.mapping, skills_dir=self.skills)
        text = "\n".join(found.failures)
        self.assertNotIn("[[demo-skill]]", text)
        self.assertIn("unresolved [[no-such-skill]]", text)
        self.assertTrue(any("resolve to a skill: 1" in item for item in found.info))

    def test_index_is_excluded_and_idempotent(self):
        guard = PinGuard(pin_names(load_mapping(self.mapping)))
        pin_before = sha256_bytes(self.root / "pin-alpha.md")
        dry = write_indexes(self.root, self.skills, guard, apply=False)
        self.assertFalse((self.root / "_indexes").exists())
        first = write_indexes(self.root, self.skills, guard, apply=True)
        second = write_indexes(self.root, self.skills, guard, apply=True)
        self.assertEqual(first, second)
        self.assertEqual(dry, first)
        written = (self.root / "_indexes" / "_index-projects.md").read_bytes()
        self.assertEqual((self.root / "_indexes" / "_index-projects.md").read_bytes(), written)
        projects = (self.root / "_indexes" / "_index-projects.md").read_text(encoding="utf-8")
        self.assertIn("[[proj-one]]", projects)
        self.assertIn("[[not-fade]]", projects)
        self.assertNotIn("BODY_MARKER_SHOULD_NOT_BE_INDEXED", projects)
        self.assertNotIn("[[pin-alpha]]", projects)
        skills = (self.root / "_indexes" / "_index-skills.md").read_text(encoding="utf-8")
        self.assertIn("`demo-skill`", skills)
        self.assertNotIn("[[", skills)
        self.assertNotIn("bundled", skills)
        self.assertNotIn("BODY_SKILL", skills)
        rels = live_rels(self.root)
        self.assertFalse(any(rel.startswith("_indexes/") for rel in rels))
        self.assertEqual(sha256_bytes(self.root / "pin-alpha.md"), pin_before)
        checked = run_check(self.root, self.mapping)
        self.assertTrue(checked.ok, checked.failures)

    def test_cache_audit_rejects_generated_names(self):
        cache = Path(self.tmp.name) / "cache.json"
        cache.write_text(json.dumps([
            {"name": "pin-alpha", "rel": "pin-alpha.md"},
            {"name": "_index-projects", "rel": "_indexes/_index-projects.md"},
        ]), encoding="utf-8")
        result = run_check(self.root, self.mapping, cache)
        self.assertFalse(result.ok)
        self.assertTrue(any("_index-projects" in item for item in result.failures))


    def test_live_cache_path_is_refused_when_named(self):
        live = Path(self.tmp.name) / "live-cache.json"
        os.environ["CABINET_LIVE_CACHE"] = str(live)
        try:
            with self.assertRaises(CabinetError):
                assert_not_live_cache(live)
        finally:
            del os.environ["CABINET_LIVE_CACHE"]
        assert_not_live_cache(live)          # nothing named -> nothing refused


class StarterTest(unittest.TestCase):
    """init on a flat folder, then the full flow: edit mapping, migrate, index, relink, check."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "memory"
        write(self.root / "who-i-am.md", '---\nname: who-i-am\ndescription: "the user"\n---\nA pin. [[garden-plan]]\n')
        write(self.root / "garden-plan.md", '---\nname: garden-plan\ndescription: "a project"\n---\nBeds.\n')
        write(self.root / "MEMORY.md", "# Index\n- [Who](who-i-am.md) - the user\n- [Garden](garden-plan.md) - beds\n"
                                       "- [Web](https://example.com/x.md)\n")
        self.mapping = self.root / "cabinet.tsv"

    def tearDown(self):
        self.tmp.cleanup()

    def test_init_dry_run_writes_nothing(self):
        from cabinet.starter import init_cabinet
        init_cabinet(self.root, self.mapping, apply=False)
        self.assertFalse(self.mapping.exists())
        self.assertFalse((self.root / "projects").exists())

    def test_init_then_full_flow(self):
        from cabinet.starter import init_cabinet, relink_index
        init_cabinet(self.root, self.mapping, apply=True)
        for d in DRAWERS:
            self.assertTrue((self.root / d).is_dir())
        rows = {r.name: r for r in load_mapping(self.mapping)}
        self.assertEqual(set(rows), {"who-i-am", "garden-plan"})
        self.assertTrue(all(r.pinned for r in rows.values()))       # nothing moves until decided
        again = init_cabinet(self.root, self.mapping, apply=True)
        self.assertTrue(any("not overwritten" in a for a in again))
        self.mapping.write_text("who-i-am\t.\ngarden-plan\tprojects/garden\n", encoding="utf-8")
        plan = run_migrate(self.root, self.mapping, True, None)
        self.assertTrue(plan.ok and plan.applied, plan.errors)
        self.assertTrue((self.root / "projects" / "garden" / "garden-plan.md").exists())
        res = relink_index(self.root, self.mapping, apply=True)
        self.assertEqual(res.changed, 1)
        self.assertEqual(res.unresolved, [])
        text = (self.root / "MEMORY.md").read_text(encoding="utf-8")
        self.assertIn("](projects/garden/garden-plan.md)", text)
        self.assertIn("](who-i-am.md)", text)
        self.assertIn("](https://example.com/x.md)", text)       # external links untouched
        self.assertEqual(relink_index(self.root, self.mapping, apply=True).changed, 0)   # idempotent
        write_indexes(self.root, self.root / "no-skills", PinGuard(pin_names(load_mapping(self.mapping))), True)
        checked = run_check(self.root, self.mapping, None, self.root / "no-skills")
        self.assertTrue(checked.ok, checked.failures)


if __name__ == "__main__":
    unittest.main()
