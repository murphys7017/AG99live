from __future__ import annotations

from astrbot_plugin_ag99live_adapter.motion.output_sanitizer import (
    contains_hidden_output_markup,
    sanitize_assistant_output_text,
)


def test_sanitize_assistant_output_text_removes_inline_anim_and_system_reminder() -> None:
    text = (
        "正常回复内容\n\n"
        "<system_reminder>internal prompt</system_reminder>\n"
        '<@anim {"mode":"inline","plan":{"schema_version":"engine.parameter_plan.v1"}}>'
    )

    sanitized = sanitize_assistant_output_text(text)

    assert sanitized == "正常回复内容"
    assert "<system_reminder>" not in sanitized
    assert "<@anim" not in sanitized


def test_contains_hidden_output_markup_detects_anim_tag() -> None:
    assert contains_hidden_output_markup('hello <@anim {"mode":"inline"}>') is True
    assert contains_hidden_output_markup("just a normal reply") is False

