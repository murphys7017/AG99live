from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
from unittest.mock import patch

import pytest


def _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()

    prompt_module = types.ModuleType("astrbot.core.prompt")

    class PromptExtension:
        def __init__(
            self,
            *,
            plugin_id: str,
            mount: str,
            title: str | None = None,
            value=None,
            value_kind: str = "mapping",
            order: int = 100,
            meta: dict | None = None,
        ) -> None:
            self.plugin_id = plugin_id
            self.mount = mount
            self.title = title
            self.value = value
            self.value_kind = value_kind
            self.order = order
            self.meta = meta or {}

    prompt_module.PromptExtension = PromptExtension
    monkeypatch.setitem(sys.modules, "astrbot.core.prompt", prompt_module)

    interaction_module = types.ModuleType("astrbot.core.interaction")

    class InteractionResultContribution:
        def __init__(
            self,
            *,
            plugin_id: str,
            platform_extras: dict | None = None,
            client_objects: list | None = None,
            final_text_override: str | None = None,
            metadata: dict | None = None,
            priority: int = 100,
        ) -> None:
            self.plugin_id = plugin_id
            self.platform_extras = platform_extras or {}
            self.client_objects = client_objects or []
            self.final_text_override = final_text_override
            self.metadata = metadata or {}
            self.priority = priority

    class PersonaEffectSpec:
        def __init__(
            self,
            *,
            plugin_id: str,
            name: str,
            description: str,
            parameters: dict,
            phases: tuple = (),
            legacy_hint_names: tuple = (),
            priority: int = 100,
            enabled: bool = True,
            metadata: dict | None = None,
        ) -> None:
            self.plugin_id = plugin_id
            self.name = name
            self.description = description
            self.parameters = parameters
            self.phases = phases
            self.legacy_hint_names = legacy_hint_names
            self.priority = priority
            self.enabled = enabled
            self.metadata = metadata or {}

    interaction_module.InteractionResultContribution = InteractionResultContribution
    interaction_module.PersonaEffectSpec = PersonaEffectSpec
    interaction_module.get_interaction_route_decision = lambda _event: None
    interaction_module.get_interaction_decision = (
        lambda event: event.get_extra("_interaction_decision", None)
    )
    monkeypatch.setitem(sys.modules, "astrbot.core.interaction", interaction_module)


def _load_interaction_motion_module():
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion"
    )
    return importlib.reload(module)


