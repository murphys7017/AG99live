from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest


def test_summarize_motion_for_curve_includes_sequence_axes(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        summarize_motion_for_curve,
    )

    summary = summarize_motion_for_curve(
        {
            "intent_tags": ["测试", "左右扭头"],
            "motion_steps": [
                {"axis_levels": {"head_yaw": -3, "gaze_x": -2}, "duration_weight": 1},
                {"axis_levels": {"head_yaw": 3, "gaze_x": 2}, "duration_weight": 1},
            ],
        }
    )

    assert summary["axis_keys"] == ["gaze_x", "head_yaw"]
    assert summary["motion_step_count"] == 2

    malformed = summarize_motion_for_curve(
        {"motion_steps": [{"axis_levels": ["head_yaw"]}]}
    )
    assert malformed["axis_keys"] == []
    assert malformed["motion_step_count"] == 1


def test_performance_curve_prompt_omits_runtime_identifiers(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.prompts.performance_curve import (
        build_performance_curve_prompt,
    )

    prompt = build_performance_curve_prompt(
        assistant_text="你好。",
        assistant_reply_keywords=["你好"],
        motion_intent_tags=["greeting"],
        motion_effect_summary={},
        chat_context=[],
    )

    assert "turn_id" not in prompt
    assert "message_id" not in prompt
    assert "你好。" in prompt


def test_normalize_performance_curve_hint_rejects_unknown_enums(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        normalize_performance_curve_hint,
    )

    with pytest.raises(ValueError, match="performance_curve_hint_invalid_curve_family"):
        normalize_performance_curve_hint(
            {
                "schema_version": "ag99.performance_curve_hint.v1",
                "curve_family": "unknown",
                "entry": "quick",
                "hold": "steady",
                "exit": "soft",
                "emphasis": "early",
                "energy": "medium",
            }
        )


def test_performance_curve_coordinator_uses_explicit_runtime_port(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.performance_curve_coordinator import (
        PerformanceCurveCoordinator,
    )

    class Runtime:
        def __init__(self) -> None:
            self.cancelled_turn_ids: list[str | None] = []

        def cancel_turn(self, turn_id: str | None) -> None:
            self.cancelled_turn_ids.append(turn_id)

        def owns_request(
            self,
            *,
            turn_id: str | None,
            request_id: str | None,
        ) -> bool:
            return (turn_id, request_id) == ("turn-1", "request-1")

        def start(self, _request: Any) -> bool:
            return False

        def get_ready(
            self,
            *,
            turn_id: str | None,
            request_id: str | None,
        ) -> dict[str, Any] | None:
            del turn_id, request_id
            return None

        def discard_if_not_ready(
            self,
            *,
            turn_id: str | None,
            request_id: str | None,
        ) -> bool:
            del turn_id, request_id
            return False

        def clear(self, *, turn_id: str | None, request_id: str | None) -> None:
            del turn_id, request_id

    runtime = Runtime()
    coordinator = PerformanceCurveCoordinator(
        runtime=runtime,
        is_enabled=lambda: False,
        observations=SimpleNamespace(),
    )

    coordinator.cancel_turn("turn-1")

    assert runtime.cancelled_turn_ids == ["turn-1"]
    assert coordinator.owns_request(turn_id="turn-1", request_id="request-1") is True
    assert coordinator.start_request(
        turn_id="turn-1",
        tts_turn_id="tts-turn-1",
        message_id="message-1",
        request_id="request-1",
        assistant_text="不会启动。",
        motion_payload={},
    ) is None


def test_performance_curve_runtime_resolves_provider_hint(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        PerformanceCurveInput,
        PerformanceCurveRuntime,
    )

    class Provider:
        async def text_chat_stream(
            self,
            *,
            prompt: str,
            system_prompt: str,
            contexts=None,
        ):
            del contexts
            assert "assistant_text" in prompt
            assert "表演节奏选择器" in system_prompt
            completion = json.dumps(
                {
                    "schema_version": "ag99.performance_curve_hint.v1",
                    "curve_family": "quick_in_hold_soft_out",
                    "entry": "quick",
                    "hold": "steady",
                    "exit": "soft",
                    "emphasis": "early",
                    "energy": "medium",
                },
                ensure_ascii=False,
            )
            midpoint = len(completion) // 2
            yield SimpleNamespace(
                role="assistant",
                completion_text=completion[:midpoint],
                is_chunk=True,
            )
            yield SimpleNamespace(
                role="assistant",
                completion_text=completion,
                is_chunk=False,
            )

    async def run_case() -> dict:
        runtime_state = SimpleNamespace(
            enable_performance_curve=True,
            selected_performance_curve_provider=Provider(),
            motion_lab_recorder=None,
        )
        runtime = PerformanceCurveRuntime(runtime_state=runtime_state)
        started = runtime.start(
            PerformanceCurveInput(
                turn_id="turn-1",
                tts_turn_id="tts-turn-1",
                message_id="message-1",
                request_id="request-1",
                assistant_text="今天我们轻快一点。",
                assistant_reply_keywords=["轻快"],
                motion_intent_tags=["happy"],
                motion_effect_summary={"axis_keys": ["head_yaw"]},
                chat_context=[],
            )
        )
        assert started is True
        for _ in range(10):
            await asyncio.sleep(0)
            if runtime.get_ready(turn_id="turn-1", request_id="request-1") is not None:
                break
        hint = runtime.get_ready(turn_id="turn-1", request_id="request-1")
        assert hint is not None
        return hint

    hint = asyncio.run(run_case())

    assert hint["curve_family"] == "quick_in_hold_soft_out"
    assert hint["entry"] == "quick"


def test_performance_curve_runtime_discards_not_ready_request(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        PerformanceCurveInput,
        PerformanceCurveRuntime,
    )

    class SlowProvider:
        async def text_chat_stream(
            self,
            *,
            prompt: str,
            system_prompt: str,
            contexts=None,
        ):
            del prompt, system_prompt, contexts
            await asyncio.sleep(60)
            if False:
                yield None

    async def run_case() -> tuple[bool, dict | None]:
        runtime_state = SimpleNamespace(
            enable_performance_curve=True,
            selected_performance_curve_provider=SlowProvider(),
            motion_lab_recorder=None,
        )
        runtime = PerformanceCurveRuntime(runtime_state=runtime_state)
        runtime.start(
            PerformanceCurveInput(
                turn_id="turn-1",
                tts_turn_id="tts-turn-1",
                message_id="message-1",
                request_id="request-1",
                assistant_text="今天我们轻快一点。",
                assistant_reply_keywords=["轻快"],
                motion_intent_tags=["happy"],
                motion_effect_summary={"axis_keys": ["head_yaw"]},
                chat_context=[],
            )
        )
        await asyncio.sleep(0)
        discarded = runtime.discard_if_not_ready(
            turn_id="turn-1",
            request_id="request-1",
        )
        assert runtime.owns_request(turn_id="turn-1", request_id="request-1") is False
        return discarded, runtime.get_ready(
            turn_id="turn-1",
            request_id="request-1",
        )

    discarded, hint = asyncio.run(run_case())

    assert discarded is True
    assert hint is None


def test_performance_curve_runtime_skips_provider_without_chat_stream(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        PerformanceCurveInput,
        PerformanceCurveRuntime,
    )

    class LegacyProvider:
        def __init__(self) -> None:
            self.complete_calls = 0

        async def text_chat(self, **_kwargs):
            self.complete_calls += 1
            raise AssertionError("complete chat must not be used")

    async def run_case() -> tuple[bool, int, bool]:
        provider = LegacyProvider()
        runtime = PerformanceCurveRuntime(
            runtime_state=SimpleNamespace(
                enable_performance_curve=True,
                selected_performance_curve_provider=provider,
                motion_lab_recorder=None,
            )
        )
        started = runtime.start(
            PerformanceCurveInput(
                turn_id="turn-1",
                tts_turn_id="tts-turn-1",
                message_id="message-1",
                request_id="request-1",
                assistant_text="跳过动作曲线。",
                assistant_reply_keywords=[],
                motion_intent_tags=[],
                motion_effect_summary={},
                chat_context=[],
            )
        )
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return (
            started,
            provider.complete_calls,
            runtime.owns_request(turn_id="turn-1", request_id="request-1"),
        )

    assert asyncio.run(run_case()) == (True, 0, False)


def test_text_stream_preserves_repeated_deltas(install_fake_astrbot) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.text_stream import read_text_chat_stream

    class Provider:
        async def text_chat_stream(self, **_kwargs):
            for delta in ('{"value":"', '哈', '哈', '"', '}'):
                yield SimpleNamespace(
                    role="assistant", completion_text=delta, is_chunk=True
                )

    result = asyncio.run(read_text_chat_stream(
        Provider(), prompt="prompt", system_prompt="system"
    ))
    assert result == '{"value":"哈哈"}'


def test_text_stream_rejects_final_only_provider_without_fallback(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.text_stream import (
        TextChatStreamUnavailable,
        read_text_chat_stream,
    )

    class FinalOnlyProvider:
        def __init__(self) -> None:
            self.complete_calls = 0

        async def text_chat_stream(self, **_kwargs):
            yield SimpleNamespace(
                role="assistant",
                completion_text='{"ok":true}',
                is_chunk=False,
            )

        async def text_chat(self, **_kwargs):
            self.complete_calls += 1
            raise AssertionError("complete chat must not be used")

    async def run_case() -> int:
        provider = FinalOnlyProvider()
        with pytest.raises(
            TextChatStreamUnavailable,
            match="text_chat_stream_final_only",
        ):
            await read_text_chat_stream(
                provider,
                prompt="prompt",
                system_prompt="system",
            )
        return provider.complete_calls

    assert asyncio.run(run_case()) == 0


def test_performance_curve_runtime_starts_logical_message_only_once(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        PerformanceCurveInput,
        PerformanceCurveRuntime,
    )

    class SlowProvider:
        async def text_chat_stream(
            self,
            *,
            prompt: str,
            system_prompt: str,
            contexts=None,
        ):
            del prompt, system_prompt, contexts
            await asyncio.sleep(60)
            if False:
                yield None

    async def run_case() -> tuple[bool, bool]:
        runtime = PerformanceCurveRuntime(
            runtime_state=SimpleNamespace(
                enable_performance_curve=True,
                selected_performance_curve_provider=SlowProvider(),
                motion_lab_recorder=None,
            )
        )
        request = PerformanceCurveInput(
            turn_id="turn-1",
            tts_turn_id="tts-turn-1",
            message_id="message-1",
            request_id="request-1",
            assistant_text="同一句回复。",
            assistant_reply_keywords=["同一句回复"],
            motion_intent_tags=[],
            motion_effect_summary={},
            chat_context=[],
        )
        first = runtime.start(request)
        second = runtime.start(request)
        assert runtime.owns_request(turn_id="turn-1", request_id="request-1") is True
        runtime.cancel_turn("turn-1")
        assert runtime._tasks == {}
        assert runtime._results == {}
        assert runtime._requests == {}
        assert runtime._requested_keys == set()
        return first, second

    assert asyncio.run(run_case()) == (True, False)
