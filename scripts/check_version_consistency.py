"""Check that the frozen AG99live product version is consistent across builds."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_PATH = ROOT / "VERSION"
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def read_cmake_project_version(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    match = re.search(r"project\([^\n]*?VERSION\s+([^\s)]+)", text)
    if match is None:
        raise SystemExit(f"CMake project version is missing in {path}.")
    return match.group(1)


def main() -> None:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not SEMVER_RE.fullmatch(version):
        raise SystemExit(f"Invalid AG99live VERSION value: {version!r}.")

    json_paths = (ROOT / "package.json", ROOT / "frontend" / "package.json")
    for path in json_paths:
        actual = json.loads(path.read_text(encoding="utf-8"))["version"]
        if actual != version:
            raise SystemExit(f"Version mismatch in {path}: {actual!r} != {version!r}.")

    lock = json.loads(
        (ROOT / "frontend" / "package-lock.json").read_text(encoding="utf-8")
    )
    if lock["version"] != version or lock["packages"][""]["version"] != version:
        raise SystemExit("Version mismatch in frontend/package-lock.json.")

    metadata = (ROOT / "astrbot_plugin_ag99live_adapter" / "metadata.yaml").read_text(
        encoding="utf-8"
    )
    metadata_match = re.search(r"^version:\s*(\S+)\s*$", metadata, re.MULTILINE)
    if metadata_match is None or metadata_match.group(1) != version:
        raise SystemExit("Version mismatch in Adapter metadata.yaml.")

    for path in (ROOT / "runtime-core" / "CMakeLists.txt", ROOT / "render-core" / "CMakeLists.txt"):
        actual = read_cmake_project_version(path)
        if actual != version:
            raise SystemExit(f"Version mismatch in {path}: {actual!r} != {version!r}.")

    print(f"AG99live product version is consistent: {version}")


if __name__ == "__main__":
    main()
