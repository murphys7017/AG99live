"""Synchronize generated product version fields from the root VERSION file."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_PATH = ROOT / "VERSION"
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def write_json_version(path: Path, version: str) -> None:
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["version"] = version
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not SEMVER_RE.fullmatch(version):
        raise SystemExit(f"Invalid AG99live VERSION value: {version!r}.")

    write_json_version(ROOT / "package.json", version)
    write_json_version(ROOT / "frontend" / "package.json", version)

    lock_path = ROOT / "frontend" / "package-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    lock["version"] = version
    lock["packages"][""]["version"] = version
    lock_path.write_text(
        json.dumps(lock, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    metadata_path = ROOT / "astrbot_plugin_ag99live_adapter" / "metadata.yaml"
    metadata = metadata_path.read_text(encoding="utf-8")
    updated, count = re.subn(
        r"^version:\s*\S+\s*$",
        f"version: {version}",
        metadata,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise SystemExit("Adapter metadata.yaml does not contain one version field.")
    metadata_path.write_text(updated, encoding="utf-8")
    print(f"Synchronized AG99live product version: {version}")


if __name__ == "__main__":
    main()
