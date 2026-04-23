from __future__ import annotations

import re

INLINE_ANIM_TAG_PATTERN = re.compile(r"<@anim\s*\{[\s\S]*?\}>\s*", re.IGNORECASE)
LEGACY_EXPRESSION_TAG_PATTERN = re.compile(r"<~[^~]*~>\s*", re.IGNORECASE)
SYSTEM_REMINDER_PATTERN = re.compile(
    r"<system_reminder>[\s\S]*?</system_reminder>",
    re.IGNORECASE,
)


def contains_hidden_output_markup(value: str) -> bool:
    text = str(value or "")
    return bool(
        SYSTEM_REMINDER_PATTERN.search(text)
        or INLINE_ANIM_TAG_PATTERN.search(text)
        or LEGACY_EXPRESSION_TAG_PATTERN.search(text)
    )


def sanitize_assistant_output_text(value: str) -> str:
    text = SYSTEM_REMINDER_PATTERN.sub("", value or "")
    text = INLINE_ANIM_TAG_PATTERN.sub("", text)
    text = LEGACY_EXPRESSION_TAG_PATTERN.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
