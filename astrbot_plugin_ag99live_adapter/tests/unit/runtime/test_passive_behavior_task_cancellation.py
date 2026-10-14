from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace


def test_direct_runtime_task_cancellation_terminates_polling_task(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime import passive_behavior

    monkeypatch.setattr(
        passive_behavior,
        "resolve_selected_semantic_axis_profile",
        lambda **_kwargs: {},
    )
    monkeypatch.setattr(
        passive_behavior,
        "build_passive_behavior_prompt",
        lambda **_kwargs: "prompt",
    )
    stream_started = asyncio.Event()

    async def text_chat_stream(**_kwargs):
        stream_started.set()
        await asyncio.Future()
        if False:
            yield None

    provider = SimpleNamespace(text_chat_stream=text_chat_stream)
    runtime = passive_behavior.PassiveBehaviorRuntime(
        runtime_state=SimpleNamespace(
            passive_behavior_enabled=True,
            passive_behavior_provider_id="provider-1",
            passive_behavior_request_interval_ms=250,
            passive_behavior_cooldown_ms=0,
            passive_behavior_result_ttl_ms=30000,
            passive_behavior_timeout_seconds=30.0,
            selected_passive_behavior_provider=provider,
        ),
        session_state=SimpleNamespace(current_turn_id=None),
        turn_coordinator=SimpleNamespace(has_active_speech_input=False),
        is_desktop_connected=lambda: True,
    )
    runtime._read_neurobrain_state = lambda: {"emotion": {"joy": 0.5}}

    async def run_case() -> None:
        runtime._last_request_at = -1.0
        await runtime.start()
        task = runtime._task
        assert task is not None
        await asyncio.wait_for(stream_started.wait(), timeout=0.5)

        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=0.5)
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("direct cancellation should terminate the runtime task")

        assert task.done()
        assert task.cancelled()
        assert runtime._active_stream_task is None

    asyncio.run(run_case())
