from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
from unittest.mock import patch


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

    interaction_module.InteractionResultContribution = InteractionResultContribution
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
                    "schema_version": "ag99.semantic_axis_profile.v1",
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
                            "catalog_exclusive_with": ["happy_burst"],
                            "recommended_scenarios": ["说明问题", "认真解释"],
                        }
                    ],
                    "expressions": [
                        {
                            "name": "Surprised",
                            "file": "Expressions/Surprised.exp3.json",
                            "category": "base_emotion",
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
            "enable_inline_motion_contract": True,
            "enable_realtime_motion_plan": True,
            "selected_motion_analysis_provider": None,
            "realtime_motion_timeout_seconds": 2.0,
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


def _build_view(
    *,
    phase: str,
    route_mode: str | None = "self_reply",
    should_emit_immediate_reply: bool | None = None,
    final_result: str | None = None,
    core_result: str | None = None,
    immediate_reply: str | None = None,
    purpose: str | None = None,
    plugin_hints: object | None = None,
):
    decision = None
    if route_mode is not None or should_emit_immediate_reply is not None:
        decision = {}
        if route_mode is not None:
            decision["route_mode"] = route_mode
        if should_emit_immediate_reply is not None:
            decision["should_emit_immediate_reply"] = should_emit_immediate_reply
    metadata: dict[str, object] = {"phase": phase}
    if purpose is not None:
        metadata["purpose"] = purpose
    return type(
        "ResultViewStub",
        (),
        {
            "turn_id": "interaction-turn",
            "session_id": "olv_pet_adapter:friend_message:desktop-client",
            "decision": decision,
            "final_result": final_result,
            "core_result": core_result,
            "immediate_reply": immediate_reply,
            "metadata": metadata,
            "plugin_hints": plugin_hints,
        },
    )()


def test_prompt_contributor_returns_capability_and_runtime_extensions(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionPromptContributor()
    event, _scheduled_calls = _build_event()
    view = _build_view(phase="decision", route_mode="delegate_to_core", purpose="persona_reply")

    extensions = asyncio.run(contributor.collect(event, None, view))

    assert isinstance(extensions, list)
    assert len(extensions) == 3
    system = next(item for item in extensions if item.mount == "system")
    capability = next(item for item in extensions if item.mount == "capability")
    runtime = next(item for item in extensions if item.mount == "context")
    assert "AG99live Motion 是当前桌宠前端的主动作通道" in system.value
    assert '"plugin_hints":{"ag99live_motion"' in system.value
    assert '"fallback_pose_id":"neutral"' not in system.value
    assert '"choice"' not in system.value
    assert '"motion_id"' not in system.value
    assert "immediate_spoken_reply" in system.value
    assert "避免连续复用同一组轴和值" in system.value
    assert "少量可用轴和合法数值幅度" in system.value
    assert "角色风格偏好" in system.value
    assert "中性时偏少轴" in system.value
    assert capability.value["configured_generation_mode"] == "split_after_reply"
    assert capability.value["motion_style_prompt"] == "中性时偏少轴，开心时优先笑眼和嘴角。"
    assert capability.value["semantic_profile"]["profile_id"] == "pet.semantic.v1"
    assert "低值=turn left；高值=turn right" in capability.value["semantic_profile"]["axis_prompt"]
    assert "使用说明=Use for attention direction." in capability.value["semantic_profile"]["axis_prompt"]
    assert "低值=turn left；高值=turn right" in system.value
    assert "可复用的现成 motion3 动画" not in system.value
    assert "旧表情参考模板" not in system.value
    assert "[动作]" not in system.value
    assert "head_yaw" in system.value
    assert "fallback_pose_id" not in system.value
    assert "intent_tags" in system.value
    assert "resource_id" in system.value
    assert "axes 语义轴目标组" in system.value
    assert "关键轴=head_yaw=80" in system.value
    assert "姿态更稳定" in system.value
    assert "eye_open_left" in system.value
    assert "ParamHairX" not in system.value
    assert "ParamPhysicsX" not in system.value
    assert "tablet" not in system.value.lower()
    assert "motion_reference_templates" not in capability.value
    assert "motion_catalog_options" not in capability.value
    assert "fallback_pose_candidates" in capability.value
    assert 2 <= len(capability.value["fallback_pose_candidates"]) <= 4
    assert all(
        item["id"] != "neutral"
        for item in capability.value["fallback_pose_candidates"]
    )
    assert all(
        item["pose_descriptors"]
        for item in capability.value["fallback_pose_candidates"]
    )
    catalog_candidate = next(
        item
        for item in capability.value["fallback_pose_candidates"]
        if item["id"] == "serious_explain"
    )
    assert catalog_candidate["source"] == "motion_catalog_semantic_extract"
    assert catalog_candidate["description"] == "姿态更稳定、更像进入解释状态。"
    assert catalog_candidate["emotion_bias"] == ["neutral", "thinking"]
    assert catalog_candidate["recommended_scenarios"] == ["说明问题", "认真解释"]
    assert catalog_candidate["key_axes"] == {"head_yaw": 80.0}
    prompt_axis_ids = [
        item["id"] for item in capability.value["semantic_profile"]["prompt_axes"]
    ]
    assert prompt_axis_ids == ["head_yaw", "eye_open_left"]
    assert capability.value["semantic_profile"]["prompt_axes"][0]["positive_semantics"] == [
        "turn right"
    ]
    assert capability.value["semantic_profile"]["prompt_axes"][0]["negative_semantics"] == [
        "turn left"
    ]
    assert capability.value["semantic_profile"]["prompt_axes"][0]["usage_notes"] == (
        "Use for attention direction."
    )
    assert (
        capability.value["plugin_hints_format"]["ag99live_motion"]["axes"]["head_yaw"]
        > 58
    )
    assert set(
        capability.value["plugin_hints_format"]["ag99live_motion"]["axes"]
    ) == {"head_yaw", "eye_open_left"}
    assert (
        capability.value["plugin_hints_format"]["ag99live_motion"]["intent_tags"]
        == ["语气关键词", "姿态关键词", "场景关键词"]
    )
    assert "intent_tags" in system.value
    assert "resource_id" in system.value
    assert (
        "fallback_pose_id" not in capability.value["plugin_hints_format"]["ag99live_motion"]
    )
    assert capability.value["fallback_pose_candidates"][0]["label"] in system.value
    assert runtime.value["configured_generation_mode"] == "split_after_reply"
    assert runtime.value["prompt_purpose"] == "persona_reply"


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
    assert len(extensions) == 3


def test_prompt_purpose_appears_in_runtime_payload(
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
        runtime = next(item for item in extensions if item.mount == "context")
        assert runtime.value["prompt_purpose"] == purpose


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
        repair_added_axes=["body_pitch"],
        repair_replaced_axes=[],
    )

    assert summary["skeleton_groups"] == ["head", "body"]
    assert summary["skeleton_groups_present"] == ["head", "body"]
    assert summary["missing_skeleton_groups"] == ["gaze"]
    assert summary["outside_soft_range_axes"] == ["head_yaw", "body_pitch"]
    assert summary["pose_descriptors"] == ["lean_forward", "look_right"]
    assert summary["neutralish_axes"] == ["eye_open_left"]
    assert summary["skeleton_repair_added_axes"] == ["body_pitch"]


def test_view_plugin_hints_prioritized_over_event_extra(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    # Set a DIFFERENT hint on event extra — should be ignored when view has plugin_hints.
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["event_extra"],
                "axes": {"head_yaw": 20},
            }
        },
    )
    view = _build_view(
        phase="final",
        route_mode="hybrid",
        final_result="助手回复",
        plugin_hints={
            "ag99live_motion": {
                "intent_tags": ["view_hints"],
                "axes": {"head_yaw": 30},
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload_with_reason(
        event, runtime_state, view=view
    )[0]
    assert payload is not None
    assert payload["emotion_label"] == "view_hints"
    assert payload["axes"]["head_yaw"] == 30


def test_event_extra_used_as_fallback_when_view_has_no_plugin_hints(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["fallback_extra"],
                "axes": {"head_yaw": 40},
            }
        },
    )
    view = _build_view(phase="final", route_mode="hybrid", final_result="助手回复")

    payload = module._resolve_plugin_hints_motion_payload_with_reason(
        event, runtime_state, view=view
    )[0]
    assert payload is not None
    assert payload["emotion_label"] == "fallback_extra"


def test_log_plugin_hints_motion_resolution_prefers_view_hints(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["event_extra"],
                "axes": {"head_yaw": 20},
            }
        },
    )
    view = _build_view(
        phase="final",
        plugin_hints={
            "ag99live_motion": {
                "intent_tags": ["view_hints"],
                "axes": {"head_yaw": 30, "head_roll": 60},
            }
        },
    )

    with patch.object(module.logger, "info") as info_mock:
        module._log_plugin_hints_motion_resolution(
            event,
            phase="final",
            payload={"axes": {"head_yaw": 30}},
            reason="ok",
            view=view,
        )

    _, phase, payload_present, reason, hint_keys, motion_axes = info_mock.call_args.args
    assert phase == "final"
    assert payload_present is True
    assert reason == "ok"
    assert hint_keys == "ag99live_motion"
    assert motion_axes == "head_roll,head_yaw"


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

    assert candidates[0]["id"] == "question"
    assert candidates[0]["source"] == "profile_binding_parameter_extract"
    assert candidates[0]["axes"] == {"eye_open_left": 50.0}
    assert candidates[-1]["id"] == "neutral"


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


