"""Measure changed image area without recognizing desktop contents."""

from __future__ import annotations

import base64
from io import BytesIO

import numpy as np
from PIL import Image


def changed_area_percent(previous: str, current: str) -> float:
    """Count changed pixels on small RGB frames, ignoring JPEG-level noise.

    This is a geometric prefilter, not a model confidence or semantic score.
    Observation frames are JPEG data URLs with a maximum edge of 768 pixels.
    """
    if previous == current:
        return 0.0

    def pixels(frame: str) -> np.ndarray:
        if not frame.startswith("data:image/jpeg;base64,"):
            raise ValueError("desktop_comparison_image_invalid")
        raw = base64.b64decode(frame.partition(",")[2], validate=True)
        with Image.open(BytesIO(raw)) as image:
            if (
                image.format != "JPEG"
                or not 1 <= min(image.size) <= max(image.size) <= 768
            ):
                raise ValueError("desktop_comparison_dimensions_invalid")
            small = image.convert("RGB").resize((192, 108), Image.Resampling.BILINEAR)
            return np.asarray(small, dtype=np.int16)

    before = pixels(previous)
    after = pixels(current)
    # A pixel must differ visibly on at least one channel (24/255).
    changed = np.max(np.abs(before - after), axis=2) >= 24
    return float(np.count_nonzero(changed) * 100 / changed.size)
