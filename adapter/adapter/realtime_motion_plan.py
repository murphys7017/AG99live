from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AxisSpec:
    name: str
    channel: str
    low_label: str
    mid_label: str
    high_label: str


AXES: list[AxisSpec] = [
    AxisSpec("head_yaw", "head_yaw", "turn left", "center", "turn right"),
    AxisSpec("head_roll", "head_roll", "tilt left", "center", "tilt right"),
    AxisSpec("head_pitch", "head_pitch", "look down", "center", "look up"),
    AxisSpec("body_yaw", "body_yaw", "twist left", "center", "twist right"),
    AxisSpec("body_roll", "body_roll", "lean left", "center", "lean right"),
    AxisSpec("gaze_x", "gaze_x", "look left", "center", "look right"),
    AxisSpec("gaze_y", "gaze_y", "look down", "center", "look up"),
    AxisSpec("eye_open_left", "eye_open_left", "closed", "normal", "wide open"),
    AxisSpec("eye_open_right", "eye_open_right", "closed", "normal", "wide open"),
    AxisSpec("mouth_open", "mouth_open", "closed", "normal", "open"),
    AxisSpec("mouth_smile", "mouth_smile", "frown", "neutral", "smile"),
    AxisSpec("brow_bias", "brow_bias", "frown", "neutral", "raised"),
]

_SYSTEM_PROMPT = (
    "You are a compact emotion-to-axis selector for live avatar control. "
    "Return strict JSON only."
)


class RealtimeMotionPlanGenerator:
    def __init__(self, *, runtime_state: Any) -> None:
        self.runtime_state = runtime_state

    async def generate(
        self,
        *,
        user_text: str,
        assistant_text: str,
    ) -> dict[str, Any] | None:
        if not bool(getattr(self.runtime_state, "enable_realtime_motion_plan", True)):
            return None

        library = resolve_selected_parameter_action_library(
            getattr(self.runtime_state, "model_info", {}),
        )
        if not isinstance(library, dict):
            return None

        context_text = build_selector_context(user_text=user_text, assistant_text=assistant_text)
        selector_raw = await self._call_astrbot_selector(context_text)
        selector = normalize_selector_output(selector_raw)
        plan = build_plan_from_axes(selector, library=library)
        steps = plan.get("steps")
        if not isinstance(steps, list) or not steps:
            return None
        return plan

    async def _call_astrbot_selector(self, context_text: str) -> dict[str, Any]:
        provider = getattr(self.runtime_state, "selected_motion_analysis_provider", None)
        if provider is None:
            raise RuntimeError(
                "AstrBot motion provider is unavailable. "
                "Configure `motion_analysis_provider_id` or set a current chat provider."
            )

        timeout = float(getattr(self.runtime_state, "realtime_motion_timeout_seconds", 8.0) or 8.0)
        response = await asyncio.wait_for(
            provider.text_chat(
                prompt=build_selector_user_prompt(context_text),
                system_prompt=_SYSTEM_PROMPT,
            ),
            timeout=timeout,
        )
        completion_text = str(getattr(response, "completion_text", "") or "").strip()
        if not completion_text:
            raise RuntimeError("AstrBot motion provider returned empty completion_text.")
        return _extract_json_object(completion_text)


def resolve_selected_parameter_action_library(model_info: Any) -> dict[str, Any] | None:
    if not isinstance(model_info, dict):
        return None
    models = [item for item in model_info.get("models", []) if isinstance(item, dict)]
    if not models:
        return None

    selected_model_name = str(model_info.get("selected_model") or "").strip()
    if selected_model_name:
        for model in models:
            if str(model.get("name") or "").strip() == selected_model_name:
                library = model.get("parameter_action_library")
                if isinstance(library, dict):
                    return library

    for model in models:
        library = model.get("parameter_action_library")
        if isinstance(library, dict):
            return library
    return None


