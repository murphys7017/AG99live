"""Select desktop context for incoming user messages."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Any


# Keep this value stable across the Adapter/Core boundary.  AstrBot treats the
# marker as an optional event extra so older Core builds keep their existing
# behavior until the new prompt projection is deployed.
DESKTOP_CONTEXT_ALLOWED_EXTRA_KEY = "interaction.desktop_context_allowed"
DESKTOP_CONTEXT_MATCHED_KEY_EXTRA_KEY = "interaction.desktop_context_matched"

_SCREENSHOT_MODES = (
    ("keywords", "仅关键词", 0),
    ("every_message", "每条消息", 1),
    ("every_2_messages", "每 2 条消息", 2),
    ("every_3_messages", "每 3 条消息", 3),
)
SCREENSHOT_MODE_OPTIONS = tuple((mode, label) for mode, label, _ in _SCREENSHOT_MODES)
_SCREENSHOT_MODE_INTERVALS = {mode: interval for mode, _, interval in _SCREENSHOT_MODES}
SCREENSHOT_FRESHNESS_SECONDS = 2.0


class DesktopScreenshotCadence:
    """Count eligible text and voice messages within one desktop connection."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._mode = ""
        self._remaining = 0

    def should_attach(self, mode: str, *, keyword_matched: bool) -> bool:
        if mode != self._mode:
            self._mode = mode
            self._remaining = 0
        interval = _SCREENSHOT_MODE_INTERVALS.get(mode, 0)
        if keyword_matched or (interval and self._remaining == 0):
            self._remaining = max(0, interval - 1)
            return True
        if self._remaining > 0:
            self._remaining -= 1
        return False


_KEYWORD_SPLIT_RE = re.compile(r"[\s、,，;；]+")
_MAX_KEYWORDS = 64
_MAX_KEYWORD_LENGTH = 128


def parse_desktop_context_keywords(raw: Any) -> tuple[str, ...]:
    """Normalize a user-configured delimiter-separated keyword string."""

    if isinstance(raw, str):
        values: Iterable[Any] = _KEYWORD_SPLIT_RE.split(raw)
    elif isinstance(raw, (list, tuple, set, frozenset)):
        values = raw
    else:
        return ()

    keywords: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        normalized = unicodedata.normalize("NFKC", value).strip()
        if not normalized:
            continue
        normalized = normalized.casefold()
        if len(normalized) > _MAX_KEYWORD_LENGTH or normalized in seen:
            continue
        seen.add(normalized)
        keywords.append(normalized)
        if len(keywords) >= _MAX_KEYWORDS:
            break
    return tuple(keywords)


def match_desktop_context_keywords(
    text: Any,
    configured: Any,
) -> tuple[str, ...]:
    """Return configured keywords found in the current user message."""

    if not isinstance(text, str) or not text.strip():
        return ()
    normalized_text = unicodedata.normalize("NFKC", text).casefold()
    keywords = parse_desktop_context_keywords(configured)
    return tuple(keyword for keyword in keywords if keyword in normalized_text)


__all__ = [
    "DESKTOP_CONTEXT_ALLOWED_EXTRA_KEY",
    "DESKTOP_CONTEXT_MATCHED_KEY_EXTRA_KEY",
    "match_desktop_context_keywords",
    "parse_desktop_context_keywords",
]
