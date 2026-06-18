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
from astrbot_plugin_ag99live_adapter.prompts.motion_selector import (
    DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES,
    resolve_selector_few_shot_examples,
)
from astrbot_plugin_ag99live_adapter.motion.inline_motion import summarize_motion_payload


_AXIS_NAMES = [
    "head_yaw",
    "head_roll",
    "head_pitch",
    "body_yaw",
    "body_roll",
    "body_pitch",
    "eye_open_left",
    "eye_open_right",
    "eye_smile_left",
    "eye_smile_right",
    "gaze_x",
    "gaze_y",
    "mouth_smile",
    "mouth_x",
    "brow_bias",
    "brow_left_detail",
    "brow_right_detail",
    "mouth_open",
    "breath",
]


def _semantic_profile() -> dict:
    return {
        "schema_version": "ag99.semantic_axis_profile.v1",
        "profile_id": "DemoModel.semantic.v1",
        "model_id": "DemoModel",
        "source_hash": "hash",
        "last_scanned_hash": "hash",
        "revision": 3,
        "status": "user_modified",
        "user_modified": True,
        "generated_at": "2026-04-26T00:00:00+00:00",
        "updated_at": "2026-04-26T00:00:00+00:00",
        "axes": [
            {
                "id": "head_yaw",
                "label": "Head Yaw",
                "description": "turn head left/right",
                "semantic_group": "head",
                "control_role": "primary",
                "neutral": 50,
                "value_range": [0, 100],
                "soft_range": [42, 58],
                "strong_range": [30, 70],
                "positive_semantics": ["turn right"],
                "negative_semantics": ["turn left"],
                "usage_notes": "Use for attention direction.",
                "parameter_bindings": [
                    {
                        "parameter_id": "ParamAngleX",
                        "parameter_name": "Angle X",
                        "input_range": [0, 100],
                        "output_range": [-30, 30],
                        "default_weight": 1,
                        "invert": False,
                    }
                ],
            },
            {
                "id": "debug_tail",
                "label": "Tail",
                "description": "debug only",
                "semantic_group": "debug",
                "control_role": "debug",
                "neutral": 50,
                "value_range": [0, 100],
                "soft_range": [45, 55],
                "strong_range": [35, 65],
                "positive_semantics": ["up"],
                "negative_semantics": ["down"],
                "usage_notes": "Do not expose.",
                "parameter_bindings": [],
            },
        ],
        "couplings": [],
    }


def _model_info() -> dict:
    profile = _semantic_profile()
    return {
        "selected_model": "DemoModel",
        "models": [
            {
                "name": "DemoModel",
                "semantic_axis_profile": profile,
                "motion_resource_pool": {
                    "driver_components": [
                        {
                            "id": "Motions/serious.motion3.json#ParamAngleX",
                            "source_motion": "serious",
                            "source_file": "Motions/serious.motion3.json",
                            "parameter_id": "ParamAngleX",
                            "engine_role": "driver",
                            "strength": "medium",
                            "trait": "sustain",
                            "energy_score": 0.6,
                            "peak_time_ratio": 0.4,
                            "value_profile": {
                                "baseline": 0,
                                "min": 0,
                                "max": 20,
                            },
                        },
                        {
                            "id": "Motions/serious.motion3.json#ParamHairX",
                            "source_motion": "serious",
                            "source_file": "Motions/serious.motion3.json",
                            "parameter_id": "ParamHairX",
                            "engine_role": "driver",
                            "strength": "high",
                            "trait": "oscillate",
                            "energy_score": 4,
                            "peak_time_ratio": 0.5,
                            "value_profile": {
                                "baseline": 0,
                                "min": -1,
                                "max": 1,
                            },
                        },
                    ],
                    "motion_presets": [
                        {
                            "motion_name": "serious",
                            "motion_file": "Motions/serious.motion3.json",
                            "intensity": "medium",
                            "catalog_tags": ["serious", "explain"],
                        }
                    ],
                },
                "constraints": {
                    "motions": [
                        {
                            "name": "serious",
                            "file": "Motions/serious.motion3.json",
                            "group": "TapBody",
                            "catalog_id": "serious_explain",
                            "catalog_label": "认真说明",
                            "catalog_description": "姿态更稳定、更像进入解释状态。",
                            "catalog_intensity": "medium",
                            "catalog_tags": ["serious", "explain"],
                            "catalog_emotion_bias": ["neutral", "thinking"],
                            "recommended_scenarios": ["说明问题"],
                            "duration": 3.0,
                        }
                    ],
                    "expressions": [
                        {
                            "name": "Question",
                            "file": "Expressions/Question.exp3.json",
                            "category": "base_emotion",
                            "intensity": "medium",
                            "parameters": [],
                            "dominant_parameters": [{"id": "ExpQuestion"}],
                        }
                    ],
                },
            }
        ],
    }


