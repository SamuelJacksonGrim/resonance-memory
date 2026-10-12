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
"""Command line for the cabinet tools.

  python -m cabinet init    --memory DIR [--apply]            create drawers + a starter cabinet.tsv
  python -m cabinet migrate --memory DIR [--apply] [--report PATH]
  python -m cabinet index   --memory DIR [--skills DIR] [--apply]
  python -m cabinet relink  --memory DIR [--apply]            point MEMORY.md's links at moved files
  python -m cabinet check   --memory DIR [--cache PATH]
  python -m cabinet list    --memory DIR
  python -m cabinet pins    --memory DIR

--mapping defaults to DIR/cabinet.tsv. Every command that writes is a dry run
unless --apply is passed. Reports are never written inside the memory directory.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from cabinet.check import run_check
from cabinet.guard import PinGuard
from cabinet.indexgen import write_indexes
from cabinet.mapping import load_mapping, pin_names
from cabinet.migrate import run_migrate
from cabinet.rules import live_records
from cabinet.starter import init_cabinet, relink_index


def _memory(value: str) -> Path:
    return Path(value)


def _mapping(args: argparse.Namespace) -> Path:
    return Path(args.mapping) if getattr(args, "mapping", None) else Path(args.memory) / "cabinet.tsv"


def cmd_init(args: argparse.Namespace) -> int:
    for line in init_cabinet(_memory(args.memory), _mapping(args), args.apply):
        print(line + ("" if args.apply else "  (dry run)"))
    return 0


def cmd_relink(args: argparse.Namespace) -> int:
    res = relink_index(_memory(args.memory), _mapping(args), args.apply)
    print(f"links retargeted: {res.changed}" + ("" if args.apply else " (dry run, not written)"))
    for u in res.unresolved:
        print(f"unresolved: {u}")
    return 0 if not res.unresolved else 1


def cmd_list(args: argparse.Namespace) -> int:
    for row in live_records(_memory(args.memory)):
        print(f"{row['rel']}")
    return 0


def cmd_pins(args: argparse.Namespace) -> int:
    for name in sorted(pin_names(load_mapping(_mapping(args)))):
        print(name)
    return 0


def cmd_migrate(args: argparse.Namespace) -> int:
    report = Path(args.report) if args.report else None
    plan = run_migrate(_memory(args.memory), _mapping(args), args.apply, report)
    text_path = report
    if text_path is None:
        from cabinet.migrate import render_report
        mode = "apply" if args.apply and plan.applied else ("apply-refused" if args.apply else "dry-run")
        print(render_report(plan, mode))
    else:
        print(f"report: {text_path}")
        print(f"ok: {str(plan.ok).lower()} applied: {str(plan.applied).lower()} errors: {len(plan.errors)}")
    return 0 if plan.ok else 1


def cmd_index(args: argparse.Namespace) -> int:
    guard = PinGuard(set())
    if _mapping(args).exists():
        guard = PinGuard(pin_names(load_mapping(_mapping(args))))
    skills = Path(args.skills) if args.skills else Path.home() / ".claude" / "skills"
    texts = write_indexes(_memory(args.memory), skills, guard, args.apply)
    for name, text in texts.items():
        print(f"{name}: {len(text.encode('utf-8'))} bytes" + ("" if args.apply else " (dry-run, not written)"))
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    cache = Path(args.cache) if args.cache else None
    skills = Path(args.skills) if args.skills else Path.home() / ".claude" / "skills"
    result = run_check(_memory(args.memory), _mapping(args), cache, skills)
    rendered = result.render()
    if args.report:
        report = Path(args.report)
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(rendered, encoding="utf-8", newline="\n")
        print(f"report: {report}")
    print(rendered)
    return 0 if result.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cabinet")
    sub = parser.add_subparsers(dest="cmd", required=True)

    list_p = sub.add_parser("list", help="print live memory paths")
    list_p.add_argument("--memory", required=True)
    list_p.set_defaults(func=cmd_list)

    pins_p = sub.add_parser("pins", help="print the mapping's '.' rows")
    pins_p.add_argument("--memory", required=True)
    pins_p.add_argument("--mapping")
    pins_p.set_defaults(func=cmd_pins)

    mig = sub.add_parser("migrate", help="move files from the mapping (dry-run unless --apply)")
    mig.add_argument("--memory", required=True)
    mig.add_argument("--mapping")
    mig.add_argument("--apply", action="store_true")
    mig.add_argument("--report")
    mig.set_defaults(func=cmd_migrate)

    idx = sub.add_parser("index", help="write drawer indexes under _indexes (dry-run unless --apply)")
    idx.add_argument("--memory", required=True)
    idx.add_argument("--skills", help="defaults to ~/.claude/skills")
    idx.add_argument("--mapping", help="defaults to DIR/cabinet.tsv; index writes are refused if they hit a pin")
    idx.add_argument("--apply", action="store_true")
    idx.set_defaults(func=cmd_index)

    chk = sub.add_parser("check", help="basenames, links, footers, pins, generated-file exclusion")
    chk.add_argument("--memory", required=True)
    chk.add_argument("--mapping")
    chk.add_argument("--cache", help="scratch embedding cache to audit; the live cache is refused")
    chk.add_argument("--skills", help="resolve [[name]] to a skill. Defaults to ~/.claude/skills")
    chk.add_argument("--report")
    chk.set_defaults(func=cmd_check)

    ini = sub.add_parser("init", help="create drawer folders + a starter cabinet.tsv (dry-run unless --apply)")
    ini.add_argument("--memory", required=True)
    ini.add_argument("--mapping")
    ini.add_argument("--apply", action="store_true")
    ini.set_defaults(func=cmd_init)

    rel = sub.add_parser("relink", help="retarget MEMORY.md links to moved files (dry-run unless --apply)")
    rel.add_argument("--memory", required=True)
    rel.add_argument("--mapping")
    rel.add_argument("--apply", action="store_true")
    rel.set_defaults(func=cmd_relink)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
