from __future__ import annotations

from typing import Any


def profile_prompt_axes(semantic_profile: dict[str, Any]) -> list[dict[str, Any]]:
    axes = semantic_profile.get("axes")
    if not isinstance(axes, list):
        raise ValueError("semantic_profile_axes_not_list")

    result: list[dict[str, Any]] = []
    for axis in axes:
        if not isinstance(axis, dict):
            continue
        role = str(axis.get("control_role") or "").strip()
        if role not in {"primary", "hint"}:
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        result.append(axis)
    if not result:
        raise ValueError("semantic_profile_has_no_prompt_axes")
    return result


def build_profile_axis_prompt_block(
    semantic_profile: dict[str, Any],
    *,
    truncate_text: Any,
) -> tuple[str, list[str]]:
    prompt_axes = profile_prompt_axes(semantic_profile)
    axis_block = "\n".join(
        format_profile_axis_prompt_line(axis, truncate_text=truncate_text)
        for axis in prompt_axes
    )
    allowed_axis_ids = [str(axis.get("id") or "").strip() for axis in prompt_axes]
    return axis_block, allowed_axis_ids


def format_profile_axis_prompt_line(
    axis: dict[str, Any],
    *,
    truncate_text: Any,
) -> str:
    axis_id = str(axis.get("id") or "").strip()
    label = str(axis.get("label") or axis_id).strip()
    role = str(axis.get("control_role") or "").strip()
    role_label = format_control_role_label(role)
    neutral = axis.get("neutral", 50)
    value_range = axis.get("value_range")
    range_text = "[0,100]"
    if (
        isinstance(value_range, list)
        and len(value_range) == 2
        and isinstance(value_range[0], (int, float))
        and isinstance(value_range[1], (int, float))
    ):
        range_text = f"[{float(value_range[0]):g},{float(value_range[1]):g}]"
    negative = format_axis_semantics(axis.get("negative_semantics"), truncate_text=truncate_text) or "负方向"
    positive = format_axis_semantics(axis.get("positive_semantics"), truncate_text=truncate_text) or "正方向"
    notes = truncate_text(str(axis.get("usage_notes") or "").strip(), 160)
    description = truncate_text(str(axis.get("description") or "").strip(), 160)
    suffix = f" 使用说明={notes}" if notes else ""
    return (
        f"- {axis_id}（{label}，{role_label}，范围 {range_text}，中性值 {neutral}）："
        f"低值={negative}；高值={positive}。{description}{suffix}"
    ).strip()


def format_axis_semantics(values: Any, *, truncate_text: Any) -> str:
    if not isinstance(values, list):
        return ""
    return ", ".join(
        truncate_text(str(item).strip(), 48)
        for item in values
        if str(item).strip()
    )


def format_control_role_label(role: str) -> str:
    if role == "primary":
        return "主要控制参数"
    if role == "hint":
        return "辅助细节参数"
    return "可控制参数"
