"""Measure changed image area without recognizing desktop contents."""

from __future__ import annotations

import base64
from io import BytesIO

import numpy as np
from PIL import Image


def changed_area_percent(previous: str, current: str) -> float:
    """Estimate changed area using non-overlapping 12x12 RGB SSIM blocks.

    A block must lose structural similarity and have visible color differences.
    This is a deterministic visual metric, not a semantic or activity detector.
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
            return np.asarray(small, dtype=np.float32).reshape(9, 12, 16, 12, 3)

    before = pixels(previous)
    after = pixels(current)
    # Population moments for each spatial block and each RGB channel. Using
    # structure as well as luminance avoids counting a uniform brightness shift
    # as a complete scene replacement; RGB also retains color-only changes.
    axes = (1, 3)
    before_mean = before.mean(axis=axes)
    after_mean = after.mean(axis=axes)
    before_centered = before - before_mean[:, None, :, None, :]
    after_centered = after - after_mean[:, None, :, None, :]
    before_variance = (before_centered**2).mean(axis=axes)
    after_variance = (after_centered**2).mean(axis=axes)
    covariance = (before_centered * after_centered).mean(axis=axes)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    similarity = (
        (2 * before_mean * after_mean + c1) * (2 * covariance + c2)
    ) / (
        (before_mean**2 + after_mean**2 + c1)
        * (before_variance + after_variance + c2)
    )
    # Low-texture blocks can have low SSIM from tiny noise. Require a mean
    # absolute RGB difference of 12/255 as well. Equal-area blocks make their
    # fraction an area estimate; it is not an exact changed-pixel percentage.
    color_difference = np.abs(before - after).mean(axis=(1, 3, 4))
    changed = (similarity.mean(axis=-1) < 0.85) & (color_difference >= 12)
    return float(np.count_nonzero(changed) * 100 / changed.size)