def _build_semantic_model_info() -> dict:
    return {
        "selected_model": "pet",
        "models": [
            {
                "name": "pet",
                "semantic_axis_profile": {
                    "schema_version": "ag99.semantic_axis_profile.v2",
                    "profile_id": "pet.semantic.v1",
                    "model_id": "pet",
                    "source_hash": "hash",
                    "last_scanned_hash": "hash",
                    "revision": 2,
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
                            "level_anchors": {
                                "-4": 20,
                                "-3": 30, "-2": 38, "-1": 45, "0": 50,
                                "1": 56, "2": 64, "3": 70, "4": 80,
                            },
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
                            "id": "eye_open_left",
                            "label": "Eye Open Left",
                            "description": "left eye openness",
                            "semantic_group": "eye",
                            "control_role": "hint",
                            "neutral": 50,
                            "value_range": [0, 100],
                            "soft_range": [42, 58],
                            "strong_range": [30, 70],
                            "level_anchors": {
                                "-4": 20,
                                "-3": 30, "-2": 38, "-1": 45, "0": 50,
                                "1": 56, "2": 64, "3": 70, "4": 80,
                            },
                            "positive_semantics": ["open"],
                            "negative_semantics": ["close"],
                            "usage_notes": "Use for wink details.",
                            "parameter_bindings": [
                                {
                                    "parameter_id": "ParamEyeLOpen",
                                    "parameter_name": "Eye L Open",
                                    "input_range": [0, 100],
                                    "output_range": [0, 1],
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
                },
                "motion_resource_pool": {
                    "driver_components": [
                        {
                            "id": "Motions/认真说明.motion3.json#ParamAngleX",
                            "source_motion": "认真说明",
                            "source_file": "Motions/认真说明.motion3.json",
                            "parameter_id": "ParamAngleX",
                            "engine_role": "driver",
                            "strength": "medium",
                            "trait": "sustain",
                            "energy_score": 0.7,
                            "peak_time_ratio": 0.42,
                            "value_profile": {
                                "baseline": 0,
                                "min": 0,
                                "max": 18,
                            },
                        },
                        {
                            "id": "Motions/认真说明.motion3.json#ParamHairX",
                            "source_motion": "认真说明",
                            "source_file": "Motions/认真说明.motion3.json",
                            "parameter_id": "ParamHairX",
                            "engine_role": "driver",
                            "strength": "high",
                            "trait": "oscillate",
                            "energy_score": 5,
                            "peak_time_ratio": 0.5,
                            "value_profile": {
                                "baseline": 0,
                                "min": -1,
                                "max": 1,
                            },
                        },
                        {
                            "id": "Motions/认真说明.motion3.json#ParamPhysicsX",
                            "source_motion": "认真说明",
                            "source_file": "Motions/认真说明.motion3.json",
                            "parameter_id": "ParamAngleX",
                            "engine_role": "secondary",
                            "strength": "high",
                            "trait": "oscillate",
                            "energy_score": 6,
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
                            "motion_name": "认真说明",
                            "motion_file": "Motions/认真说明.motion3.json",
                            "intensity": "medium",
                            "catalog_tags": ["serious", "explain"],
                        }
                    ],
                },
                "constraints": {
                    "motions": [
                        {
                            "name": "认真说明",
                            "file": "Motions/认真说明.motion3.json",
                            "group": "TapBody",
                            "duration": 3.0,
                            "catalog_id": "serious_explain",
                            "catalog_label": "认真说明",
                            "catalog_description": "姿态更稳定、更像进入解释状态。",
                            "catalog_intensity": "medium",
                            "catalog_tags": ["serious", "explain"],
                            "catalog_emotion_bias": ["neutral", "thinking"],
                            "catalog_expose_as_resource": True,
                            "catalog_exclusive_with": ["happy_burst"],
                            "recommended_scenarios": ["说明问题", "认真解释"],
                        }
                    ],
                    "expressions": [
                        {
                            "name": "Surprised",
                            "file": "Expressions/Surprised.exp3.json",
                            "category": "base_emotion",
                            "catalog_id": "expr_surprised",
                            "catalog_label": "惊讶表情",
                            "catalog_description": "适合突然被问到或意外反应。",
                            "catalog_tags": ["惊讶", "意外"],
                            "catalog_emotion_bias": ["surprised", "shock"],
                            "catalog_intensity": "high",
                            "catalog_expose_as_resource": True,
                            "recommended_scenarios": ["突然被问到", "意外"],
                            "intensity": "high",
                            "parameters": [
                                {
                                    "id": "ParamEyeLOpen",
                                    "value": 1.0,
                                    "blend": "Add",
                                    "intensity": "high",
                                },
                                {
                                    "id": "ParamHairX",
                                    "value": 1.0,
                                    "blend": "Add",
                                    "intensity": "high",
                                },
                            ],
                            "dominant_parameters": [
                                {"id": "ParamEyeLOpen"},
                                {"id": "ParamHairX"},
                            ],
                        },
                        {
                            "name": "Tablet",
                            "file": "Expressions/Tablet.exp3.json",
                            "category": "special_state",
                            "catalog_id": "expr_tablet",
                            "catalog_label": "平板状态",
                            "catalog_expose_as_resource": False,
                            "intensity": "high",
                            "parameters": [
                                {
                                    "id": "ParamEyeLOpen",
                                    "value": 1.0,
                                    "blend": "Add",
                                    "intensity": "high",
                                }
                            ],
                            "dominant_parameters": [{"id": "ParamEyeLOpen"}],
                        },
                    ],
                },
            }
        ],
    }


def _build_runtime_state(*, mode: str = "split_after_reply"):
    state = type(
        "RuntimeStateStub",
        (),
        {
            "motion_generation_mode": mode,
            "ag99live_motion_persona_effect_available": True,
            "selected_motion_analysis_provider": None,
            "motion_prompt_instruction": "Use readable exaggerated head and smile motion.",
            "model_info": _build_semantic_model_info(),
        },
    )()
    state.build_motion_tuning_style_prompt = lambda: (
        "中性时偏少轴，开心时优先笑眼和嘴角。"
    )
    state.list_effective_motion_tuning_examples = lambda: []
    return state


def _build_event(*, mode: str = "split_after_reply", raw_turn_id: str = "front-turn"):
    scheduled_calls: list[dict[str, object]] = []
    runtime_state = _build_runtime_state(mode=mode)

    def schedule_motion_after_reply(*, assistant_text: str, origin_turn_id: str | None = None, source: str = "reply_final"):
        scheduled_calls.append(
            {
                "assistant_text": assistant_text,
                "origin_turn_id": origin_turn_id,
                "source": source,
            }
        )
        return True

    turn_coordinator = type(
        "TurnCoordinatorStub",
        (),
        {
            "runtime_state": runtime_state,
            "session_state": type(
                "SessionStateStub",
                (),
                {
                    "current_turn_id": "session-turn",
                },
            )(),
            "schedule_motion_after_reply": staticmethod(schedule_motion_after_reply),
        },
    )()

    adapter = type("AdapterStub", (), {"turn_coordinator": turn_coordinator})()

    class EventStub:
        def __init__(self) -> None:
            self.adapter = adapter
            self.message_str = "用户说话内容"
            self.message_obj = type(
                "MessageObjectStub",
                (),
                {
                    "message_str": "用户说话内容",
                    "raw_message": {
                        "turn_id": raw_turn_id,
                    }
                },
            )()
            self._extras: dict[str, object] = {}

        def get_platform_id(self) -> str:
            return "olv_pet_adapter"

        def get_platform_name(self) -> str:
            return "olv_pet_adapter"

        def get_extra(self, key: str, default=None):
            return self._extras.get(key, default)

        def set_extra(self, key: str, value: object) -> None:
            self._extras[key] = value

    return EventStub(), scheduled_calls


def _make_left_eye_open_axis_one_sided(event) -> None:
    profile = event.adapter.turn_coordinator.runtime_state.model_info["models"][0][
        "semantic_axis_profile"
    ]
    axis = next(item for item in profile["axes"] if item["id"] == "eye_open_left")
    axis["neutral"] = 100
    axis["level_anchors"] = {
        "-4": 0,
        "-3": 20,
        "-2": 45,
        "-1": 70,
        "0": 100,
        "1": 100,
        "2": 100,
        "3": 100,
        "4": 100,
    }


def _build_view(
    *,
    phase: str,
    route_mode: str | None = "self_reply",
    should_emit_immediate_reply: bool | None = None,
    final_result: str | None = None,
    core_result: str | None = None,
    immediate_reply: str | None = None,
    purpose: str | None = None,
    effect_calls: object | None = None,
):
    route_decision = None
    if route_mode is not None or should_emit_immediate_reply is not None:
        route_decision = {}
        if route_mode is not None:
            route_decision["route_mode"] = route_mode
        if should_emit_immediate_reply is not None:
            route_decision["should_emit_immediate_reply"] = should_emit_immediate_reply
    metadata: dict[str, object] = {"phase": phase}
    if purpose is not None:
        metadata["purpose"] = purpose
    return type(
        "ResultViewStub",
        (),
        {
            "turn_id": "interaction-turn",
            "session_id": "olv_pet_adapter:friend_message:desktop-client",
            "route_decision": route_decision,
            "final_result": final_result,
            "core_result": core_result,
            "immediate_reply": immediate_reply,
            "metadata": metadata,
            "effect_calls": effect_calls,
        },
    )()


def _motion_effect_call(arguments: dict[str, object]):
    return {
        "name": "ag99live.motion",
        "arguments": arguments,
    }


def test_prompt_contributor_returns_capability_and_runtime_extensions(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    event.adapter.turn_coordinator.runtime_state.list_effective_motion_tuning_examples = lambda: [
        {
            "input": "场景：清晰可见地向右看。",
            "output": {
                "intent_tags": ["向右确认"],
                "axis_levels": {"head_yaw": 3, "unknown_axis": 4},
            },
        }
    ]
    view = _build_view(phase="decision", route_mode="delegate_to_core", purpose="persona_reply")

    extensions = asyncio.run(contributor.collect(event, None, view))

    assert isinstance(extensions, list)
    assert len(extensions) == 2
    system = next(item for item in extensions if item.mount == "system")
    capability = next(item for item in extensions if item.mount == "capability")
    assert system.meta["scope"] == "static"
    assert capability.meta["scope"] == "static"
    assert capability.value["axis_value_format"] == "axis_levels"
    assert capability.value["reference_examples"] == [
        {
            "input": "场景：清晰可见地向右看。",
            "output": {
                "intent_tags": ["向右确认"],
                "axis_levels": {"head_yaw": 3},
            },
        }
    ]
    assert "你正在控制一个 Live2D 模型" in system.value
    assert "为本轮回复生成可见动作" in system.value
    assert "每个回复片段必须且只能调用一次动作效果" in system.value
    assert "ag99live" not in system.value.lower()
    assert "不要用多个动作调用表达动作序列" in system.value
    assert "没有合适资源时使用 motion_steps" in system.value
    assert "所有步骤必须使用完全相同的轴集合" in system.value
    assert "<@anim" not in system.value
    assert '"plugin_hints":{"ag99live_motion"' not in system.value
    assert "Persona Effect" not in system.value
    assert "不要输出 plugin_hints 外壳" not in system.value
    assert '"fallback_pose_id":"neutral"' not in system.value
    assert '"choice"' not in system.value
    assert '"motion_id"' not in system.value
    assert "immediate_spoken_reply" not in system.value
    assert "姿态方向、视线焦点和身体重心" in system.value
    assert "普通回复的主要姿态轴从 3 级开始" in system.value
    assert "中性时偏少轴" not in system.value
    assert "configured_generation_mode" not in capability.value
    assert capability.value["character_motion_style"] == "中性时偏少轴，开心时优先笑眼和嘴角。"
    assert capability.value["axis_level_scale"]["0"] == "明确回到中性"
    assert capability.value["axis_level_scale"]["omitted"] == "本轮不控制该轴"
    assert "没有明确方向或表演贡献的轴直接省略" in system.value
    assert "可复用的现成 motion3 动画" not in system.value
    assert "旧表情参考模板" not in system.value
    assert "[动作]" not in system.value
    assert "head_yaw" not in system.value
    assert "fallback_pose_id" not in system.value
    assert "intent_tags" in system.value
    assert "expression_resource_id" in system.value
    assert "motion_resource_id" in system.value
    assert "单姿态使用 axis_levels；动作序列使用 motion_steps" in system.value
    assert system.value.count("-4=夸张负") == 1
    assert "插件会负责" not in system.value
    assert "choice、mode、motion_id" not in system.value
    assert "expr_surprised" not in system.value
    assert "motion_reference_templates" not in capability.value
    assert "motion_catalog_options" not in capability.value
    assert "pose_references" in capability.value
    assert "resources" in capability.value
    resource_ids = {
        item["resource_id"] for item in capability.value["resources"]
    }
    assert {"expr_surprised", "serious_explain"}.issubset(resource_ids)
    assert "expr_tablet" not in resource_ids
    resource_candidate = next(
        item
        for item in capability.value["resources"]
        if item["resource_id"] == "expr_surprised"
    )
    assert resource_candidate["resource_type"] == "expression"
    assert resource_candidate["recommended_scenarios"] == ["突然被问到", "意外"]
    assert resource_candidate["conflicting_axis_ids"] == ["eye_open_left"]
    assert 2 <= len(capability.value["pose_references"]) <= 4
    assert all(
        "id" not in item and "source" not in item
        for item in capability.value["pose_references"]
    )
    assert all(
        item["pose_descriptors"]
        for item in capability.value["pose_references"]
    )
    catalog_candidate = next(
        item
        for item in capability.value["pose_references"]
        if item["label"] == "认真说明"
    )
    assert catalog_candidate["description"] == "姿态更稳定、更像进入解释状态。"
    assert catalog_candidate["emotion_bias"] == ["neutral", "thinking"]
    assert catalog_candidate["recommended_scenarios"] == ["说明问题", "认真解释"]
    assert catalog_candidate["key_axis_levels"] == {"head_yaw": 4}
    prompt_axis_ids = [
        item["id"] for item in capability.value["axes"]
    ]
    assert prompt_axis_ids == ["head_yaw", "eye_open_left"]
    assert capability.value["axes"][0]["positive_semantics"] == [
        "turn right"
    ]
    assert capability.value["axes"][0]["negative_semantics"] == [
        "turn left"
    ]
    assert capability.value["axes"][0]["usage_notes"] == (
        "Use for attention direction."
    )
    assert capability.value["axes"][0]["description"] == "turn head left/right"
    assert all(
        "neutral" not in axis
        and "soft_range" not in axis
        and "strong_range" not in axis
        for axis in capability.value["axes"]
    )
    assert "effect_arguments_example" not in capability.value
    assert "intent_tags" in system.value
    assert all("file" not in item for item in capability.value["resources"])
    assert all(item.mount != "context" for item in extensions)


def test_prompt_capability_exposes_only_available_levels_for_one_sided_axis(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    _make_left_eye_open_axis_one_sided(event)
    view = _build_view(
        phase="decision",
        route_mode="delegate_to_core",
        purpose="persona_reply",
    )

    extensions = asyncio.run(contributor.collect(event, None, view))

    capability = next(item for item in extensions if item.mount == "capability")
    eye_axis = next(
        item for item in capability.value["axes"] if item["id"] == "eye_open_left"
    )
    assert eye_axis["available_levels"] == [-4, -3, -2, -1, 0]


@pytest.mark.parametrize(
    ("output_patch", "expected_error"),
    [
        ({"intent_tags": ["duplicate", "duplicate"]}, "intent_tags_invalid"),
        ({"intent_tags": ["x" * 49]}, "intent_tags_invalid"),
        ({"duration_hint_ms": 200}, "duration_invalid"),
    ],
)
def test_prompt_capability_rejects_reference_examples_outside_effect_schema(
    install_fake_astrbot,
    monkeypatch,
    output_patch,
    expected_error,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    event.adapter.turn_coordinator.runtime_state.list_effective_motion_tuning_examples = lambda: [
        {
            "input": "invalid example",
            "output": {
                "intent_tags": ["valid"],
                "axis_levels": {"head_yaw": 3},
                **output_patch,
            },
        }
    ]
    view = _build_view(
        phase="decision",
        route_mode="delegate_to_core",
        purpose="persona_reply",
    )

    with pytest.raises(ValueError, match=expected_error):
        asyncio.run(contributor.collect(event, None, view))


def test_prompt_capability_rejects_reference_level_unavailable_for_one_sided_axis(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    _make_left_eye_open_axis_one_sided(event)
    event.adapter.turn_coordinator.runtime_state.list_effective_motion_tuning_examples = lambda: [
        {
            "input": "invalid eye direction",
            "output": {
                "intent_tags": ["invalid"],
                "axis_levels": {"eye_open_left": 3},
            },
        }
    ]
    view = _build_view(
        phase="decision",
        route_mode="delegate_to_core",
        purpose="persona_reply",
    )

    with pytest.raises(ValueError, match="axis_level_unavailable:eye_open_left:3"):
        asyncio.run(contributor.collect(event, None, view))


def test_prompt_contributor_uses_official_inline_anim_contract_when_persona_effect_unavailable(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    event.adapter.turn_coordinator.runtime_state.ag99live_motion_persona_effect_available = False
    view = _build_view(phase="decision", route_mode="delegate_to_core", purpose="persona_reply")

    extensions = asyncio.run(contributor.collect(event, None, view))

    system = next(item for item in extensions if item.mount == "system")
    capability = next(item for item in extensions if item.mount == "capability")
    assert capability.value["axis_value_format"] == "axes"
    assert "当前 AstrBot 运行环境不支持动作注入函数" in system.value
    assert "官方兼容标签 <@anim {...}>" in system.value
    assert "内部 intent 字段必须是 engine.motion_intent.v3" in system.value
    assert '<@anim {"mode":"inline","intent":' in system.value
    assert "engine.motion_intent.v3" in system.value
    assert '"schema_version":"engine.motion_intent.v3"' in system.value
    assert '"profile_id":"pet.semantic.v1"' in system.value
    assert '"profile_revision":2' in system.value
    assert '"model_id":"pet"' in system.value
    assert "axes 是必填对象" in system.value
    assert capability.value["axes"][0]["value_range"] == [0.0, 100.0]
    assert "available_levels" not in capability.value["axes"][0]
    assert "reference_examples" not in capability.value
    assert "等级 -3=强负" not in system.value
    assert '"plugin_hints":{"ag99live_motion"' not in system.value


def test_prompt_contributor_returns_none_for_router_purpose(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    view = _build_view(phase="decision", purpose="router")

    extensions = asyncio.run(contributor.collect(event, None, view))
    assert extensions is None


def test_prompt_contributor_returns_none_for_unknown_purpose(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    view = _build_view(phase="decision", purpose="unknown")

    extensions = asyncio.run(contributor.collect(event, None, view))
    assert extensions is None


def test_prompt_contributor_hides_resource_id_when_no_resource_candidates(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    for item in runtime_state.model_info["models"][0]["constraints"]["motions"]:
        item["catalog_expose_as_resource"] = False
    for item in runtime_state.model_info["models"][0]["constraints"]["expressions"]:
        item["catalog_expose_as_resource"] = False
    view = _build_view(phase="decision", route_mode="delegate_to_core", purpose="persona_reply")

    extensions = asyncio.run(contributor.collect(event, None, view))

    capability = next(item for item in extensions if item.mount == "capability")
    system = next(item for item in extensions if item.mount == "system")
    assert capability.meta["scope"] == "static"
    assert all(item.mount != "context" for item in extensions)
    assert "resources" not in capability.value
    assert "effect_arguments_example" not in capability.value
    assert "expression_resource_id" not in system.value
    assert "motion_resource_id" not in system.value
    assert "必填字段是 intent_tags，并且 axis_levels 与 motion_steps 必须二选一" in system.value


def test_resource_candidate_preserves_dotted_catalog_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    runtime_state = _build_runtime_state()
    runtime_state.model_info["models"][0]["constraints"]["expressions"][0][
        "catalog_id"
    ] = "expression.smile"

    candidates = module.build_motion_resource_candidates(runtime_state=runtime_state)

    assert any(
        item["resource_id"] == "expression.smile"
        and item["resource_type"] == "expression"
        for item in candidates
    )


def test_resource_candidates_keep_same_id_across_typed_layers(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    runtime_state = _build_runtime_state()
    runtime_state.model_info["models"][0]["constraints"]["motions"][0][
        "catalog_id"
    ] = "shared.resource"
    runtime_state.model_info["models"][0]["constraints"]["expressions"][0][
        "catalog_id"
    ] = "shared.resource"

    candidates = module.build_motion_resource_candidates(runtime_state=runtime_state)

    assert {
        item["resource_type"]
        for item in candidates
        if item["resource_id"] == "shared.resource"
    } == {"expression", "motion"}


def test_invalid_resource_id_rejects_motion_payload_instead_of_clearing_resource(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    runtime_state = _build_runtime_state()

    payload, reason = module._payload_normalize_motion_arguments_payload(
        {
            "intent_tags": ["happy"],
            "axis_levels": {"head_yaw": 1},
            "resource_id": "resource.missing",
        },
        runtime_state,
        base_reason="",
        append_resolution_reason=lambda base, suffix: ";".join(
            item for item in (base, suffix) if item
        ),
        sanitize_reason_fragment=lambda value: str(value).strip(),
    )

    assert payload is None
    assert reason == "forbidden_fields:resource_id"


def test_typed_resource_id_rejects_wrong_resource_type(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    payload, reason = module._payload_normalize_motion_arguments_payload(
        {
            "intent_tags": ["happy"],
            "axis_levels": {"head_yaw": 1},
            "expression_resource_id": "serious_explain",
        },
        _build_runtime_state(),
        base_reason="",
        append_resolution_reason=lambda base, suffix: ";".join(
            item for item in (base, suffix) if item
        ),
        sanitize_reason_fragment=lambda value: str(value).strip(),
    )

    assert payload is None
    assert reason == "expression_id_rejected:serious_explain"


def test_persona_effect_rejects_multiple_resource_layers(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    payload, reason = module._payload_normalize_motion_arguments_payload(
        {
            "intent_tags": ["surprised"],
            "axis_levels": {"head_yaw": 2},
            "expression_resource_id": "expr_surprised",
            "motion_resource_id": "serious_explain",
        },
        _build_runtime_state(),
        base_reason="",
        append_resolution_reason=lambda base, suffix: ";".join(
            item for item in (base, suffix) if item
        ),
        sanitize_reason_fragment=lambda value: str(value).strip(),
    )

    assert payload is None
    assert reason == "multiple_resource_layers_forbidden"


def test_forbidden_legacy_motion_fields_reject_effect_payload(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    runtime_state = _build_runtime_state()

    payload, reason = module._payload_normalize_motion_arguments_payload(
        {
            "intent_tags": ["happy"],
            "axis_levels": {"head_yaw": 1},
            "mode": "catalog",
        },
        runtime_state,
        base_reason="",
        append_resolution_reason=lambda base, suffix: ";".join(
            item for item in (base, suffix) if item
        ),
        sanitize_reason_fragment=lambda value: str(value).strip(),
    )

    assert payload is None
    assert reason == "forbidden_fields:mode"


def test_persona_effect_axes_field_is_rejected_instead_of_emitting_v3(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    payload, reason = module._payload_normalize_motion_arguments_payload(
        {
            "intent_tags": ["happy"],
            "axes": {"head_yaw": 70},
        },
        _build_runtime_state(),
        base_reason="persona_effect",
        append_resolution_reason=lambda base, suffix: ";".join(
            item for item in (base, suffix) if item
        ),
        sanitize_reason_fragment=lambda value: str(value).strip(),
    )

    assert payload is None
    assert reason == "persona_effect;axes_forbidden_use_axis_levels"


def test_persona_effect_rejects_axis_not_exposed_by_selected_profile(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    payload, reason = module._payload_normalize_motion_arguments_payload(
        {
            "intent_tags": ["happy"],
            "axis_levels": {
                "head_yaw": 1,
                "unknown_axis": 2,
            },
        },
        _build_runtime_state(),
        base_reason="persona_effect",
        append_resolution_reason=lambda base, suffix: ";".join(
            item for item in (base, suffix) if item
        ),
        sanitize_reason_fragment=lambda value: str(value).strip(),
    )

    assert payload is None
    assert reason == "persona_effect;unknown_axis_levels:unknown_axis"


def test_prompt_contributor_returns_extensions_for_core_reply_purpose(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    view = _build_view(phase="final", purpose="core_reply")

    extensions = asyncio.run(contributor.collect(event, None, view))
    assert isinstance(extensions, list)
    assert len(extensions) == 2


def test_prompt_purpose_controls_eligibility_without_entering_runtime_payload(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    for purpose, expect_present in [
        ("persona_reply", True),
        ("core_reply", True),
        ("router", False),
    ]:
        view = _build_view(phase="decision", purpose=purpose)
        extensions = asyncio.run(contributor.collect(event, None, view))
        if not expect_present:
            assert extensions is None
            continue
        assert all(item.mount != "context" for item in extensions)


def test_prompt_runtime_includes_previous_motion_variation_hint(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    event.adapter.turn_coordinator._last_prompt_motion_snapshot = {
        "schema_version": "engine.motion_intent.v4",
        "motion_resource_id": "serious_explain",
        "axis_levels": {
            "head_yaw": 4,
            "body_yaw": -4,
        },
    }
    view = _build_view(phase="decision", purpose="persona_reply")

    extensions = asyncio.run(contributor.collect(event, None, view))

    runtime = next(item for item in extensions if item.mount == "context")
    previous_motion = runtime.value["previous_motion"]
    assert previous_motion["key_axis_levels"] == {
        "head_yaw": 4,
        "body_yaw": -4,
    }
    assert previous_motion["motion_resource_id"] == "serious_explain"
    assert previous_motion["was_sequence"] is False
    assert "按本轮语义重新选择方向、幅度和身体重心" in previous_motion["guidance"]
    assert "previous_motion_summary" not in runtime.value


def test_prompt_reference_projection_supports_sequence_and_current_axes_only(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    projected = module._project_reference_examples_for_prompt(
        [
            {
                "input": "先左后右。",
                "output": {
                    "intent_tags": ["连续动作"],
                    "motion_steps": [
                        {
                            "axis_levels": {"head_yaw": -3, "unknown_axis": -4},
                            "duration_weight": 1,
                        },
                        {
                            "axis_levels": {"head_yaw": 3, "unknown_axis": 4},
                            "duration_weight": 1,
                        },
                    ],
                },
            }
        ],
        allowed_axis_ids={"head_yaw"},
        available_levels_by_axis={"head_yaw": set(range(-4, 5))},
    )

    assert projected[0]["output"]["motion_steps"] == [
        {"axis_levels": {"head_yaw": -3}, "duration_weight": 1},
        {"axis_levels": {"head_yaw": 3}, "duration_weight": 1},
    ]


def test_prompt_fallback_candidates_are_representative_by_axis_descriptors(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    candidates = [
        {
            "id": "calm_a",
            "label": "Calm A",
            "emotion_label": "calm",
            "source": "motion_catalog_semantic_extract",
            "intensity": "low",
            "axes": {"head_yaw": 65},
        },
        {
            "id": "calm_b",
            "label": "Calm B",
            "emotion_label": "calm",
            "source": "motion_catalog_semantic_extract",
            "intensity": "low",
            "axes": {"head_yaw": 66},
        },
        {
            "id": "neutral",
            "label": "neutral",
            "emotion_label": "neutral",
            "source": "semantic_axis_profile",
            "axes": {"head_yaw": 50},
        },
        {
            "id": "calm_c",
            "label": "Calm C",
            "emotion_label": "calm",
            "source": "motion_catalog_semantic_extract",
            "intensity": "low",
            "axes": {"head_yaw": 67},
        },
        {
            "id": "calm_tilt",
            "label": "Calm Tilt",
            "emotion_label": "calm",
            "source": "motion_catalog_semantic_extract",
            "intensity": "low",
            "axes": {"head_roll": 32},
        },
        {
            "id": "calm_forward",
            "label": "Calm Forward",
            "emotion_label": "calm",
            "source": "motion_catalog_semantic_extract",
            "intensity": "low",
            "axes": {"body_pitch": 35},
        },
        {
            "id": "angry_forward",
            "label": "不耐烦前倾",
            "emotion_label": "angry",
            "source": "motion_catalog_semantic_extract",
            "intensity": "medium",
            "emotion_bias": ["angry", "disgust"],
            "recommended_scenarios": ["吐槽"],
            "axes": {"head_yaw": 30, "body_pitch": 35},
        },
        {
            "id": "surprised",
            "label": "Surprised",
            "emotion_label": "surprised",
            "source": "expression_parameter_extract",
            "intensity": "high",
            "axes": {"eye_open_left": 80},
        },
    ]

    selected = module._build_prompt_fallback_pose_candidates(candidates, limit=4)
    selected_ids = [item["id"] for item in selected]
    selected_descriptors = {
        descriptor
        for item in selected
        for descriptor in item["pose_descriptors"]
    }

    assert "neutral" not in selected_ids
    assert "calm_tilt" in selected_ids
    assert "calm_forward" in selected_ids
    assert "angry_forward" in selected_ids or "surprised" in selected_ids
    assert {"tilt_left", "lean_forward"}.issubset(selected_descriptors)
    assert selected_ids != ["calm_a", "calm_b", "calm_c", "calm_tilt"]


def test_prompt_fallback_descriptors_follow_profile_neutral_not_fixed_50(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    semantic_profile = {
        "axes": [
            {
                "id": "head_yaw",
                "control_role": "primary",
                "neutral": 30,
                "value_range": [0, 100],
                "soft_range": [24, 36],
            },
            {
                "id": "body_pitch",
                "control_role": "primary",
                "neutral": 70,
                "value_range": [0, 100],
                "soft_range": [66, 74],
            },
        ]
    }
    candidates = [
        {
            "id": "off_center",
            "label": "Off Center",
            "source": "motion_catalog_semantic_extract",
            "axes": {"head_yaw": 40, "body_pitch": 58},
        }
    ]

    selected = module._build_prompt_fallback_pose_candidates(
        candidates,
        semantic_profile=semantic_profile,
        limit=4,
    )

    assert selected[0]["pose_descriptors"] == ["lean_forward", "look_right"]


def test_motion_visibility_summary_includes_pose_descriptors_and_soft_range_axes(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    semantic_profile = {
        "axes": [
            {
                "id": "head_yaw",
                "control_role": "primary",
                "semantic_group": "head",
                "neutral": 30,
                "value_range": [0, 100],
                "soft_range": [24, 36],
            },
            {
                "id": "body_pitch",
                "control_role": "primary",
                "semantic_group": "body",
                "neutral": 70,
                "value_range": [0, 100],
                "soft_range": [66, 74],
            },
            {
                "id": "eye_open_left",
                "control_role": "hint",
                "semantic_group": "eye",
                "neutral": 50,
                "value_range": [0, 100],
                "soft_range": [45, 55],
            },
        ]
    }

    summary = module._build_motion_visibility_summary(
        axes={"head_yaw": 40, "body_pitch": 58, "eye_open_left": 50},
        semantic_profile=semantic_profile,
    )

    assert summary["skeleton_groups"] == ["head", "body"]
    assert summary["skeleton_groups_present"] == ["head", "body"]
    assert summary["missing_skeleton_groups"] == ["gaze"]
    assert summary["outside_soft_range_axes"] == ["head_yaw", "body_pitch"]
    assert summary["pose_descriptors"] == ["lean_forward", "look_right"]
    assert summary["neutralish_axes"] == ["eye_open_left"]
    assert "skeleton_repair_added_axes" not in summary


def test_fallback_pose_candidates_prioritize_enabled_matching_user_tuning(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    runtime_state = _build_runtime_state()
    semantic_profile = runtime_state.model_info["models"][0]["semantic_axis_profile"]
    runtime_state.motion_tuning_samples = [
        {
            "id": "disabled",
            "model_name": "pet",
            "profile_id": "pet.semantic.v1",
            "profile_revision": 2,
            "emotion_label": "disabled",
            "enabled_for_llm_reference": False,
            "adjusted_axes": {"head_yaw": 90},
        },
        {
            "id": "old_revision",
            "model_name": "pet",
            "profile_id": "pet.semantic.v1",
            "profile_revision": 1,
            "emotion_label": "old",
            "enabled_for_llm_reference": True,
            "adjusted_axes": {"head_yaw": 80},
        },
        {
            "id": "user_pose",
            "model_name": "pet",
            "profile_id": "pet.semantic.v1",
            "profile_revision": 2,
            "emotion_label": "happy",
            "enabled_for_llm_reference": True,
            "adjusted_axes": {
                "head_yaw": 64,
                "eye_open_left": 30,
                "debug_tail": 100,
            },
        },
    ]

    candidates = module.build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
    )

    assert candidates[0]["source"] == "motion_tuning_sample"
    assert candidates[0]["id"] == "happy_user_pose"
    assert candidates[0]["axes"] == {"head_yaw": 64.0, "eye_open_left": 30.0}
    assert {item["id"] for item in candidates}.isdisjoint(
        {"disabled_disabled", "old_old_revision"}
    )


def test_fallback_pose_candidates_use_expression_dominant_parameter_ids(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    runtime_state = _build_runtime_state()
    semantic_profile = runtime_state.model_info["models"][0]["semantic_axis_profile"]
    runtime_state.model_info = {
        "selected_model": "pet",
        "models": [
            {
                "name": "pet",
                "semantic_axis_profile": semantic_profile,
                "constraints": {
                    "expressions": [
                        {
                            "name": "Question",
                            "file": "Expressions/Question.exp3.json",
                            "catalog_id": "expr_question",
                            "catalog_label": "疑问符号表情",
                            "catalog_description": "适合短促疑问和反问。",
                            "catalog_tags": ["疑问", "反问"],
                            "catalog_emotion_bias": ["question", "confused"],
                            "catalog_intensity": "low",
                            "recommended_scenarios": ["短促疑问", "反问"],
                            "parameters": [],
                            "dominant_parameters": [{"id": "ParamEyeLOpen"}],
                        }
                    ]
                },
            }
        ],
    }

    candidates = module.build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
    )

    assert candidates[0]["id"] == "expr_question"
    assert candidates[0]["source"] == "profile_binding_parameter_extract"
    assert candidates[0]["label"] == "疑问符号表情"
    assert candidates[0]["description"] == "适合短促疑问和反问。"
    assert candidates[0]["emotion_bias"] == ["question", "confused"]
    assert candidates[0]["recommended_scenarios"] == ["短促疑问", "反问"]
    assert candidates[0]["axes"] == {"eye_open_left": 50.0}
    assert all(candidate["id"] != "neutral" for candidate in candidates)


def test_fallback_pose_candidates_exclude_neutral_for_skeleton_repair(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    runtime_state = _build_runtime_state()
    semantic_profile = runtime_state.model_info["models"][0]["semantic_axis_profile"]
    candidates = module.build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
        require_non_neutral_skeleton=True,
    )

    assert all(candidate["id"] != "neutral" for candidate in candidates)


def test_fallback_pose_candidates_use_motion_catalog_metadata_only_when_axes_exist(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    runtime_state = _build_runtime_state()
    semantic_profile = runtime_state.model_info["models"][0]["semantic_axis_profile"]

    candidates = module.build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
    )

    catalog_candidate = next(
        item for item in candidates if item["id"] == "serious_explain"
    )
    assert catalog_candidate["source"] == "motion_catalog_semantic_extract"
    assert catalog_candidate["label"] == "认真说明"
    assert catalog_candidate["description"] == "姿态更稳定、更像进入解释状态。"
    assert catalog_candidate["emotion_bias"] == ["neutral", "thinking"]
    assert catalog_candidate["recommended_scenarios"] == ["说明问题", "认真解释"]
    assert catalog_candidate["intensity"] == "medium"
    assert catalog_candidate["axes"] == {"head_yaw": 80.0}
    assert "file" not in catalog_candidate
    assert "motion_id" not in catalog_candidate


def test_result_contributor_returns_persona_effect_motion_as_client_object(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="你好呀",
        immediate_reply="你好呀",
        effect_calls=[
            _motion_effect_call(
                {
                "intent_tags": ["happy"],
                "axis_levels": {"head_yaw": 4},
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    client_object = contribution.client_objects[0]
    assert client_object["type"] == "ag99live.motion_payload"
    assert client_object["source"] == "persona_effect"
    assert client_object["motion_payload"]["schema_version"] == "engine.motion_intent.v4"
    assert client_object["motion_payload"]["axis_levels"] == {"head_yaw": 4}
    assert contribution.platform_extras == {}
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "persona_effect_motion_client_object"
    )


def test_result_contributor_rejects_non_integer_axis_levels_from_persona_effect(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="你好呀",
        immediate_reply="你好呀",
        effect_calls=[
            _motion_effect_call(
                {
                    "intent_tags": ["happy"],
                    "axis_levels": {
                        "head_yaw": "2",
                        "eye_open_left": 1.5,
                    },
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert contribution.client_objects == []
    assert (
        contribution.metadata["ag99live_motion_schedule"]["motion_resolution_reason"]
        == "persona_effect:rejected_axis_levels:head_yaw,eye_open_left:self_reply_motion_missing"
    )


@pytest.mark.parametrize(
    "arguments",
    [
        {"intent_tags": ["wink"], "axis_levels": {"eye_open_left": 3}},
        {
            "intent_tags": ["wink sequence"],
            "motion_steps": [
                {"axis_levels": {"eye_open_left": -3}, "duration_weight": 1},
                {"axis_levels": {"eye_open_left": 3}, "duration_weight": 1},
            ],
        },
    ],
)
def test_result_contributor_rejects_unavailable_one_sided_axis_levels(
    install_fake_astrbot,
    monkeypatch,
    arguments,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(raw_turn_id="raw-turn")
    _make_left_eye_open_axis_one_sided(event)
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="眨眼",
        immediate_reply="眨眼",
        effect_calls=[_motion_effect_call(arguments)],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert contribution.client_objects == []
    assert "unavailable_axis_levels:eye_open_left:3" in contribution.metadata[
        "ag99live_motion_schedule"
    ]["motion_resolution_reason"]


@pytest.mark.parametrize("level", [-3, 0])
def test_result_contributor_accepts_available_one_sided_axis_levels(
    install_fake_astrbot,
    monkeypatch,
    level,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()
    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(raw_turn_id="raw-turn")
    _make_left_eye_open_axis_one_sided(event)
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="眨眼",
        immediate_reply="眨眼",
        effect_calls=[
            _motion_effect_call(
                {"intent_tags": ["wink"], "axis_levels": {"eye_open_left": level}}
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert contribution.client_objects[0]["motion_payload"]["axis_levels"] == {
        "eye_open_left": level
    }


def test_result_contributor_returns_motion_sequence_in_single_effect(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="左右看看",
        immediate_reply="左右看看",
        effect_calls=[
            _motion_effect_call(
                {
                    "intent_tags": ["测试", "左右扭头"],
                    "motion_steps": [
                        {
                            "axis_levels": {"head_yaw": -3, "eye_open_left": -2},
                            "duration_weight": 1,
                        },
                        {
                            "axis_levels": {"head_yaw": 3, "eye_open_left": 2},
                            "duration_weight": 1,
                        },
                    ],
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    payload = contribution.client_objects[0]["motion_payload"]
    assert "axis_levels" not in payload
    assert payload["motion_steps"] == [
        {
            "axis_levels": {"head_yaw": -3, "eye_open_left": -2},
            "duration_weight": 1,
        },
        {
            "axis_levels": {"head_yaw": 3, "eye_open_left": 2},
            "duration_weight": 1,
        },
    ]


def test_result_contributor_rejects_duplicate_motion_effects(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="你好呀",
        immediate_reply="你好呀",
        effect_calls=[
            _motion_effect_call({"intent_tags": ["happy"], "axis_levels": {"head_yaw": 2}}),
            _motion_effect_call({"intent_tags": ["疑惑"], "axis_levels": {"head_yaw": -1}}),
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert contribution.client_objects == []
    assert (
        contribution.metadata["ag99live_motion_schedule"]["motion_resolution_reason"]
        == "persona_effect_duplicate:self_reply_motion_missing"
    )


def test_persona_effect_motion_logs_input_and_output_diagnostics(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    log_messages: list[str] = []

    class LoggerStub:
        def info(self, message, *args, **kwargs) -> None:
            del kwargs
            if args:
                log_messages.append(message % args)
            else:
                log_messages.append(str(message))

    monkeypatch.setattr(module, "logger", LoggerStub())

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="你好呀",
        immediate_reply="你好呀",
        effect_calls=[
            _motion_effect_call(
                {
                    "intent_tags": ["thinking", "explain"],
                    "motion_resource_id": "serious_explain",
                    "axis_levels": {
                        "head_yaw": 2,
                        "eye_open_left": 1,
                    },
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    persona_effect_logs = [
        item
        for item in log_messages
        if item.startswith("WIRING persona_effect_motion ")
    ]
    assert len(persona_effect_logs) == 1
    log_line = persona_effect_logs[0]
    assert "effect_fields=axis_levels,intent_tags,motion_resource_id" in log_line
    assert "effect_axis_keys=eye_open_left,head_yaw" in log_line
    assert "effect_intent_tags=thinking,explain" in log_line
    assert "effect_motion_resource_id=serious_explain" in log_line
    assert "payload_axis_keys=eye_open_left,head_yaw" in log_line
    assert "payload_motion_resource_id=serious_explain" in log_line
    assert "payload_fallback_pose_id" not in log_line
    assert "reason=persona_effect:motion_id_validated" in log_line


def test_result_contributor_schedules_motion_for_immediate_reply(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        final_result='你好呀 <@anim {"mode":"inline"}>',
        immediate_reply='你好呀 <@anim {"mode":"inline"}>',
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    # Secondary motion scheduling is disabled; inline contract handles it
    assert scheduled_calls == []
    assert (
        contribution.metadata["ag99live_motion_schedule"]["scheduled_frontend_turn_id"]
        == "raw-turn"
    )
    assert (
        contribution.metadata["ag99live_motion_schedule"]["active_frontend_turn_id"]
        == "session-turn"
    )


def test_result_contributor_skips_motion_when_effect_calls_missing_in_immediate_phase(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="你好呀",
        immediate_reply="你好呀",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert contribution.client_objects == []
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["scheduled"] is False
    assert metadata["reason"] == "motion_payload_missing"
    assert (
        metadata["motion_resolution_reason"]
        == "effect_calls_missing:self_reply_motion_missing"
    )


def test_result_contributor_skips_motion_when_effect_calls_missing_in_split_final_phase(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    view = _build_view(
        phase="final",
        route_mode="delegate_to_core",
        final_result="最终回复文本",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert contribution.client_objects == []
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["scheduled"] is False
    assert metadata["reason"] == "motion_payload_missing"
    assert (
        metadata["motion_resolution_reason"]
        == "effect_calls_missing:motion_payload_missing"
    )


def test_result_contributor_does_not_invoke_legacy_provider_when_hints_are_missing(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    class ProviderStub:
        async def text_chat(self, *, prompt: str, system_prompt: str):
            assert "用户说话内容" in prompt
            assert "最终回复文本" in prompt
            assert system_prompt
            return type(
                "ResponseStub",
                (),
                {
                    "completion_text": json.dumps(
                        {
                            "emotion_label": "happy",
                            "duration_hint_ms": 1000,
                            "fallback_pose_id": "neutral",
                            "axes": {
                                "head_yaw": 74,
                                "eye_open_left": 82,
                            },
                        },
                        ensure_ascii=False,
                    )
                },
            )()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    event.adapter.turn_coordinator.runtime_state.selected_motion_analysis_provider = ProviderStub()
    event.set_extra("ag99live_original_message_str", "用户说话内容")
    view = _build_view(
        phase="final",
        route_mode="delegate_to_core",
        final_result="最终回复文本",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert contribution.client_objects == []
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["scheduled"] is False
    assert metadata["reason"] == "motion_payload_missing"


def test_result_contributor_returns_persona_effect_motion_in_split_final_phase(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    view = _build_view(
        phase="final",
        route_mode="delegate_to_core",
        final_result="最终回复文本",
        effect_calls=[
            _motion_effect_call(
                {
                "intent_tags": ["focused"],
                "axis_levels": {"head_yaw": 1},
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    assert contribution.client_objects[0]["source"] == "persona_effect"
    assert event.get_extra("ag99live_split_motion_scheduled") is True
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "persona_effect_motion_client_object"
    )


def test_result_contributor_ignores_removed_inline_mode_for_final_phase(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="inline_first", raw_turn_id="raw-turn")
    view = _build_view(
        phase="final",
        route_mode="delegate_to_core",
        final_result="最终回复文本",
        effect_calls=[
            _motion_effect_call(
                {
                    "intent_tags": ["说明"],
                    "axis_levels": {"head_yaw": 1, "eye_open_left": 1},
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "persona_effect_motion_client_object"
    )


def test_result_contributor_reports_missing_motion_for_hybrid_immediate_reply(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="hybrid",
        final_result="先给你一句过渡回复",
        immediate_reply="先给你一句过渡回复",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert contribution.client_objects == []
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["source"] == "interaction_result_immediate"
    assert metadata["reason"] == "motion_payload_missing"
    assert (
        metadata["motion_resolution_reason"]
        == "effect_calls_missing:motion_payload_missing"
    )


def test_result_contributor_preserves_neutral_persona_effect_for_engine_feedback(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="hybrid",
        final_result="先给你一句过渡回复",
        immediate_reply="先给你一句过渡回复",
        effect_calls=[
            _motion_effect_call(
                {
                "intent_tags": ["thinking"],
                "axis_levels": {"head_yaw": 0},
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    assert contribution.client_objects[0]["motion_payload"]["axis_levels"] == {
        "head_yaw": 0,
    }
    assert event.get_extra("ag99live_split_motion_scheduled") is True
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["reason"] == "persona_effect_motion_client_object"
    assert metadata["source"] == "persona_effect"
    assert metadata["motion_resolution_reason"].startswith("persona_effect")


def test_result_contributor_schedules_final_motion_after_hybrid_immediate_phase(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")

    immediate = asyncio.run(
        contributor.collect(
            event,
            None,
            _build_view(
                phase="immediate",
                route_mode="hybrid",
                final_result="你好呀",
                immediate_reply="你好呀",
                effect_calls=[
                    _motion_effect_call(
                        {
                            "intent_tags": ["happy"],
                            "axis_levels": {"head_yaw": 2},
                        }
                    )
                ],
            ),
        )
    )
    final = asyncio.run(
        contributor.collect(
            event,
            None,
            _build_view(
                phase="final",
                route_mode="delegate_to_core",
                final_result="最终回复文本",
                effect_calls=[
                    _motion_effect_call(
                        {
                            "intent_tags": ["happy"],
                            "axis_levels": {"head_yaw": 2},
                        }
                    )
                ],
            ),
        )
    )

    assert immediate is not None
    assert final is not None
    assert scheduled_calls == []
    assert len(immediate.client_objects) == 1
    assert len(final.client_objects) == 1
    assert (
        final.metadata["ag99live_motion_schedule"]["reason"]
        == "persona_effect_motion_client_object"
    )


def test_result_contributor_prefers_final_response_effect_calls(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    event.set_extra(
        "_interaction_final_response_effect_calls",
        [
            _motion_effect_call(
                {
                    "intent_tags": ["final"],
                    "axis_levels": {"head_yaw": 2},
                }
            )
        ],
    )

    contribution = asyncio.run(
        contributor.collect(
            event,
            None,
            _build_view(
                phase="final",
                route_mode="hybrid",
                final_result="最终回复文本",
                effect_calls=[
                    _motion_effect_call(
                        {
                            "intent_tags": ["old"],
                            "axis_levels": {"head_yaw": 2},
                        }
                    )
                ],
            ),
        )
    )

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    motion_payload = contribution.client_objects[0]["motion_payload"]
    assert motion_payload["intent_tags"] == ["final"]
    assert motion_payload["axis_levels"]["head_yaw"] == 2


def test_result_contributor_uses_official_event_extra_reply_plan_when_view_plan_missing(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    event.set_extra(
        "_interaction_route_decision",
        {
            "route_mode": "self_reply",
            "should_emit_immediate_reply": True,
        },
    )
    view = _build_view(
        phase="immediate",
        route_mode=None,
        final_result="你好呀",
        immediate_reply="你好呀",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    # Secondary motion scheduling is disabled across all modes
    assert scheduled_calls == []
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["reply_plan_source"] == "event_extra"
    assert metadata["reply_plan_route_mode"] == "self_reply"
    assert metadata["reason"] == "motion_payload_missing"
    assert metadata["scheduled"] is False
    assert contribution.client_objects == []


def test_result_contributor_uses_result_view_route_decision(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, _scheduled_calls = _build_event(raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="你好呀",
        immediate_reply="你好呀",
        effect_calls=[
            _motion_effect_call(
                {
                    "intent_tags": ["轻快"],
                    "axis_levels": {"head_yaw": 2},
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert len(contribution.client_objects) == 1
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["reply_plan_source"] == "view"
    assert metadata["reply_plan_route_mode"] == "self_reply"
    assert metadata["scheduled"] is True


def test_result_contributor_schedules_immediate_effect_before_reply_plan_is_persisted(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="inline_first", raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode=None,
        final_result="你好呀",
        immediate_reply="你好呀",
        effect_calls=[
            _motion_effect_call(
                {
                    "intent_tags": ["轻快"],
                    "axis_levels": {"head_yaw": 2},
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["reply_plan_source"] is None
    assert metadata["reply_plan_route_mode"] is None
    assert metadata["reason"] == "persona_effect_motion_client_object"
    assert metadata["scheduled"] is True


def test_result_contributor_ignores_removed_inline_mode_for_self_reply(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="inline_first", raw_turn_id="raw-turn")
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="你好呀",
        immediate_reply="你好呀",
        effect_calls=[
            _motion_effect_call(
                {
                    "intent_tags": ["轻快"],
                    "axis_levels": {"head_yaw": 1, "eye_open_left": 1},
                }
            )
        ],
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "persona_effect_motion_client_object"
    )


def test_self_reply_missing_effect_calls_skips_motion_with_provider_available(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, scheduled_calls = _build_event(raw_turn_id="turn-1")

    # Inject a mock motion analysis provider that returns non-neutral axes.
    mock_response = type("Response", (), {"completion_text": json.dumps({
        "emotion_label": "mocking",
        "duration_hint_ms": 1500,
        "fallback_pose_id": "\u4e0d\u8010\u70e6\u524d\u503e",
        "axes": {"head_yaw": 30},
    })})()
    mock_provider = type("Provider", (), {
        "text_chat": lambda *args, **kwargs: asyncio.ensure_future(
            asyncio.sleep(0, result=mock_response)
        ),
    })()
    event.adapter.turn_coordinator.runtime_state.selected_motion_analysis_provider = mock_provider

    contributor = module.AG99liveMotionResultContributor()
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="\u4f60\u662f\u5b87\u5b99\u65e0\u654c\u5c0f\u673a\u5668\u4eba",
        immediate_reply="\u4f60\u662f\u5b87\u5b99\u65e0\u654c\u5c0f\u673a\u5668\u4eba",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))
    assert contribution is not None
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["scheduled"] is False
    assert metadata["source"] == "interaction_result_immediate"
    assert metadata["reason"] == "motion_payload_missing"
    assert contribution.client_objects == []


def test_self_reply_missing_effect_calls_skips_motion_without_provider(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, scheduled_calls = _build_event(raw_turn_id="turn-2")
    # Provider is None (default) — realtime cannot run.

    contributor = module.AG99liveMotionResultContributor()
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="\u4f60\u597d",
        immediate_reply="\u4f60\u597d",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))
    assert contribution is not None
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["scheduled"] is False
    assert metadata["source"] == "interaction_result_immediate"
    assert metadata["reason"] == "motion_payload_missing"
    assert contribution.client_objects == []


def test_register_interaction_contributors_uses_available_hooks(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    prompt_contributors: list[object] = []
    result_contributors: list[object] = []
    unregistered_effect_plugins: list[str | None] = []
    registered_effects: list[object] = []

    class ContextStub:
        def unregister_persona_effects(self, *, plugin_id=None, module_prefix=None) -> int:
            del module_prefix
            unregistered_effect_plugins.append(plugin_id)
            return 0

        def register_persona_effect(self, effect) -> None:
            registered_effects.append(effect)

        def register_interaction_prompt_contributor(self, contributor) -> None:
            prompt_contributors.append(contributor)

        def register_interaction_result_contributor(self, contributor) -> None:
            result_contributors.append(contributor)

    module.register_ag99live_interaction_contributors(ContextStub())

    assert len(prompt_contributors) == 1
    assert len(result_contributors) == 1
    assert unregistered_effect_plugins == ["astrbot_plugin_ag99live_adapter"]
    assert len(registered_effects) == 1
    effect = registered_effects[0]
    assert effect.plugin_id == "astrbot_plugin_ag99live_adapter"
    assert effect.name == "ag99live.motion"
    assert "Emit exactly one motion effect" in effect.description
    assert "never split a movement sequence into multiple effects" in effect.description
    assert effect.legacy_hint_names == ()
    assert effect.parameters["required"] == ["intent_tags"]
    assert effect.parameters["oneOf"] == [
        {"required": ["axis_levels"]},
        {"required": ["motion_steps"]},
    ]
    assert effect.parameters["additionalProperties"] is False
    assert effect.parameters["properties"]["axis_levels"]["minProperties"] == 1
    assert effect.parameters["properties"]["axis_levels"]["maxProperties"] == 6
    assert effect.parameters["properties"]["axis_levels"]["additionalProperties"]["minimum"] == -4
    assert effect.parameters["properties"]["axis_levels"]["additionalProperties"]["maximum"] == 4
    assert effect.parameters["properties"]["intent_tags"]["minItems"] == 1
    assert effect.parameters["properties"]["intent_tags"]["maxItems"] == 6
    assert effect.parameters["properties"]["intent_tags"]["uniqueItems"] is True
    assert effect.parameters["properties"]["duration_hint_ms"] == {
        "type": "integer",
        "minimum": 320,
        "maximum": 15000,
    }
    assert set(effect.parameters["properties"]) == {
        "intent_tags",
        "axis_levels",
        "motion_steps",
        "duration_hint_ms",
        "expression_resource_id",
        "motion_resource_id",
    }
    assert effect.parameters["allOf"] == [
        {
            "not": {
                "required": ["expression_resource_id", "motion_resource_id"],
            },
        },
        {
            "not": {
                "required": ["motion_steps", "motion_resource_id"],
            },
        },
    ]
