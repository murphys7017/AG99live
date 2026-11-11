"""Check that the frozen AG99live product version is consistent across builds."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_PATH = ROOT / "VERSION"
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def verify_cmake_version_source(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    source_pattern = re.compile(
        r'file\(READ\s+"\$\{CMAKE_CURRENT_SOURCE_DIR\}/\.\./VERSION"\s+'
        r"AG99_PRODUCT_VERSION\)"
    )
    project_pattern = re.compile(
        r"project\([^\n]*VERSION\s+\$\{AG99_PRODUCT_VERSION\}"
    )
    if source_pattern.search(text) is None or project_pattern.search(text) is None:
        raise SystemExit(
            f"CMake project version is not bound to the root VERSION in {path}."
        )


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

    cmake_paths = (
        ROOT / "runtime-core" / "CMakeLists.txt",
        ROOT / "render-core" / "CMakeLists.txt",
    )
    for path in cmake_paths:
        verify_cmake_version_source(path)

    print(f"AG99live product version is consistent: {version}")


if __name__ == "__main__":
    main()
