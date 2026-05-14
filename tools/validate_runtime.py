#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


REQUIRED = [
    "AGENTS.md",
    ".ai/index.md",
    ".ai/state.yaml",
]

INDEX_TERMS = [
    "Fast Path",
    "Route",
    "Risk",
    "Execute",
    "Checklists",
    "Continuity",
    "State",
    "documentation",
    "feature",
    "bugfix",
    "refactor",
    "review",
    "release",
    "maintenance",
    "low",
    "medium",
    "high",
]

STATE_TERMS = [
    "task:",
    "class:",
    "risk:",
    "context:",
    "assumptions:",
    "architecture:",
    "verification:",
    "checks_run:",
    "validation_gap:",
]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Validate the minimal AI runtime.")
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--warnings-as-errors", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    errors: list[str] = []

    for rel in REQUIRED:
        if not (root / rel).exists():
            errors.append(f"{rel}: missing")

    index = root / ".ai/index.md"
    if index.exists():
        text = index.read_text(encoding="utf-8")
        for term in INDEX_TERMS:
            if term not in text:
                errors.append(f".ai/index.md: missing {term}")

    state = root / ".ai/state.yaml"
    if state.exists():
        text = state.read_text(encoding="utf-8")
        for term in STATE_TERMS:
            if term not in text:
                errors.append(f".ai/state.yaml: missing {term}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print(f"\nSummary: {len(errors)} error(s)")
        return 1

    print(f"PASS: minimal AI runtime validation succeeded for {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