def _semantic_profile_with_prompt_axes(count: int) -> dict:
    profile = _semantic_profile()
    template = profile["axes"][0]
    profile["axes"] = [
        {
            **template,
            "id": f"axis_{index}",
            "label": f"Axis {index}",
            "parameter_bindings": [
                {
                    **template["parameter_bindings"][0],
                    "parameter_id": f"ParamAxis{index}",
                }
            ],
        }
        for index in range(count)
    ]
    return profile


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
        "schema_version": "engine.parameter_plan.v2",
        "profile_id": "DemoModel.semantic.v1",
        "profile_revision": 3,
        "model_id": "DemoModel",
        "mode": "expressive",
        "emotion_label": "test",
        "timing": {
            "duration_ms": 1200,
            "blend_in_ms": 216,
            "hold_ms": 684,
            "blend_out_ms": 300,
        },
        "parameters": [
            {
                "axis_id": "head_yaw",
                "parameter_id": "ParamCheek",
                "target_value": 0.2,
                "weight": 0.6,
                "input_value": 62,
                "source": "semantic_axis",
            }
        ],
    }


def test_normalize_selector_output_requires_semantic_profile() -> None:
    with pytest.raises(ValueError, match="semantic_profile_required"):
        normalize_selector_output(
            {
                "emotion": "curious",
                "mode": "parallel",
                "duration_ms": 1200,
                "axes": {"head_yaw": 82},
            }
        )