def test_plugin_hints_motion_payload_uses_profile_axis_value_range(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
            {
                "ag99live_motion": {
                    "intent_tags": ["playful"],
                    "duration_hint_ms": 1200,
                    "axes": {
                        "head_yaw": 48,
                        "eye_open_left": 72,
                        "debug_tail": 100,
                        "unknown_axis": 60,
                    },
                }
            },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["schema_version"] == "engine.motion_intent.v3"
    assert payload["mode"] == "expressive"
    assert payload["axes"]["head_yaw"] == 48
    assert payload["axes"]["eye_open_left"] == 72
    assert "debug_tail" not in payload["axes"]
    assert "unknown_axis" not in payload["axes"]


def test_plugin_hints_motion_payload_accepts_json_string(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        json.dumps(
                {
                    "ag99live_motion": {
                        "intent_tags": ["curious"],
                        "duration_hint_ms": 1500,
                        "axes": {
                            "head_yaw": 48,
                            "eye_open_left": 72,
                        },
                    }
                }
        ),
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["emotion_label"] == "curious"
    assert payload["duration_hint_ms"] == 1500
    assert payload["axes"]["head_yaw"] == 48
    assert payload["axes"]["eye_open_left"] == 72


def test_plugin_hints_motion_payload_accepts_fenced_json_string(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        """
        好的，动作参数如下：
        ```json
        {
          "plugin_hints": {
            "ag99live_motion": {
              "intent_tags": ["curious"],
              "duration_hint_ms": "1500",
              "axes": {
                "head_yaw": "48",
                "eye_open_left": 72,
              }
            }
          }
        }
        ```
        """,
    )

    payload, reason = module._resolve_plugin_hints_motion_payload_with_reason(
        event,
        runtime_state,
    )

    assert payload is not None
    assert payload["emotion_label"] == "curious"
    assert payload["duration_hint_ms"] == 1500
    assert payload["axes"]["head_yaw"] == 48
    assert payload["axes"]["eye_open_left"] == 72
    assert "plugin_hints_json_repaired:fenced_json" in reason
    assert "plugin_hints_json_repaired:trailing_commas" in reason


def test_plugin_hints_motion_payload_accepts_text_wrapped_json_object(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        '前缀 {"plugin_hints":{"ag99live_motion":{"intent_tags":["curious"],"axes":{"head_yaw":48}}}} 后缀',
    )

    payload, reason = module._resolve_plugin_hints_motion_payload_with_reason(
        event,
        runtime_state,
    )

    assert payload is not None
    assert payload["emotion_label"] == "curious"
    assert payload["axes"]["head_yaw"] < 42
    assert "plugin_hints_json_repaired:extracted_object" in reason


def test_plugin_hints_motion_payload_accepts_string_number_axes(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["curious"],
                "duration_hint_ms": "1500",
                "axes": {
                    "head_yaw": "48",
                    "eye_open_left": "72.5",
                },
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["duration_hint_ms"] == 1500
    assert payload["axes"]["head_yaw"] == 48
    assert payload["axes"]["eye_open_left"] == 72.5


def test_plugin_hints_expressive_payload_is_pushed_out_of_idle_deadzone(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
            {
                "ag99live_motion": {
                    "intent_tags": ["playful"],
                    "duration_hint_ms": 1200,
                    "axes": {
                        "head_yaw": 50,
                    },
                }
            },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["axes"]["head_yaw"] > 58


def test_plugin_hints_detail_only_axes_are_repaired_from_fallback_pose(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["thinking", "explain"],
                "resource_id": "serious_explain",
                "duration_hint_ms": 1200,
                "axes": {
                    "eye_open_left": 72,
                },
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["axes"]["eye_open_left"] == 72
    assert payload["axes"]["head_yaw"] == 80.0
    assert payload["summary"]["skeleton_repair_added_axes"] == ["head_yaw"]
    assert payload["summary"]["skeleton_repair_replaced_axes"] == []
    assert "motion_id" not in payload
    assert "file" not in payload


def test_plugin_hints_neutral_skeleton_axis_is_replaced_from_fallback_pose(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["thinking", "explain"],
                "resource_id": "serious_explain",
                "duration_hint_ms": 1200,
                "axes": {
                    "head_yaw": 50,
                    "eye_open_left": 72,
                },
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["axes"]["head_yaw"] == 80.0
    assert payload["axes"]["eye_open_left"] == 72
    assert payload["summary"]["skeleton_repair_added_axes"] == []
    assert payload["summary"]["skeleton_repair_replaced_axes"] == ["head_yaw"]


def test_plugin_hints_v3_nested_axis_payload_is_not_repaired_as_valid_axes(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["thinking", "explain"],
                "resource_id": "serious_explain",
                "axes": {
                    "head_yaw": {"value": 62},
                    "eye_open_left": 72,
                },
            }
        },
    )

    payload, reason = module._resolve_plugin_hints_motion_payload_with_reason(
        event,
        runtime_state,
    )

    assert payload is not None
    assert payload["axes"] == {"head_yaw": 80.0}
    assert "axes_empty_or_invalid" in reason
    assert "fallback_pose:serious_explain" in reason


def test_plugin_hints_existing_skeleton_axes_are_not_overwritten_by_repair(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["thinking", "explain"],
                "resource_id": "serious_explain",
                "axes": {
                    "head_yaw": 64,
                    "eye_open_left": 72,
                },
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["axes"]["head_yaw"] == 64
    assert payload["summary"]["skeleton_repair_added_axes"] == []
    assert payload["summary"]["skeleton_repair_replaced_axes"] == []


def test_plugin_hints_forbidden_catalog_fields_are_rejected(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "choice": "catalog",
                "motion_id": "serious_explain",
                "intent_tags": ["explain"],
                "resource_id": "serious_explain",
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is None


def test_plugin_hints_motion_payload_accepts_head_roll_and_mouth_smile(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    runtime_state.model_info = {
        "selected_model": "pet",
        "models": [
            {
                "name": "pet",
                "semantic_axis_profile": {
                    "schema_version": "ag99.semantic_axis_profile.v1",
                    "profile_id": "Mk6_1.0.semantic.v1",
                    "model_id": "Mk6_1.0",
                    "source_hash": "hash",
                    "last_scanned_hash": "hash",
                    "revision": 3,
                    "status": "generated_default",
                    "user_modified": False,
                    "generated_at": "2026-04-26T00:00:00+00:00",
                    "updated_at": "2026-04-26T00:00:00+00:00",
                    "axes": [
                        {
                            "id": "head_roll",
                            "label": "Head Roll",
                            "description": "tilt head left/right",
                            "semantic_group": "head",
                            "control_role": "primary",
                            "neutral": 50,
                            "value_range": [0, 100],
                            "soft_range": [42, 58],
                            "strong_range": [30, 70],
                            "positive_semantics": ["tilt right"],
                            "negative_semantics": ["tilt left"],
                            "usage_notes": "Use for head tilt.",
                            "parameter_bindings": [],
                        },
                        {
                            "id": "mouth_smile",
                            "label": "Mouth Smile",
                            "description": "smile amount",
                            "semantic_group": "mouth",
                            "control_role": "hint",
                            "neutral": 50,
                            "value_range": [0, 100],
                            "soft_range": [42, 58],
                            "strong_range": [30, 70],
                            "positive_semantics": ["smile"],
                            "negative_semantics": ["frown"],
                            "usage_notes": "Use for mouth detail.",
                            "parameter_bindings": [],
                        },
                    ],
                    "couplings": [],
                },
            }
        ],
    }
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["calm"],
                "axes": {
                    "head_roll": 40,
                    "mouth_smile": 65,
                },
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["profile_id"] == "Mk6_1.0.semantic.v1"
    assert payload["profile_revision"] == 3
    assert payload["model_id"] == "Mk6_1.0"
    assert set(payload["axes"]) == {"head_roll", "mouth_smile"}


def test_result_contributor_returns_plugin_hint_motion_as_client_object(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(raw_turn_id="raw-turn")
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["happy"],
                "axes": {"head_yaw": 50},
            }
        },
    )
    view = _build_view(
        phase="immediate",
        route_mode="self_reply",
        final_result="你好呀",
        immediate_reply="你好呀",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    client_object = contribution.client_objects[0]
    assert client_object["type"] == "ag99live.motion_payload"
    assert client_object["source"] == "plugin_hints"
    assert client_object["motion_payload"]["schema_version"] == "engine.motion_intent.v3"
    assert contribution.platform_extras == {}
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "plugin_hints_motion_client_object"
    )


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


def test_result_contributor_uses_default_pose_when_plugin_hints_missing_in_immediate_phase(
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
    assert contribution.client_objects
    client_object = contribution.client_objects[0]
    assert client_object["source"] == "default_pose"
    payload = client_object["motion_payload"]
    assert payload["schema_version"] == "engine.motion_intent.v3"
    assert payload["mode"] == "expressive"
    assert payload["emotion_label"] == "system_fallback"
    assert isinstance(payload["axes"]["head_yaw"], (int, float))
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "default_motion_client_object"
    )


def test_result_contributor_uses_default_pose_when_plugin_hints_missing_in_split_final_phase(
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
    assert contribution.client_objects
    client_object = contribution.client_objects[0]
    assert client_object["source"] == "default_pose"
    payload = client_object["motion_payload"]
    assert payload["schema_version"] == "engine.motion_intent.v3"
    assert payload["mode"] == "expressive"
    assert payload["emotion_label"] == "system_fallback"
    assert payload["duration_hint_ms"] == 1000
    assert isinstance(payload["axes"]["head_yaw"], (int, float))
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "default_motion_client_object"
    )
    assert (
        contribution.metadata["ag99live_motion_schedule"]["plugin_hints_resolution_reason"]
        == "plugin_hints_missing:default_pose:neutral"
    )


def test_result_contributor_uses_default_pose_even_when_realtime_provider_is_available(
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
    assert len(contribution.client_objects) == 1
    client_object = contribution.client_objects[0]
    assert client_object["source"] == "default_pose"
    payload = client_object["motion_payload"]
    assert payload["schema_version"] == "engine.motion_intent.v3"
    assert payload["mode"] == "expressive"
    assert payload["emotion_label"] == "system_fallback"
    assert "head_yaw" in payload["axes"]
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "default_motion_client_object"
    )
    assert (
        contribution.metadata["ag99live_motion_schedule"]["plugin_hints_resolution_reason"]
        == "plugin_hints_missing:default_pose:neutral"
    )


def test_result_contributor_returns_plugin_hint_motion_in_split_final_phase(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["focused"],
                "axes": {"head_yaw": 60},
            }
        },
    )
    view = _build_view(
        phase="final",
        route_mode="delegate_to_core",
        final_result="最终回复文本",
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert len(contribution.client_objects) == 1
    assert contribution.client_objects[0]["source"] == "plugin_hints"
    assert event.get_extra("ag99live_split_motion_scheduled") is True
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "plugin_hints_motion_client_object"
    )


def test_result_contributor_skips_final_phase_in_inline_mode(
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
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "final_phase_managed_by_inline_compat"
    )


def test_result_contributor_skips_immediate_phase_for_hybrid_reply(
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
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "immediate_phase_waits_for_core_reply"
    )


def test_result_contributor_skips_plugin_hint_motion_in_hybrid_immediate_phase(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["thinking"],
                "axes": {"head_yaw": 55},
            }
        },
    )
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
    assert event.get_extra("ag99live_split_motion_scheduled") is None
    metadata = contribution.metadata["ag99live_motion_schedule"]
    assert metadata["reason"] == "immediate_phase_waits_for_core_reply"
    assert metadata["plugin_hints_resolution_reason"] in {
        "ok",
        "skeleton_repair_replaced:head_yaw",
    }


def test_result_contributor_dedupes_plugin_hint_motion_after_immediate_phase(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["happy"],
                "axes": {"head_yaw": 50},
            }
        },
    )

    immediate = asyncio.run(
        contributor.collect(
            event,
            None,
            _build_view(
                phase="immediate",
                route_mode="self_reply",
                final_result="你好呀",
                immediate_reply="你好呀",
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
            ),
        )
    )

    assert immediate is not None
    assert final is not None
    assert scheduled_calls == []
    assert len(immediate.client_objects) == 1
    assert final.client_objects == []
    assert (
        final.metadata["ag99live_motion_schedule"]["reason"]
        == "already_scheduled_by_motion_pipeline"
    )


