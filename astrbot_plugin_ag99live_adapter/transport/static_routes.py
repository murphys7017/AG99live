from __future__ import annotations

from pathlib import Path


def build_static_routes(
    *,
    live2ds_dir: Path,
    audio_cache_dir: Path,
    image_cache_dir: Path,
) -> dict[str, Path]:
    return {
        "/live2ds": live2ds_dir,
        "/cache/audio": audio_cache_dir,
        "/cache/images": image_cache_dir,
    }
