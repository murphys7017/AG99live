from __future__ import annotations

import asyncio
import json

import pytest

from astrbot_plugin_ag99live_adapter.motion.realtime_motion_plan import (
    RealtimeMotionPlanGenerator,
    normalize_motion_intent_payload,
    normalize_selector_output,
    validate_motion_intent_payload,
    validate_parameter_plan_payload,
)


_AXIS_NAMES = [
    "head_yaw",
    "head_roll",
    "head_pitch",
    "body_yaw",
    "body_roll",
    "gaze_x",
    "gaze_y",
    "eye_open_left",
    "eye_open_right",
    "mouth_open",
    "mouth_smile",
    "brow_bias",
]


def _complete_axes(**overrides: int) -> dict[str, int]:
    axes = {axis_name: 50 for axis_name in _AXIS_NAMES}
    axes.update(overrides)
    return axes


def _selector_completion_json(
    *,
    emotion: str = "neutral",
    mode: str = "parallel",
    duration_ms: int = 1200,
    **axis_overrides: int,
) -> str:
    return json.dumps(
        {
            "emotion": emotion,
            "mode": mode,
            "duration_ms": duration_ms,
            "axes": _complete_axes(**axis_overrides),
        },
        separators=(",", ":"),
    )


def _valid_parameter_plan() -> dict:
    return {
        "schema_version": "engine.parameter_plan.v1",
        "mode": "expressive",
        "emotion_label": "test",
        "timing": {
            "duration_ms": 1200,
            "blend_in_ms": 216,
            "hold_ms": 684,
            "blend_out_ms": 300,
        },
        "key_axes": {
            axis_name: {"value": 50}
            for axis_name in _AXIS_NAMES
        },
        "supplementary_params": [
            {
                "parameter_id": "ParamCheek",
                "target_value": 0.4,
                "weight": 0.6,
                "source_atom_id": "test.atom",
                "channel": "head_yaw",
            }
        ],
    }


def test_normalize_selector_output_defaults_missing_axes_with_warning(caplog) -> None:
    selector = normalize_selector_output(
        {
            "emotion": "curious",
            "mode": "parallel",
            "duration_ms": 1200,
            "axes": {"head_yaw": 82},
        }
    )

    assert selector["axes"]["head_yaw"] == 82
    assert selector["axes"]["head_roll"] == 50
    assert "missing axes; defaulting to 50" in caplog.text


def test_normalize_motion_intent_payload_defaults_missing_axes_with_warning(caplog) -> None:
    intent = normalize_motion_intent_payload(
        {
            "schema_version": "engine.motion_intent.v1",
            "mode": "expressive",
            "emotion_label": "curious",
            "duration_hint_ms": 900,
            "key_axes": {
                "head_yaw": {"value": 72},
            },
        }
    )

    assert intent["key_axes"]["head_yaw"]["value"] == 72
    assert intent["key_axes"]["head_roll"]["value"] == 50
    assert intent["summary"]["key_axes_count"] == len(_AXIS_NAMES)
    assert "Motion intent missing axes; defaulting to 50" in caplog.text


def test_normalize_selector_output_rejects_missing_emotion() -> None:
    with pytest.raises(ValueError, match="selector_emotion_empty"):
        normalize_selector_output(
            {
                "mode": "parallel",
                "duration_ms": 1200,
                "axes": _complete_axes(head_yaw=82),
            }
        )


def test_normalize_selector_output_boosts_subtle_non_neutral_axes() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "playful",
            "mode": "parallel",
            "duration_ms": 1200,
            "axes": _complete_axes(head_roll=54, head_pitch=53, mouth_smile=55),
        }
    )
    assert selector["axes"]["head_roll"] >= 60
    assert selector["axes"]["mouth_smile"] >= 60


def test_normalize_selector_output_keeps_neutral_near_center_axes() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "neutral",
            "mode": "parallel",
            "duration_ms": 1200,
            "axes": _complete_axes(head_roll=54, head_pitch=53, mouth_smile=55),
        }
    )
    assert selector["axes"]["head_roll"] == 54
    assert selector["axes"]["head_pitch"] == 53
    assert selector["axes"]["mouth_smile"] == 55