def test_result_contributor_uses_event_turn_state_reply_plan_when_view_plan_missing(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    contributor = module.AG99liveMotionResultContributor()
    event, scheduled_calls = _build_event(mode="split_after_reply", raw_turn_id="raw-turn")
    event.set_extra(
        "_interaction_decision",
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
    assert metadata["reply_plan_source"] == "event_turn_state"
    assert metadata["reply_plan_route_mode"] == "self_reply"
    assert metadata["reason"] == "default_motion_client_object"
    assert contribution.client_objects
    assert contribution.client_objects[0]["source"] == "default_pose"


def test_result_contributor_does_not_silently_schedule_immediate_phase_without_reply_plan(
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
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "immediate_phase_reply_plan_unresolved"
    )


def test_result_contributor_skips_self_reply_in_inline_first_mode(
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
    )

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is not None
    assert scheduled_calls == []
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "self_reply_managed_by_inline_compat"
    )


def test_self_reply_missing_hints_uses_default_pose_with_provider_available(
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
    assert metadata["scheduled"] is True
    assert metadata["source"] == "default_pose"
    assert "head_yaw" in contribution.client_objects[0]["motion_payload"]["axes"]


def test_plugin_hints_motion_payload_supports_intent_tags_and_resource_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    event, _scheduled_calls = _build_event()
    runtime_state = event.adapter.turn_coordinator.runtime_state
    event.set_extra(
        "_interaction_plugin_hints",
        {
            "ag99live_motion": {
                "intent_tags": ["说明", "认真", "说明"],
                "resource_id": "serious_explain",
                "duration_hint_ms": 1200,
                "axes": {
                    "head_yaw": 48,
                },
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["intent_tags"] == ["说明", "认真"]
    assert payload["emotion_label"] == "说明-认真"
    assert payload["resource_id"] == "serious_explain"
    assert payload["fallback_pose_id"] == "serious_explain"
    assert payload["summary"]["intent_tag_count"] == 2


def test_self_reply_missing_hints_falls_back_to_default_pose_without_provider(
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
    assert metadata["scheduled"] is True
    assert metadata["source"] == "default_pose"
    payload = contribution.client_objects[0]["motion_payload"]
    assert payload["fallback_pose_id"] == "neutral"


def test_register_interaction_contributors_uses_available_hooks(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_motion_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_interaction_motion_module()

    prompt_contributors: list[object] = []
    result_contributors: list[object] = []

    class ContextStub:
        def register_interaction_prompt_contributor(self, contributor) -> None:
            prompt_contributors.append(contributor)

        def register_interaction_result_contributor(self, contributor) -> None:
            result_contributors.append(contributor)

    module.register_ag99live_interaction_contributors(ContextStub())

    assert len(prompt_contributors) == 1
    assert len(result_contributors) == 1
