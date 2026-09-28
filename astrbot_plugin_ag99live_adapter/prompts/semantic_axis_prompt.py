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


def format_profile_axis_prompt_line(
    axis: dict[str, Any],
    *,
    truncate_text: Any,
    use_axis_levels: bool = False,
) -> str:
    axis_id = str(axis.get("id") or "").strip()
    label = str(axis.get("label") or axis_id).strip()
    role = str(axis.get("control_role") or "").strip()
    role_label = format_control_role_label(role)
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
    if use_axis_levels:
        level_range = _format_available_level_range(axis)
        return (
            f"- {axis_id}（{label}，{role_label}）："
            f"负方向会让角色{negative}；正方向会让角色{positive}。"
            f"可用等级={level_range}；超出该范围的方向对这个轴没有效果。"
            f"本轮没有对应方向的表达需要时省略此轴。{description}{suffix}"
        ).strip()
    return (
        f"- {axis_id}（{label}，{role_label}，范围 {range_text}）："
        f"向较小值调整会让角色{negative}；"
        f"向较大值调整会让角色{positive}。"
        f"本轮没有对应方向的表达需要时省略此轴。{description}{suffix}"
    ).strip()


def format_axis_semantics(values: Any, *, truncate_text: Any) -> str:
    if not isinstance(values, list):
        return ""
    return ", ".join(
        truncate_text(str(item).strip(), 48)
        for item in values
        if str(item).strip()
    )


def _format_available_level_range(axis: dict[str, Any]) -> str:
    effective_levels = resolve_available_axis_levels(axis)
    return f"{min(effective_levels)}..{max(effective_levels)}"


def resolve_available_axis_levels(axis: dict[str, Any]) -> list[int]:
    anchors = axis.get("level_anchors")
    neutral = axis.get("neutral")
    if not isinstance(anchors, dict) or not isinstance(neutral, (int, float)):
        raise ValueError("semantic_axis_level_anchors_unavailable")
    effective_levels: list[int] = [0]
    for raw_level, raw_anchor in anchors.items():
        try:
            level = int(raw_level)
            anchor = float(raw_anchor)
        except (TypeError, ValueError):
            continue
        if -4 <= level <= 4 and abs(anchor - float(neutral)) > 1e-6:
            effective_levels.append(level)
    return sorted(set(effective_levels))


def format_control_role_label(role: str) -> str:
    if role == "primary":
        return "主要控制参数"
    if role == "hint":
        return "辅助细节参数"
    return "可控制参数"
