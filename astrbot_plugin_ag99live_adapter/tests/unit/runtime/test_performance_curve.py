from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace


def test_normalize_performance_curve_hint_defaults_unknown_enums(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        normalize_performance_curve_hint,
    )

    hint = normalize_performance_curve_hint(
        {
            "schema_version": "ag99.performance_curve_hint.v1",
            "curve_family": "unknown",
            "entry": "quick",
            "hold": "unknown",
            "exit": "soft",
            "emphasis": "early",
            "energy": "strange",
        }
    )

    assert hint == {
        "schema_version": "ag99.performance_curve_hint.v1",
        "curve_family": "default",
        "entry": "quick",
        "hold": "steady",
        "exit": "soft",
        "emphasis": "early",
        "energy": "medium",
    }


def test_performance_curve_runtime_resolves_provider_hint(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        PerformanceCurveInput,
        PerformanceCurveRuntime,
    )

    class Provider:
        async def text_chat(self, *, prompt: str, system_prompt: str):
            assert "assistant_text" in prompt
            assert "表演节奏选择器" in system_prompt
            return SimpleNamespace(
                completion_text=json.dumps(
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
                message_id="message-1",
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
            if runtime.get_ready(turn_id="turn-1", message_id="message-1") is not None:
                break
        hint = runtime.get_ready(turn_id="turn-1", message_id="message-1")
        assert hint is not None
        return hint

    hint = asyncio.run(run_case())

    assert hint["curve_family"] == "quick_in_hold_soft_out"
    assert hint["entry"] == "quick"


def test_performance_curve_runtime_fails_not_ready_request(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.performance_curve import (
        PerformanceCurveInput,
        PerformanceCurveRuntime,
    )

    class SlowProvider:
        async def text_chat(self, *, prompt: str, system_prompt: str):
            del prompt, system_prompt
            await asyncio.sleep(60)
            return SimpleNamespace(completion_text="{}")

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
                message_id="message-1",
                assistant_text="今天我们轻快一点。",
                assistant_reply_keywords=["轻快"],
                motion_intent_tags=["happy"],
                motion_effect_summary={"axis_keys": ["head_yaw"]},
                chat_context=[],
            )
        )
        await asyncio.sleep(0)
        failed = runtime.fail_if_not_ready(
            turn_id="turn-1",
            message_id="message-1",
            reason="not_ready_before_motion_egress",
        )
        return failed, runtime.get_ready(turn_id="turn-1", message_id="message-1")

    failed, hint = asyncio.run(run_case())

    assert failed is True
    assert hint is None
