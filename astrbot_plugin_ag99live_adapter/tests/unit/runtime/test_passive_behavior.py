from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace


def _make_runtime(monkeypatch, passive_behavior_module, provider, *, ttl_ms=2500, timeout=3.0):
    monkeypatch.setattr(
        passive_behavior_module,
        "resolve_selected_semantic_axis_profile",
        lambda **_kwargs: {},
    )
    monkeypatch.setattr(
        passive_behavior_module,
        "build_passive_behavior_prompt",
        lambda **_kwargs: "prompt",
    )
    runtime_state = SimpleNamespace(
        passive_behavior_enabled=True,
        passive_behavior_provider_id="provider-1",
        passive_behavior_request_interval_ms=250,
        passive_behavior_cooldown_ms=0,
        passive_behavior_result_ttl_ms=ttl_ms,
        passive_behavior_timeout_seconds=timeout,
        selected_passive_behavior_provider=provider,
    )
    runtime = passive_behavior_module.PassiveBehaviorRuntime(
        runtime_state=runtime_state,
        session_state=SimpleNamespace(current_turn_id=None),
        turn_coordinator=SimpleNamespace(has_active_speech_input=False),
        is_desktop_connected=lambda: True,
    )
    runtime._read_neurobrain_state = lambda: {"emotion": {"joy": 0.5}}
    return runtime


def test_non_streaming_provider_is_suppressed_after_first_not_implemented_error(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime import passive_behavior

    calls = 0

    async def text_chat_stream(**_kwargs):
        nonlocal calls
        calls += 1
        if False:
            yield None
        raise NotImplementedError

    provider = SimpleNamespace(text_chat_stream=text_chat_stream)
    runtime = _make_runtime(monkeypatch, passive_behavior, provider)

    async def run_case() -> None:
        runtime._last_request_at = -1.0
        await runtime._request_if_ready()
        runtime._last_request_at = -1.0
        await runtime._request_if_ready()

    asyncio.run(run_case())

    assert calls == 1
    assert runtime._unsupported_provider_identity == runtime._provider_identity_key


def test_provider_failures_back_off_before_retrying(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime import passive_behavior

    calls = 0

    async def text_chat_stream(**_kwargs):
        nonlocal calls
        calls += 1
        if False:
            yield None
        raise RuntimeError("provider unavailable")

    provider = SimpleNamespace(text_chat_stream=text_chat_stream)
    runtime = _make_runtime(monkeypatch, passive_behavior, provider)

    async def run_case() -> None:
        runtime._last_request_at = -1.0
        await runtime._request_if_ready()
        runtime._last_request_at = -1.0
        await runtime._request_if_ready()

    asyncio.run(run_case())

    assert calls == 1
    assert runtime._retry_not_before > time.monotonic()


def test_result_ttl_cancels_provider_stream_without_waiting_for_request_timeout(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime import passive_behavior

    stream_started = asyncio.Event()
    stream_closed = asyncio.Event()

    async def text_chat_stream(**_kwargs):
        stream_started.set()
        try:
            await asyncio.Future()
        finally:
            stream_closed.set()
        if False:
            yield None

    provider = SimpleNamespace(text_chat_stream=text_chat_stream)
    runtime = _make_runtime(
        monkeypatch,
        passive_behavior,
        provider,
        ttl_ms=250,
        timeout=20.0,
    )

    async def run_case() -> None:
        request = asyncio.create_task(
            runtime._run_stream_request(
                provider=provider,
                request_started_at=time.monotonic(),
            )
        )
        await asyncio.wait_for(stream_started.wait(), timeout=0.5)
        await asyncio.wait_for(request, timeout=1.0)
        assert stream_closed.is_set()

    asyncio.run(run_case())


def test_interrupted_stream_keeps_runtime_alive_and_suspended_during_speech(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime import passive_behavior

    calls = 0
    stream_started = asyncio.Event()
    stream_closed = asyncio.Event()

    async def text_chat_stream(**_kwargs):
        nonlocal calls
        calls += 1
        stream_started.set()
        try:
            await asyncio.Future()
        finally:
            stream_closed.set()
        if False:
            yield None

    provider = SimpleNamespace(text_chat_stream=text_chat_stream)
    runtime = _make_runtime(monkeypatch, passive_behavior, provider)

    async def run_case() -> None:
        runtime._last_request_at = -1.0
        await runtime.start()
        try:
            await asyncio.wait_for(stream_started.wait(), timeout=0.5)
            runtime.turn_coordinator.has_active_speech_input = True
            await runtime.interrupt_active_request()
            await asyncio.sleep(0.05)

            assert stream_closed.is_set()
            assert runtime._task is not None and not runtime._task.done()
            assert calls == 1
        finally:
            await runtime.stop()

    asyncio.run(run_case())