def test_realtime_motion_plan_generator_uses_astrbot_provider() -> None:
    class ProviderStub:
        def __init__(self) -> None:
            self.called = False
            self.last_prompt = ""
            self.last_system_prompt = ""

        async def text_chat(self, *, prompt: str, system_prompt: str):
            self.called = True
            self.last_prompt = prompt
            self.last_system_prompt = system_prompt

            class Response:
                completion_text = _selector_completion_json(
                    emotion="curious",
                    mode="parallel",
                    duration_ms=1200,
                    head_yaw=82,
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())

    intent = asyncio.run(
        generator.generate(
            user_text="what is this?",
            assistant_text="let me explain that for you",
        )
    )
    assert isinstance(intent, dict)
    valid, reason = validate_motion_intent_payload(intent)
    assert valid is True
    assert reason == ""
    assert intent["schema_version"] == "engine.motion_intent.v1"
    assert intent["mode"] == "expressive"
    assert intent["duration_hint_ms"] == 1200
    assert provider.called is True
    assert "Given text, choose axis values in [0,100] for an avatar." in provider.last_prompt
    assert "Platform context:" in provider.last_prompt
    assert "Few-shot examples (style reference, do not copy literally):" in provider.last_prompt
    assert "Return strict JSON only." in provider.last_system_prompt


def test_realtime_motion_plan_generator_accepts_incomplete_selector_output_with_warning(caplog) -> None:
    class ProviderStub:
        async def text_chat(self, *, prompt: str, system_prompt: str):
            del prompt
            del system_prompt

            class Response:
                completion_text = (
                    '{"emotion":"curious","mode":"parallel","duration_ms":1200,'
                    '"axes":{"head_yaw":82}}'
                )

            return Response()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = ProviderStub()
        realtime_motion_timeout_seconds = 2.0

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())

    intent = asyncio.run(
        generator.generate(
            user_text="what is this?",
            assistant_text="let me explain that for you",
        )
    )

    assert isinstance(intent, dict)
    assert intent["key_axes"]["head_yaw"]["value"] == 82
    assert intent["key_axes"]["head_roll"]["value"] == 50
    assert "missing axes; defaulting to 50" in caplog.text


def test_realtime_motion_plan_generator_prompt_switches_off_context_and_few_shot() -> None:
    class ProviderStub:
        def __init__(self) -> None:
            self.last_prompt = ""

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del system_prompt
            self.last_prompt = prompt

            class Response:
                completion_text = _selector_completion_json(
                    emotion="neutral",
                    mode="parallel",
                    duration_ms=1000,
                    head_yaw=50,
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0
        realtime_motion_fewshot_enabled = False
        realtime_motion_platform_context_enabled = False

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())
    intent = asyncio.run(
        generator.generate(
            user_text="好的",
            assistant_text="明白了",
        )
    )

    assert isinstance(intent, dict)
    valid, reason = validate_motion_intent_payload(intent)
    assert valid is True
    assert reason == ""
    assert "Few-shot examples (style reference, do not copy literally):" not in provider.last_prompt
    assert "Platform context:" not in provider.last_prompt


def test_validate_parameter_plan_payload_rejects_invalid_key_axes() -> None:
    invalid_plan = _valid_parameter_plan()
    invalid_plan["key_axes"] = {
        "head_yaw": {"value": 50},
    }

    valid, reason = validate_parameter_plan_payload(invalid_plan)
    assert valid is False
    assert reason == "key_axes_count_mismatch"


def test_validate_parameter_plan_payload_rejects_missing_supplementary_fields() -> None:
    broken_plan = _valid_parameter_plan()
    broken_plan["supplementary_params"] = [
        {
            "parameter_id": "ParamCheek",
            "target_value": 0.4,
            "weight": 0.6,
            "source_atom_id": "",
            "channel": "head_yaw",
        }
    ]
    valid, reason = validate_parameter_plan_payload(broken_plan)
    assert valid is False
    assert reason == "supplementary_source_atom_id_empty"