def build_selector_context(*, user_text: str, assistant_text: str) -> str:
    user = (user_text or "").strip()
    assistant = (assistant_text or "").strip()

    if user and assistant:
        return (
            "Generate expression controls for this dialog turn.\n"
            f"User: {_truncate_text(user, 260)}\n"
            f"Assistant: {_truncate_text(assistant, 320)}"
        )
    if assistant:
        return _truncate_text(assistant, 360)
    return _truncate_text(user, 360)


def build_selector_user_prompt(text: str) -> str:
    lines: list[str] = []
    for axis in AXES:
        lines.append(
            f"- {axis.name}: 0={axis.low_label}, 50={axis.mid_label}, 100={axis.high_label}"
        )
    axis_block = "\n".join(lines)
    return (
        "Given text, choose axis values in [0,100] for an avatar.\n"
        f"Axes:\n{axis_block}\n\n"
        "Return JSON only with this schema:\n"
        "{\n"
        '  "emotion": "short-label",\n'
        '  "mode": "parallel or sequential",\n'
        '  "duration_ms": 1200,\n'
        '  "axes": {"head_yaw": 50, "head_roll": 50}\n'
        "}\n"
        "Rules:\n"
        "- Include all listed axes.\n"
        "- Use integers only.\n"
        "- Keep subtle unless text is intense.\n"
        "- If uncertain, stay around 45~55.\n\n"
        f"Text: {text}"
    )


def normalize_selector_output(payload: dict[str, Any]) -> dict[str, Any]:
    raw_axes = payload.get("axes")
    axes_payload = raw_axes if isinstance(raw_axes, dict) else {}
    axes = {
        axis.name: clamp_axis_value(axes_payload.get(axis.name, 50))
        for axis in AXES
    }

    mode = str(payload.get("mode") or "parallel").strip().lower()
    if mode not in {"parallel", "sequential"}:
        mode = "parallel"

    duration_ms_raw = payload.get("duration_ms", 1200)
    try:
        duration_ms = int(round(float(duration_ms_raw)))
    except (TypeError, ValueError):
        duration_ms = 1200
    duration_ms = max(400, min(6000, duration_ms))

    emotion = str(payload.get("emotion") or "neutral").strip() or "neutral"

    return {
        "emotion": emotion,
        "mode": mode,
        "duration_ms": duration_ms,
        "axes": axes,
    }


