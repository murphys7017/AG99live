from __future__ import annotations

import json
from typing import Any


def build_inline_motion_contract(
    *,
    semantic_profile: dict[str, Any],
    motion_instruction: str,
) -> str:
    template_payload = {
        "mode": "inline",
        "intent": build_inline_motion_intent_template(semantic_profile),
    }
    template_tag = f"<@anim {json.dumps(template_payload, ensure_ascii=False, separators=(',', ':'))}>"
    selected_model = str(semantic_profile.get("model_id") or "").strip()
    prompt_axis_lines = build_inline_motion_axis_lines(semantic_profile)

    lines = [
        "AG99live inline motion contract:",
        "Write your normal assistant reply first.",
        "Then append exactly one final line containing only a single <@anim ...> tag.",
        "Do not wrap the tag in a code block and do not explain the tag.",
        "The JSON inside the tag must be valid JSON.",
        "Top-level tag payload must use `mode: \"inline\"` and an `intent` object.",
        "The `intent.schema_version` must be `engine.motion_intent.v2`.",
        "The intent must include `profile_id`, `profile_revision`, and `model_id` exactly as shown in the template.",
        "The `intent.mode` must be `idle` or `expressive`.",
        "The `intent.axes` object may only include primary/hint axes listed below.",
        "Do not output derived/runtime/ambient/debug axes.",
        "The `intent.duration_hint_ms` should be a reasonable duration hint in milliseconds.",
        "If the turn is calm or uncertain, emit a safe idle intent instead of omitting the tag.",
    ]
    if motion_instruction:
        lines.append(f"Additional motion instruction: {motion_instruction}")
    if selected_model:
        lines.append(f"Current Live2D model: {selected_model}.")
    lines.append("Allowed semantic axes:")
    lines.extend(prompt_axis_lines)
    lines.append("Use this tag template structure and fill in suitable values:")
    lines.append(template_tag)
    return "\n".join(lines)


def build_inline_motion_axis_lines(semantic_profile: dict[str, Any]) -> list[str]:
    axes = semantic_profile.get("axes")
    if not isinstance(axes, list):
        return []
    lines: list[str] = []
    for axis in axes:
        if not isinstance(axis, dict):
            continue
        role = str(axis.get("control_role") or "").strip()
        if role not in {"primary", "hint"}:
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        label = str(axis.get("label") or axis_id).strip()
        negative = ", ".join(
            str(item).strip()
            for item in axis.get("negative_semantics", [])
            if str(item).strip()
        )
        positive = ", ".join(
            str(item).strip()
            for item in axis.get("positive_semantics", [])
            if str(item).strip()
        )
        lines.append(
            f"- {axis_id} ({label}, role={role}): "
            f"low={negative or 'negative'}; high={positive or 'positive'}"
        )
    return lines


def build_inline_motion_intent_template(semantic_profile: dict[str, Any]) -> dict[str, Any]:
    axes: dict[str, dict[str, float]] = {}
    for axis in semantic_profile.get("axes", []):
        if not isinstance(axis, dict):
            continue
        role = str(axis.get("control_role") or "").strip()
        if role not in {"primary", "hint"}:
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        neutral = axis.get("neutral", 50)
        axes[axis_id] = {"value": float(neutral) if isinstance(neutral, (int, float)) else 50.0}
    if not axes:
        raise RuntimeError("SemanticAxisProfile has no primary/hint axes for inline motion contract.")
    return {
        "schema_version": "engine.motion_intent.v2",
        "profile_id": str(semantic_profile.get("profile_id") or "").strip(),
        "profile_revision": int(semantic_profile.get("revision") or 0),
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "mode": "idle",
        "emotion_label": "neutral",
        "duration_hint_ms": 1200,
        "axes": axes,
        "summary": {
            "axis_count": len(axes),
        },
    }