def test_normalize_motion_intent_payload_rejects_v1_legacy_axes() -> None:
    with pytest.raises(ValueError, match="invalid_schema_version"):
        normalize_motion_intent_payload(
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


def test_normalize_motion_intent_payload_accepts_v2_semantic_axes() -> None:
    intent = normalize_motion_intent_payload(
        {
            "schema_version": "engine.motion_intent.v2",
            "profile_id": "DemoModel.semantic.v1",
            "profile_revision": 3,
            "model_id": "DemoModel",
            "mode": "expressive",
            "emotion_label": "curious",
            "duration_hint_ms": 900,
            "axes": {
                "head_yaw": {"value": 72},
            },
        }
    )

    assert intent["schema_version"] == "engine.motion_intent.v2"
    assert intent["axes"]["head_yaw"]["value"] == 72
    assert intent["summary"]["axis_count"] == 1


def test_normalize_motion_intent_v3_accepts_string_number_axis() -> None:
    intent = normalize_motion_intent_payload(
        {
            "schema_version": "engine.motion_intent.v3",
            "profile_id": "DemoModel.semantic.v1",
            "profile_revision": 3,
            "model_id": "DemoModel",
            "mode": "expressive",
            "intent_tags": ["curious"],
            "duration_hint_ms": "900",
            "axes": {
                "head_yaw": "72.5",
            },
        }
    )

    assert intent["schema_version"] == "engine.motion_intent.v3"
    assert intent["duration_hint_ms"] == 900
    assert intent["axes"]["head_yaw"] == 72.5


def test_normalize_motion_intent_v3_supports_intent_tags_and_resource_id() -> None:
    intent = normalize_motion_intent_payload(
        {
            "schema_version": "engine.motion_intent.v3",
            "profile_id": "DemoModel.semantic.v1",
            "profile_revision": 3,
            "model_id": "DemoModel",
            "mode": "expressive",
            "intent_tags": ["感激", "温和", "低头致谢", "感激"],
            "resource_id": " expr_thanks_smile ",
            "duration_hint_ms": 900,
            "axes": {
                "head_yaw": 72.5,
            },
        }
    )

    assert intent["intent_tags"] == ["感激", "温和", "低头致谢"]
    assert intent["emotion_label"] == "感激-温和-低头致谢"
    assert intent["resource_id"] == "expr_thanks_smile"
    assert intent["summary"]["intent_tag_count"] == 3


def test_summarize_motion_payload_defaults_v3_mode_to_expressive() -> None:
    schema_version, mode, axis_count, supplementary_count, failure_reason = summarize_motion_payload(
        {
            "schema_version": "engine.motion_intent.v3",
            "profile_id": "DemoModel.semantic.v1",
            "profile_revision": 3,
            "model_id": "DemoModel",
            "intent_tags": ["curious"],
            "duration_hint_ms": 900,
            "axes": {
                "head_yaw": 72.5,
            },
        }
    )

    assert schema_version == "engine.motion_intent.v3"
    assert mode == "expressive"
    assert axis_count == 1
    assert supplementary_count == 0
    assert failure_reason == ""


def test_normalize_motion_intent_v3_rejects_nested_axis_payload() -> None:
    with pytest.raises(ValueError, match="axis_payload_invalid:head_yaw"):
        normalize_motion_intent_payload(
            {
                "schema_version": "engine.motion_intent.v3",
                "profile_id": "DemoModel.semantic.v1",
                "profile_revision": 3,
                "model_id": "DemoModel",
                "mode": "expressive",
                "intent_tags": ["curious"],
                "duration_hint_ms": 900,
                "axes": {
                    "head_yaw": {"value": 72},
                },
            }
        )


def test_normalize_selector_output_v3_clamps_out_of_range_axis(caplog) -> None:
    selector = normalize_selector_output(
        {
            "intent_tags": ["curious"],
            "duration_hint_ms": 1200,
            "axes": {"head_yaw": 180},
        },
        semantic_profile=_semantic_profile(),
    )

    assert selector["axes"]["head_yaw"] == 100
    assert "selector_axis_clamped:head_yaw:180->100" in caplog.text


def test_normalize_selector_output_v3_accepts_string_number_axis() -> None:
    selector = normalize_selector_output(
        {
            "intent_tags": ["curious"],
            "duration_hint_ms": "1200",
            "axes": {"head_yaw": "82"},
        },
        semantic_profile=_semantic_profile(),
    )

    assert selector["duration_ms"] == 1200
    assert selector["axes"]["head_yaw"] == 82


def test_normalize_selector_output_v3_pushes_exact_neutral_axis_past_soft_range() -> None:
    profile = _semantic_profile()
    selector = normalize_selector_output(
        {
            "intent_tags": ["curious"],
            "duration_hint_ms": 1200,
            "axes": {"head_yaw": 50},
        },
        semantic_profile=profile,
    )

    value = selector["axes"]["head_yaw"]
    soft_min, soft_max = profile["axes"][0]["soft_range"]
    min_value, max_value = profile["axes"][0]["value_range"]

    assert value < soft_min or value > soft_max
    assert value != soft_min
    assert value != soft_max
    assert min_value <= value <= max_value


def test_normalize_selector_output_v3_pushes_exact_neutral_axis_outside_one_sided_soft_range() -> None:
    profile = _semantic_profile()
    profile["axes"][0]["soft_range"] = [50, 100]

    selector = normalize_selector_output(
        {
            "intent_tags": ["curious"],
            "duration_hint_ms": 1200,
            "axes": {"head_yaw": 50},
        },
        semantic_profile=profile,
    )

    value = selector["axes"]["head_yaw"]
    assert value < 50
    assert 0 <= value <= 100


def test_normalize_selector_output_v3_allows_axis_errors_under_threshold(caplog) -> None:
    selector = normalize_selector_output(
        {
            "intent_tags": ["curious"],
            "duration_hint_ms": 1200,
            "axes": {
                "axis_0": 60,
                "axis_1": 62,
                "axis_2": 64,
                "unknown_axis": 80,
            },
        },
        semantic_profile=_semantic_profile_with_prompt_axes(4),
    )

    assert selector["axes"] == {
        "axis_0": 60,
        "axis_1": 62,
        "axis_2": 64,
    }
    assert "ignored invalid semantic axes within threshold" in caplog.text


def test_normalize_selector_output_v3_rejects_axis_errors_over_threshold() -> None:
    with pytest.raises(ValueError, match="selector_axis_error_rate_exceeded:2/4"):
        normalize_selector_output(
            {
                "intent_tags": ["curious"],
                "duration_hint_ms": 1200,
                "axes": {
                    "axis_0": 60,
                    "axis_1": 62,
                    "unknown_axis_a": 80,
                    "unknown_axis_b": 82,
                },
            },
            semantic_profile=_semantic_profile_with_prompt_axes(4),
        )


def test_normalize_motion_intent_v2_rejects_duration_out_of_range() -> None:
    with pytest.raises(ValueError, match="duration_hint_ms_out_of_range"):
        normalize_motion_intent_payload(
            {
                "schema_version": "engine.motion_intent.v2",
                "profile_id": "DemoModel.semantic.v1",
                "profile_revision": 3,
                "model_id": "DemoModel",
                "mode": "expressive",
                "emotion_label": "curious",
                "duration_hint_ms": 20000,
                "axes": {
                    "head_yaw": {"value": 82},
                },
            }
        )


def test_validate_parameter_plan_v2_rejects_invalid_source() -> None:
    valid, reason = validate_parameter_plan_payload(
        {
            "schema_version": "engine.parameter_plan.v2",
            "profile_id": "DemoModel.semantic.v1",
            "profile_revision": 3,
            "model_id": "DemoModel",
            "mode": "expressive",
            "emotion_label": "curious",
            "timing": {
                "duration_ms": 1200,
                "blend_in_ms": 216,
                "hold_ms": 684,
                "blend_out_ms": 300,
            },
            "parameters": [
                {
                    "axis_id": "head_yaw",
                    "parameter_id": "ParamAngleX",
                    "target_value": 12.0,
                    "weight": 1.0,
                    "source": "unknown_source",
                }
            ],
        }
    )

    assert valid is False
    assert reason == "parameter_source_invalid:unknown_source"


def test_validate_parameter_plan_v2_accepts_multihop_coupling_parameters() -> None:
    valid, reason = validate_parameter_plan_payload(
        {
            "schema_version": "engine.parameter_plan.v2",
            "profile_id": "DemoModel.semantic.v1",
            "profile_revision": 3,
            "model_id": "DemoModel",
            "mode": "expressive",
            "emotion_label": "curious",
            "timing": {
                "duration_ms": 1200,
                "blend_in_ms": 216,
                "hold_ms": 684,
                "blend_out_ms": 300,
            },
            "parameters": [
                {
                    "axis_id": "gaze_x",
                    "parameter_id": "ParamEyeBallX",
                    "input_value": 78.0,
                    "target_value": 0.56,
                    "weight": 1.0,
                    "source": "semantic_axis",
                },
                {
                    "axis_id": "head_yaw",
                    "parameter_id": "ParamAngleX",
                    "input_value": 78.0,
                    "target_value": 8.4,
                    "weight": 0.25,
                    "source": "coupling",
                },
                {
                    "axis_id": "body_yaw",
                    "parameter_id": "ParamBodyAngleX",
                    "input_value": 78.0,
                    "target_value": 2.94,
                    "weight": 0.0875,
                    "source": "coupling",
                },
            ],
        }
    )

    assert valid is True
    assert reason == ""


def test_normalize_selector_output_rejects_missing_emotion() -> None:
    with pytest.raises(ValueError, match="selector_intent_tags_empty"):
        normalize_selector_output(
            {
                "duration_hint_ms": 1200,
                "axes": {"head_yaw": 82},
            },
            semantic_profile=_semantic_profile(),
        )


def test_normalize_selector_output_boosts_subtle_non_neutral_axes() -> None:
    selector = normalize_selector_output(
            {
                "intent_tags": ["playful"],
                "duration_hint_ms": 1200,
                "axes": {"head_yaw": 54},
            },
            semantic_profile=_semantic_profile(),
        )
    assert selector["axes"]["head_yaw"] > 58


def test_normalize_selector_output_keeps_neutral_near_center_axes() -> None:
    selector = normalize_selector_output(
            {
                "intent_tags": ["neutral"],
                "duration_hint_ms": 1200,
                "axes": {"head_yaw": 54},
            },
            semantic_profile=_semantic_profile(),
        )
    assert selector["axes"]["head_yaw"] > 58


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
                completion_text = json.dumps(
                    {
                        "intent_tags": ["curious"],
                        "duration_hint_ms": 1200,
                        "axes": {"head_yaw": 82},
                    },
                    separators=(",", ":"),
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0
        motion_prompt_instruction = "Use stronger head and mouth motion."
        model_info = _model_info()

        def list_effective_motion_tuning_examples(self) -> list[dict]:
            return list(DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES)

        def build_motion_tuning_style_prompt(self) -> str:
            return "中性时偏少轴；开心时优先笑眼和嘴角。"

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
    assert intent["schema_version"] == "engine.motion_intent.v3"
    assert intent["mode"] == "expressive"
    assert intent["duration_hint_ms"] == 1200
    assert intent["profile_id"] == "DemoModel.semantic.v1"
    assert intent["axes"]["head_yaw"] == 82
    assert provider.called is True
    assert "请根据文本为 Live2D 角色选择语义动作轴数值。" in provider.last_prompt
    assert "debug_tail" not in provider.last_prompt
    assert "平台上下文：" in provider.last_prompt
    assert "少量示例仅作为风格参考。" in provider.last_prompt
    assert "场景：用户确认收到信息" in provider.last_prompt
    assert "角色风格偏好：" in provider.last_prompt
    assert "中性时偏少轴" in provider.last_prompt
    assert "可复用的现成 motion3 动画" not in provider.last_prompt
    assert "motion_id=serious_explain" not in provider.last_prompt
    assert "旧表情参考模板" not in provider.last_prompt
    assert "[动作]" not in provider.last_prompt
    assert "head_yaw" in provider.last_prompt
    assert '"fallback_pose_id"' not in provider.last_prompt
    assert "ParamHairX" not in provider.last_prompt
    assert "表情关键词参考动作：" not in provider.last_prompt
    assert "补充动作指令：" in provider.last_prompt
    assert "Use stronger head and mouth motion." in provider.last_prompt
    assert "Live2D 表情动作参数生成器" in provider.last_system_prompt
    assert "不要回复用户" in provider.last_system_prompt


def test_realtime_motion_plan_generator_rejects_catalog_choice() -> None:
    class ProviderStub:
        async def text_chat(self, *, prompt: str, system_prompt: str):
            assert "可复用的现成 motion3 动画" not in prompt
            assert "motion_id=serious_explain" not in prompt
            del system_prompt

            class Response:
                completion_text = json.dumps(
                    {
                        "choice": "catalog",
                        "motion_id": "serious_explain",
                        "emotion": "explain",
                    },
                    separators=(",", ":"),
                )

            return Response()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = ProviderStub()
        realtime_motion_timeout_seconds = 2.0
        model_info = _model_info()

        def list_effective_motion_tuning_examples(self) -> list[dict]:
            return []

        def build_motion_tuning_style_prompt(self) -> str:
            return ""

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())

    with pytest.raises(ValueError, match="selector_forbidden_field:choice"):
        asyncio.run(
            generator.generate(
                user_text="why",
                assistant_text="let me explain",
            )
        )


def test_realtime_motion_plan_prompt_keeps_fixed_few_shot_when_reference_templates_empty() -> None:
    class ProviderStub:
        def __init__(self) -> None:
            self.last_prompt = ""

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del system_prompt
            self.last_prompt = prompt

            class Response:
                completion_text = json.dumps(
                    {
                        "intent_tags": ["neutral"],
                        "duration_hint_ms": 900,
                        "axes": {"head_yaw": 50},
                    },
                    separators=(",", ":"),
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0
        model_info = {
            "selected_model": "DemoModel",
            "models": [
                {
                    "name": "DemoModel",
                    "semantic_axis_profile": _semantic_profile(),
                }
            ],
        }

        def list_effective_motion_tuning_examples(self) -> list[dict]:
            return list(DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES[:1])

        def build_motion_tuning_style_prompt(self) -> str:
            return ""

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())
    intent = asyncio.run(generator.generate(user_text="ok", assistant_text="ok"))

    assert isinstance(intent, dict)
    assert "旧表情参考模板" not in provider.last_prompt
    assert "少量示例仅作为风格参考。" in provider.last_prompt
    assert "场景：用户确认收到信息" in provider.last_prompt


def test_realtime_motion_plan_prompt_can_keep_fixed_few_shot_with_reference_templates() -> None:
    class ProviderStub:
        def __init__(self) -> None:
            self.last_prompt = ""

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del system_prompt
            self.last_prompt = prompt

            class Response:
                completion_text = json.dumps(
                    {
                        "intent_tags": ["curious"],
                        "duration_hint_ms": 1200,
                        "axes": {"head_yaw": 82},
                    },
                    separators=(",", ":"),
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0
        realtime_motion_fixed_fewshot_with_reference_templates = True
        model_info = _model_info()

        def list_effective_motion_tuning_examples(self) -> list[dict]:
            return list(DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES[:1])

        def build_motion_tuning_style_prompt(self) -> str:
            return ""

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())
    intent = asyncio.run(generator.generate(user_text="why", assistant_text="let me explain"))

    assert isinstance(intent, dict)
    assert "旧表情参考模板" not in provider.last_prompt
    assert "少量示例仅作为风格参考。" in provider.last_prompt
    assert "场景：用户确认收到信息" in provider.last_prompt


def test_realtime_motion_plan_prompt_includes_user_tuned_examples_first() -> None:
    class ProviderStub:
        def __init__(self) -> None:
            self.last_prompt = ""

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del system_prompt
            self.last_prompt = prompt

            class Response:
                completion_text = json.dumps(
                    {
                        "intent_tags": ["joy"],
                        "duration_hint_ms": 1200,
                        "axes": {"head_yaw": 76},
                    },
                    separators=(",", ":"),
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0
        realtime_motion_fewshot_count = 1
        realtime_motion_user_fewshot_count = 1
        motion_tuning_reference_examples = [
            {
                "input": "Assistant: tuned sample",
                "output": {
                    "intent_tags": ["joy"],
                    "duration_hint_ms": 900,
                    "axes": {"head_yaw": 76},
                },
            }
        ]
        model_info = _model_info()

        def list_effective_motion_tuning_examples(self) -> list[dict]:
            return list(self.motion_tuning_reference_examples)

        def build_motion_tuning_style_prompt(self) -> str:
            return ""

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())

    intent = asyncio.run(
        generator.generate(
            user_text="hi",
            assistant_text="tuned sample",
        )
    )

    assert isinstance(intent, dict)
    assert "Assistant: tuned sample" in provider.last_prompt
    assert '"head_yaw":76' in provider.last_prompt


def test_resolve_selector_few_shot_examples_respects_configured_count() -> None:
    class RuntimeStub:
        realtime_motion_fewshot_enabled = True
        realtime_motion_fewshot_count = 6
        realtime_motion_user_fewshot_count = 6
        motion_tuning_reference_examples = [
            {
                "input": f"Assistant: tuned sample {index}",
                "output": {
                    "intent_tags": ["joy"],
                    "duration_hint_ms": 900 + index,
                    "axes": {"head_yaw": 70 + index},
                },
            }
            for index in range(6)
        ]

    runtime_state = RuntimeStub()
    resolved = resolve_selector_few_shot_examples(runtime_state=runtime_state)

    assert len(resolved) == 6
    assert [item["input"] for item in resolved] == [
        f"Assistant: tuned sample {index}" for index in range(6)
    ]


def test_resolve_selector_few_shot_examples_backfills_defaults_up_to_configured_count() -> None:
    user_example = {
        "input": "Assistant: tuned sample",
        "output": {
            "intent_tags": ["joy"],
            "duration_hint_ms": 900,
            "axes": {"head_yaw": 76},
        },
    }

    class RuntimeStub:
        realtime_motion_fewshot_enabled = True
        realtime_motion_fewshot_count = 3
        motion_tuning_reference_examples = [user_example]
        motion_tuning_fewshot_diagnostics: list[str] = []

    runtime_state = RuntimeStub()
    resolved = resolve_selector_few_shot_examples(runtime_state=runtime_state)

    assert [item["output"].get("emotion_label", item["output"].get("emotion")) for item in resolved] == [
        "neutral",
        "explain",
        "soothe",
    ]
    assert runtime_state.motion_tuning_fewshot_diagnostics == [
        "motion_tuning_user_samples_insufficient:requested=3:user_available=1:user_selected=0",
        "motion_tuning_default_backfill_applied:count=3",
    ]


def test_resolve_selector_few_shot_examples_ignores_model_native_expression_library() -> None:
    user_example = {
        "input": "Assistant: tuned sample",
        "output": {
            "emotion_label": "happy",
            "duration_hint_ms": 900,
            "fallback_pose_id": "neutral",
            "axes": {"head_yaw": 76},
        },
    }

    class RuntimeStub:
        realtime_motion_fewshot_enabled = True
        realtime_motion_fewshot_count = 4
        motion_tuning_reference_examples = [user_example]
        motion_tuning_fewshot_diagnostics: list[str] = []
        model_info = {
            "selected_model": "DemoModel",
            "models": [
                {
                    "name": "DemoModel",
                    "expression_example_library": {
                        "source": "model_native",
                        "examples": [
                            {"id": "neutral", "emotion_label": "neutral", "axes": {"mouth_smile": 52}},
                            {"id": "angry", "emotion_label": "angry", "axes": {"brow_bias": 24}},
                        ],
                    },
                }
            ],
        }

    runtime_state = RuntimeStub()
    resolved = resolve_selector_few_shot_examples(runtime_state=runtime_state)

    assert [item["output"]["emotion"] for item in resolved] == [
        "neutral",
        "explain",
        "soothe",
        "confused",
    ]
    assert runtime_state.motion_tuning_fewshot_diagnostics == [
        "motion_tuning_user_samples_insufficient:requested=4:user_available=1:user_selected=0",
        "motion_tuning_default_backfill_applied:count=4",
    ]


def test_resolve_selector_few_shot_examples_uses_unbounded_configured_count() -> None:
    class RuntimeStub:
        realtime_motion_fewshot_enabled = True
        realtime_motion_fewshot_count = 12
        realtime_motion_user_fewshot_count = 12
        motion_tuning_reference_examples = [
            {
                "input": f"Assistant: tuned sample {index}",
                "output": {
                    "intent_tags": ["joy"],
                    "duration_hint_ms": 900 + index,
                    "axes": {"head_yaw": 70 + index},
                },
            }
            for index in range(12)
        ]
        motion_tuning_fewshot_diagnostics: list[str] = []

    runtime_state = RuntimeStub()
    resolved = resolve_selector_few_shot_examples(runtime_state=runtime_state)

    assert len(resolved) == 12
    assert resolved[-1]["input"] == "Assistant: tuned sample 11"


def test_resolve_selector_few_shot_examples_does_not_use_user_samples_by_default() -> None:
    class RuntimeStub:
        realtime_motion_fewshot_enabled = True
        realtime_motion_fewshot_count = 2
        motion_tuning_reference_examples = [
            {
                "input": "Assistant: tuned sample",
                "output": {
                    "intent_tags": ["joy"],
                    "duration_hint_ms": 900,
                    "axes": {"head_yaw": 76},
                },
            }
        ]
        motion_tuning_fewshot_diagnostics: list[str] = []

    runtime_state = RuntimeStub()
    resolved = resolve_selector_few_shot_examples(runtime_state=runtime_state)

    assert "Assistant: tuned sample" not in [item["input"] for item in resolved]
    assert [item["output"]["emotion"] for item in resolved] == ["neutral", "explain"]
    assert runtime_state.motion_tuning_fewshot_diagnostics == [
        "motion_tuning_user_samples_insufficient:requested=2:user_available=1:user_selected=0",
        "motion_tuning_default_backfill_applied:count=2",
    ]


def test_resolve_selector_few_shot_examples_reports_final_shortage_after_default_backfill() -> None:
    class RuntimeStub:
        realtime_motion_fewshot_enabled = True
        realtime_motion_fewshot_count = 20
        motion_tuning_reference_examples = [
            {
                "input": "Assistant: tuned sample",
                "output": {
                    "intent_tags": ["joy"],
                    "duration_hint_ms": 900,
                    "axes": {"head_yaw": 76},
                },
            }
        ]
        motion_tuning_fewshot_diagnostics: list[str] = []

    runtime_state = RuntimeStub()
    resolved = resolve_selector_few_shot_examples(runtime_state=runtime_state)

    assert [item["output"]["emotion"] for item in resolved] == [
        "neutral",
        "explain",
        "soothe",
        "confused",
        "happy",
        "surprised",
    ]
    assert runtime_state.motion_tuning_fewshot_diagnostics == [
        "motion_tuning_user_samples_insufficient:requested=20:user_available=1:user_selected=0",
        "motion_tuning_default_backfill_applied:count=6",
        "motion_tuning_fewshot_final_shortage:requested=20:final_count=6",
    ]


def test_realtime_motion_plan_generator_rejects_old_selector_output_fields(caplog) -> None:
    class ProviderStub:
        async def text_chat(self, *, prompt: str, system_prompt: str):
            del prompt
            del system_prompt

            class Response:
                completion_text = (
                    '{"emotion_label":"curious","duration_hint_ms":1200,'
                    '"fallback_pose_id":"neutral","axes":{"head_yaw":82}}'
                )

            return Response()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = ProviderStub()
        realtime_motion_timeout_seconds = 2.0
        model_info = _model_info()

        def list_effective_motion_tuning_examples(self) -> list[dict]:
            return []

        def build_motion_tuning_style_prompt(self) -> str:
            return ""

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())

    with pytest.raises(ValueError, match="selector_forbidden_field:emotion_label"):
        asyncio.run(
            generator.generate(
                user_text="what is this?",
                assistant_text="let me explain that for you",
            )
        )


