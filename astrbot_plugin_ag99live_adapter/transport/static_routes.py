from __future__ import annotations

from pathlib import Path


def build_static_routes(
    *,
    live2ds_dir: Path,
    assets_dir: Path,
    runtime_cache_dir: Path,
) -> dict[str, Path]:
    return {
        "/live2ds": live2ds_dir,
        "/bg": assets_dir / "backgrounds",
        "/avatars": assets_dir / "avatars",
        "/cache": runtime_cache_dir,
    }


def list_background_files(assets_dir: Path) -> list[str]:
    bg_dir = assets_dir / "backgrounds"
    if not bg_dir.exists():
        return []

    return sorted(
        [
            entry.name
            for entry in bg_dir.iterdir()
            if entry.is_file() and entry.name.lower() != "readme.md"
        ]
    )