def build_plan_from_axes(
    selector_output: dict[str, Any],
    *,
    library: dict[str, Any],
) -> dict[str, Any]:
    mode = str(selector_output.get("mode") or "parallel").strip().lower()
    if mode not in {"parallel", "sequential"}:
        mode = "parallel"

    raw_atoms = library.get("atoms")
    atoms = [atom for atom in raw_atoms if isinstance(atom, dict)] if isinstance(raw_atoms, list) else []
    axes = selector_output.get("axes")
    axis_values = axes if isinstance(axes, dict) else {}

    steps: list[dict[str, Any]] = []
    cursor_ms = 0

    for axis in AXES:
        value = clamp_axis_value(axis_values.get(axis.name, 50))
        delta = value - 50
        normalized_strength = abs(delta) / 50.0
        if normalized_strength < 0.18:
            continue

        polarity = "positive" if delta > 0 else "negative"
        atom = _pick_atom_for_channel(
            atoms,
            channel=axis.channel,
            polarity=polarity,
        )
        if not isinstance(atom, dict):
            continue

        atom_duration_ms = max(120, int(round(float(atom.get("duration") or 0.6) * 1000)))
        duration_ms = max(120, int(round(atom_duration_ms * (0.65 + normalized_strength * 0.8))))
        intensity = round(
            max(
                0.05,
                min(
                    _strength_to_base_intensity(str(atom.get("strength") or "")) * normalized_strength * 1.8,
                    2.0,
                ),
            ),
            3,
        )
        start_ms = 0 if mode == "parallel" else cursor_ms

        steps.append(
            {
                "atom_id": str(atom.get("id") or ""),
                "channel": str(atom.get("primary_channel") or axis.channel),
                "start_ms": start_ms,
                "duration_ms": duration_ms,
                "intensity": intensity,
                "source_motion": str(atom.get("source_motion") or ""),
                "source_file": str(atom.get("source_file") or ""),
                "source_group": str(atom.get("source_group") or ""),
                "semantic_polarity": str(atom.get("semantic_polarity") or polarity),
                "trait": str(atom.get("trait") or ""),
            }
        )

        if mode == "sequential":
            cursor_ms += duration_ms + 120

    if not steps:
        fallback_atom = _pick_fallback_atom(atoms)
        if isinstance(fallback_atom, dict):
            steps.append(
                {
                    "atom_id": str(fallback_atom.get("id") or ""),
                    "channel": str(fallback_atom.get("primary_channel") or ""),
                    "start_ms": 0,
                    "duration_ms": max(120, int(round(float(fallback_atom.get("duration") or 0.5) * 1000))),
                    "intensity": 0.35,
                    "source_motion": str(fallback_atom.get("source_motion") or ""),
                    "source_file": str(fallback_atom.get("source_file") or ""),
                    "source_group": str(fallback_atom.get("source_group") or ""),
                    "semantic_polarity": str(fallback_atom.get("semantic_polarity") or "positive"),
                    "trait": str(fallback_atom.get("trait") or ""),
                }
            )

    total_duration_ms = max([step["start_ms"] + step["duration_ms"] for step in steps] + [0])
    return {
        "schema_version": "engine.motion_plan_preview.v1",
        "mode": mode,
        "selected_atom_count": len(steps),
        "channels": sorted(
            {
                str(step.get("channel") or "").strip()
                for step in steps
                if str(step.get("channel") or "").strip()
            }
        ),
        "parameters": {
            "duration_scale": 1.0,
            "intensity_scale": 1.0,
            "sequential_gap_ms": 120,
            "emotion_label": str(selector_output.get("emotion") or "neutral"),
        },
        "summary": {
            "total_duration_ms": total_duration_ms,
            "step_count": len(steps),
        },
        "steps": steps,
    }


def clamp_axis_value(value: Any) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        number = 50
    return max(0, min(100, number))


def _pick_atom_for_channel(
    atoms: list[dict[str, Any]],
    *,
    channel: str,
    polarity: str,
) -> dict[str, Any] | None:
    channel_atoms = [
        atom
        for atom in atoms
        if str(atom.get("primary_channel") or "").strip() == channel
    ]
    if not channel_atoms:
        return None

    polarity_atoms = [
        atom
        for atom in channel_atoms
        if str(atom.get("polarity") or "").strip() == polarity
    ]
    candidates = polarity_atoms if polarity_atoms else channel_atoms
    ranked = sorted(
        candidates,
        key=lambda atom: (
            -float(atom.get("score") or 0.0),
            -float(atom.get("energy_score") or 0.0),
            str(atom.get("id") or ""),
        ),
    )
    return ranked[0] if ranked else None


def _pick_fallback_atom(atoms: list[dict[str, Any]]) -> dict[str, Any] | None:
    ranked = sorted(
        atoms,
        key=lambda atom: (
            -float(atom.get("score") or 0.0),
            -float(atom.get("energy_score") or 0.0),
            str(atom.get("id") or ""),
        ),
    )
    return ranked[0] if ranked else None


def _strength_to_base_intensity(strength: str) -> float:
    mapping = {
        "none": 0.0,
        "low": 0.35,
        "medium": 0.7,
        "high": 1.0,
    }
    return mapping.get(str(strength or "").strip(), 0.5)


def _extract_json_object(text: str) -> dict[str, Any]:
    normalized = str(text or "").strip()
    if not normalized:
        raise ValueError("Selector response is empty.")

    try:
        payload = json.loads(normalized)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", normalized, flags=re.DOTALL)
    if not match:
        raise ValueError("Selector response does not contain a JSON object.")

    payload = json.loads(match.group(0))
    if not isinstance(payload, dict):
        raise ValueError("Selector payload is not a JSON object.")
    return payload


def _truncate_text(value: str, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."