def test_realtime_motion_plan_generator_prompt_switches_off_context_and_few_shot() -> None:
    class ProviderStub:
        def __init__(self) -> None:
            self.last_prompt = ""

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del system_prompt
            self.last_prompt = prompt

            class Response:
                completion_text = json.dumps(
                    {
                        "intent_tags": ["neutral"],
                        "duration_hint_ms": 1000,
                        "axes": {"head_yaw": 50},
                    },
                    separators=(",", ":"),
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0
        realtime_motion_fewshot_enabled = False
        realtime_motion_platform_context_enabled = False
        model_info = _model_info()

        def list_effective_motion_tuning_examples(self) -> list[dict]:
            return []

        def build_motion_tuning_style_prompt(self) -> str:
            return ""

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
    assert "少量示例（仅作为风格参考，不要机械照抄）：" not in provider.last_prompt
    assert "表情关键词参考动作：" not in provider.last_prompt
    assert "平台上下文：" not in provider.last_prompt


def test_resolve_selector_few_shot_examples_defaults_to_two_examples() -> None:
    class RuntimeStub:
        realtime_motion_fewshot_enabled = True
        motion_tuning_reference_examples: list[dict[str, object]] = []
        motion_tuning_fewshot_diagnostics: list[str] = []

    runtime_state = RuntimeStub()
    resolved = resolve_selector_few_shot_examples(runtime_state=runtime_state)

    assert [item["output"]["emotion"] for item in resolved] == [
        "neutral",
        "explain",
    ]
    assert runtime_state.motion_tuning_fewshot_diagnostics == [
        "motion_tuning_user_samples_insufficient:requested=2:user_available=0:user_selected=0",
        "motion_tuning_default_backfill_applied:count=2",
    ]


def test_validate_parameter_plan_payload_rejects_v1_key_axes() -> None:
    invalid_plan = _valid_parameter_plan()
    invalid_plan["schema_version"] = "engine.parameter_plan.v1"
    invalid_plan["key_axes"] = {
        "head_yaw": {"value": 50},
    }

    valid, reason = validate_parameter_plan_payload(invalid_plan)
    assert valid is False
    assert reason == "invalid_schema_version"


def test_validate_parameter_plan_payload_rejects_missing_v2_axis_id() -> None:
    broken_plan = _valid_parameter_plan()
    broken_plan["parameters"] = [
        {
            "parameter_id": "ParamCheek",
            "target_value": 0.4,
            "weight": 0.6,
            "source": "semantic_axis",
        }
    ]
    valid, reason = validate_parameter_plan_payload(broken_plan)
    assert valid is False
    assert reason == "parameter_axis_id_empty"
