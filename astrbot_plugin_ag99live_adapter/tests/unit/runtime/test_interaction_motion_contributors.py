from __future__ import annotations

import asyncio
import importlib
import sys
import types


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
                            "parameter_bindings": [],
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
                            "parameter_bindings": [],
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
            "motion_prompt_instruction": "Use readable exaggerated head and smile motion.",
            "model_info": _build_semantic_model_info(),
        },
    )()
    state.build_motion_tuning_style_prompt = lambda: (
        "中性时偏少轴，开心时优先笑眼和嘴角。"
    )
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
            self.message_obj = type(
                "MessageObjectStub",
                (),
                {
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
):
    decision = None
    if route_mode is not None or should_emit_immediate_reply is not None:
        decision = {}
        if route_mode is not None:
            decision["route_mode"] = route_mode
        if should_emit_immediate_reply is not None:
            decision["should_emit_immediate_reply"] = should_emit_immediate_reply
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
            "metadata": {"phase": phase},
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
    view = _build_view(phase="decision", route_mode="delegate_to_core")

    extensions = asyncio.run(contributor.collect(event, None, view))

    assert isinstance(extensions, list)
    assert len(extensions) == 3
    system = next(item for item in extensions if item.mount == "system")
    capability = next(item for item in extensions if item.mount == "capability")
    runtime = next(item for item in extensions if item.mount == "context")
    assert "AG99live Motion 是当前桌宠前端的主动作通道" in system.value
    assert '"plugin_hints":{"ag99live_motion"' in system.value
    assert "immediate_spoken_reply" in system.value
    assert "避免连续复用同一组轴和值" in system.value
    assert "中位值不是推荐动作" in system.value
    assert "角色风格偏好" in system.value
    assert "中性时偏少轴" in system.value
    assert capability.value["configured_generation_mode"] == "split_after_reply"
    assert capability.value["motion_style_prompt"] == "中性时偏少轴，开心时优先笑眼和嘴角。"
    assert capability.value["semantic_profile"]["profile_id"] == "pet.semantic.v1"
    assert "低值=turn left；高值=turn right" in capability.value["semantic_profile"]["axis_prompt"]
    assert "使用说明=Use for attention direction." in capability.value["semantic_profile"]["axis_prompt"]
    assert "低值=turn left；高值=turn right" in system.value
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
        capability.value["plugin_hints_format"]["ag99live_motion"]["axes"]["head_yaw"]["value"]
        == 50
    )
    assert runtime.value["configured_generation_mode"] == "split_after_reply"


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
                "mode": "expressive",
                "emotion_label": "playful",
                "duration_hint_ms": 1200,
                "axes": {
                    "head_yaw": {"value": 48},
                    "eye_open_left": {"value": 72},
                    "debug_tail": {"value": 100},
                    "unknown_axis": {"value": 60},
                },
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["axes"]["head_yaw"]["value"] == 48
    assert payload["axes"]["eye_open_left"]["value"] == 72
    assert "debug_tail" not in payload["axes"]
    assert "unknown_axis" not in payload["axes"]


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
                "mode": "expressive",
                "emotion_label": "playful",
                "duration_hint_ms": 1200,
                "axes": {
                    "head_yaw": {"value": 50},
                },
            }
        },
    )

    payload = module._resolve_plugin_hints_motion_payload(event, runtime_state)

    assert payload is not None
    assert payload["axes"]["head_yaw"]["value"] > 58


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
                "mode": "expressive",
                "emotion_label": "neutral",
                "axes": {
                    "head_roll": {"value": 40},
                    "mouth_smile": {"value": 65},
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
                "mode": "expressive",
                "emotion_label": "happy",
                "axes": {"head_yaw": {"value": 50}},
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
    assert client_object["motion_payload"]["schema_version"] == "engine.motion_intent.v2"
    assert contribution.platform_extras["client_objects"] == contribution.client_objects
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


def test_result_contributor_reports_missing_plugin_hints_in_split_final_phase(
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
    assert (
        contribution.metadata["ag99live_motion_schedule"]["reason"]
        == "plugin_hints_motion_missing"
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
    assert metadata["reason"] == "schedule_self_reply_immediate"


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
