from __future__ import annotations

from astrbot_plugin_ag99live_adapter.motion.output_sanitizer import (
    contains_hidden_output_markup,
    sanitize_assistant_output_text,
)


def test_sanitizer_preserves_anim_text_and_removes_system_reminder() -> None:
    anim_text = (
        '<@anim {"mode":"inline","plan":'
        '{"schema_version":"engine.parameter_plan.v1"}}>'
    )
    text = (
        "正常回复内容"
        "<system_reminder>internal prompt</system_reminder>"
        f"{anim_text}"
    )

    sanitized = sanitize_assistant_output_text(text)

    assert sanitized == f"正常回复内容{anim_text}"
    assert "<system_reminder>" not in sanitized


def test_anim_tag_is_plain_text_not_hidden_output_markup() -> None:
    text = 'hello <@anim {"mode":"inline"}>'

    assert contains_hidden_output_markup(text) is False
    assert sanitize_assistant_output_text(text) == text


def test_contains_hidden_output_markup_detects_system_reminder() -> None:
    assert contains_hidden_output_markup(
        "<system_reminder>internal</system_reminder>"
    ) is True
    assert contains_hidden_output_markup("just a normal reply") is False


def test_legacy_expression_markup_is_not_a_hidden_transport_format() -> None:
    text = "保留用户可见文本 <~smile~>"

    assert contains_hidden_output_markup(text) is False
    assert sanitize_assistant_output_text(text) == text

