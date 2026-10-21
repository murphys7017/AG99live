from __future__ import annotations

import asyncio
import sys
import types


async def _noop_async(*_args, **_kwargs) -> None:
    return None


def _observation_window_stub():
    return types.SimpleNamespace(
        note_input=lambda: None,
        note_output_finished=lambda: None,
        reset=lambda: None,
    )


def _pre_action_stub():
    return types.SimpleNamespace(
        begin=_noop_async,
        cancel=_noop_async,
        reset=lambda: None,
        trigger=lambda *_args, **_kwargs: None,
    )


def test_backend_abort_is_idempotent_while_terminal_publication_is_pending(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    components_module = types.ModuleType("astrbot.api.message_components")
    components_module.Image = type("Image", (), {})
    components_module.Plain = type("Plain", (), {})
    components_module.Record = type("Record", (), {})
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", components_module)
    from astrbot_plugin_ag99live_adapter.runtime.turn_coordinator import (
        TurnCoordinator,
    )

    emitted: list[dict] = []

    async def send_json(payload: dict) -> bool:
        emitted.append(payload)
        await asyncio.sleep(0)
        return True

    runtime = types.SimpleNamespace(
        _turn_terminal_results={},
        _turn_terminal_waiters={},
        _terminating_turn_ids=set(),
        _events_by_turn_id={},
        _turn_timings={},
        runtime_state=types.SimpleNamespace(persona_motion_work_by_turn={}),
        turn_identity_map=types.SimpleNamespace(clear_frontend_turn=lambda _turn_id: None),
        session_state=types.SimpleNamespace(current_turn_id=None, reset_to_idle=lambda: None),
        output_segments=types.SimpleNamespace(clear_turn=lambda _turn_id: None),
        performance_curves=types.SimpleNamespace(cancel_turn=lambda _turn_id: None),
        pre_action=_pre_action_stub(),
        observation_window=_observation_window_stub(),
    )
    runtime._send_json = send_json
    runtime._require_turn_id_value = TurnCoordinator._require_turn_id_value
    runtime._prune_turn_terminal_results = lambda: None
    runtime._clear_active_vad_turn = lambda _turn_id: None
    runtime._discard_persona_motion_work = types.MethodType(
        TurnCoordinator._discard_persona_motion_work, runtime
    )
    runtime._finish_turn = types.MethodType(TurnCoordinator._finish_turn, runtime)

    async def run_case() -> None:
        wait_task = asyncio.create_task(
            TurnCoordinator.wait_for_turn_finished(
                runtime,
                turn_id="old-turn",
                timeout_seconds=1.0,
            )
        )
        await asyncio.sleep(0)
        results = await asyncio.gather(
            TurnCoordinator.abort_turn_from_backend(
                runtime,
                turn_id="old-turn",
                reason="superseded_by_new_user_input",
            ),
            TurnCoordinator.abort_turn_from_backend(
                runtime,
                turn_id="old-turn",
                reason="superseded_by_new_user_input",
            ),
        )
        assert results == [0, 0]
        assert await wait_task == (False, "superseded_by_new_user_input")

    asyncio.run(run_case())

    assert [payload["type"] for payload in emitted] == [
        "control.interrupt",
        "control.turn_finished",
    ]
    assert runtime._turn_terminal_results == {
        "old-turn": (False, "superseded_by_new_user_input"),
    }


def test_wait_for_turn_finished_observes_playback_completion_result(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    components_module = types.ModuleType("astrbot.api.message_components")
    components_module.Image = type("Image", (), {})
    components_module.Plain = type("Plain", (), {})
    components_module.Record = type("Record", (), {})
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", components_module)
    from astrbot_plugin_ag99live_adapter.runtime.turn_coordinator import (
        TurnCoordinator,
    )

    async def send_json(_payload: dict) -> bool:
        return True

    runtime = types.SimpleNamespace(
        _turn_terminal_results={},
        _turn_terminal_waiters={},
        _events_by_turn_id={},
        _turn_timings={},
        runtime_state=types.SimpleNamespace(persona_motion_work_by_turn={}),
        output_segments=types.SimpleNamespace(
            require_playback_queue_closed=lambda _turn_id: _completed(),
            output_failure_reason=lambda _turn_id: None,
            clear_turn=lambda _turn_id: None,
        ),
        turn_identity_map=types.SimpleNamespace(clear_frontend_turn=lambda _turn_id: None),
        session_state=types.SimpleNamespace(current_turn_id=None, reset_to_idle=lambda: None),
        performance_curves=types.SimpleNamespace(cancel_turn=lambda _turn_id: None),
        observation_window=_observation_window_stub(),
    )
    runtime._send_json = send_json
    runtime._require_turn_id_value = TurnCoordinator._require_turn_id_value
    runtime._normalize_optional_turn_value = TurnCoordinator._normalize_optional_turn_value
    runtime._prune_turn_terminal_results = lambda: None
    runtime._clear_active_vad_turn = lambda _turn_id: None
    runtime._mark_turn_timing = lambda *_args: None
    runtime._elapsed_ms = lambda *_args: 0.0
    runtime._discard_persona_motion_work = types.MethodType(
        TurnCoordinator._discard_persona_motion_work, runtime
    )
    runtime._finish_turn = types.MethodType(TurnCoordinator._finish_turn, runtime)

    async def run_case() -> None:
        waiter = asyncio.create_task(
            TurnCoordinator.wait_for_turn_finished(
                runtime,
                turn_id="action-turn",
                timeout_seconds=1.0,
            )
        )
        await asyncio.sleep(0)
        await TurnCoordinator.finalize_turn(
            runtime,
            turn_id="action-turn",
            success=True,
        )
        assert await waiter == (True, None)

    async def _completed() -> None:
        return None

    asyncio.run(run_case())


def test_backend_abort_cancels_turn_owned_motion_task_and_clears_segment_work(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    components_module = types.ModuleType("astrbot.api.message_components")
    components_module.Image = type("Image", (), {})
    components_module.Plain = type("Plain", (), {})
    components_module.Record = type("Record", (), {})
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", components_module)
    from astrbot_plugin_ag99live_adapter.runtime.turn_coordinator import (
        TurnCoordinator,
    )

    emitted: list[dict] = []

    async def send_json(payload: dict) -> bool:
        emitted.append(payload)
        return True

    async def run_case() -> None:
        task_started = asyncio.Event()

        async def motion_worker() -> None:
            task_started.set()
            await asyncio.Future()

        task = asyncio.create_task(motion_worker())
        await task_started.wait()
        extras = {"_turn_id": "astrbot-turn"}
        event = types.SimpleNamespace(
            get_extra=lambda key, default=None: extras.get(key, default),
            stop_event=lambda: None,
        )
        runtime = types.SimpleNamespace(
            runtime_state=types.SimpleNamespace(
                independent_motion_generation_tasks_by_turn={"astrbot-turn": {task}},
                persona_motion_work_by_turn={
                    "astrbot-turn": {"persona-result": {"task": task}}
                },
            ),
            _turn_terminal_results={},
            _turn_terminal_waiters={},
            _terminating_turn_ids=set(),
            _events_by_turn_id={"old-turn": event},
            _turn_timings={},
            _preparing_inputs=set(),
            turn_identity_map=types.SimpleNamespace(
                clear_frontend_turn=lambda _turn_id: None
            ),
            session_state=types.SimpleNamespace(
                current_turn_id=None,
                reset_to_idle=lambda: None,
            ),
            output_segments=types.SimpleNamespace(clear_turn=lambda _turn_id: None),
            performance_curves=types.SimpleNamespace(cancel_turn=lambda _turn_id: None),
            pre_action=_pre_action_stub(),
            observation_window=_observation_window_stub(),
        )
        runtime._send_json = send_json
        runtime._require_turn_id_value = TurnCoordinator._require_turn_id_value
        runtime._prune_turn_terminal_results = lambda: None
        runtime._clear_active_vad_turn = lambda _turn_id: None
        runtime._discard_persona_motion_work = types.MethodType(
            TurnCoordinator._discard_persona_motion_work,
            runtime,
        )
        runtime._cancel_turn_owned_motion_task = types.MethodType(
            TurnCoordinator._cancel_turn_owned_motion_task,
            runtime,
        )
        runtime._finish_turn = types.MethodType(TurnCoordinator._finish_turn, runtime)

        await TurnCoordinator.abort_turn_from_backend(
            runtime,
            turn_id="old-turn",
            reason="interrupted",
        )
        await asyncio.gather(task, return_exceptions=True)

        assert task.cancelled()
        assert runtime.runtime_state.independent_motion_generation_tasks_by_turn == {}
        assert runtime.runtime_state.persona_motion_work_by_turn == {}

    asyncio.run(run_case())


def test_disconnect_reset_cancels_orphaned_motion_work(install_fake_astrbot) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.turn_coordinator import (
        TurnCoordinator,
    )

    async def run_case() -> None:
        async def wait_forever() -> None:
            await asyncio.Future()

        task = asyncio.create_task(wait_forever())
        runtime = types.SimpleNamespace(
            runtime_state=types.SimpleNamespace(
                independent_motion_generation_tasks_by_turn={
                    "astrbot-turn": {task}
                },
                persona_motion_work_by_turn={
                    "astrbot-turn": {"persona-result": {"task": task}}
                },
            ),
            _turn_timings={},
            _events_by_turn_id={},
            _turn_terminal_results={},
            _turn_terminal_waiters={},
            _preparing_inputs=set(),
            _input_preparation=None,
            _active_vad_turn_by_capture_turn={},
            _active_speech_capture_turns=set(),
            output_segments=types.SimpleNamespace(
                tracked_turn_ids=lambda: set(),
                reset=lambda: None,
            ),
            performance_curves=types.SimpleNamespace(cancel_turns=lambda _turns: []),
            motion_observations=types.SimpleNamespace(reset=lambda: None),
            pre_action=_pre_action_stub(),
            observation_window=_observation_window_stub(),
        )

        TurnCoordinator.reset_turn_tracking(runtime)
        await asyncio.gather(task, return_exceptions=True)

        assert task.cancelled()
        assert runtime.runtime_state.independent_motion_generation_tasks_by_turn == {}
        assert runtime.runtime_state.persona_motion_work_by_turn == {}

    asyncio.run(run_case())


def test_vad_speech_start_cancels_idle_request_without_interrupting_turn(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    components_module = types.ModuleType("astrbot.api.message_components")
    components_module.Image = type("Image", (), {})
    components_module.Plain = type("Plain", (), {})
    components_module.Record = type("Record", (), {})
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", components_module)
    from astrbot_plugin_ag99live_adapter.runtime.turn_coordinator import (
        TurnCoordinator,
    )

    async def run_case() -> None:
        interrupted_turns: list[str] = []
        cancelled_passive_requests: list[bool] = []
        session_state = types.SimpleNamespace(current_turn_id="dialogue:turn-1")
        runtime = types.SimpleNamespace(
            session_state=session_state,
            _require_turn_id_value=TurnCoordinator._require_turn_id_value,
            _active_vad_turn_by_capture_turn={},
            _events_by_turn_id={},
            _active_speech_capture_turns=set(),
            _passive_behavior_interrupt_handler=None,
            _input_preparation=None,
            observation_window=_observation_window_stub(),
        )

        async def interrupt_turn(turn_id: str) -> None:
            interrupted_turns.append(turn_id)
            session_state.current_turn_id = None

        async def cancel_passive_request() -> None:
            cancelled_passive_requests.append(True)

        runtime._turn_lock = asyncio.Lock()
        runtime._interrupt_passive_work = types.MethodType(
            TurnCoordinator._interrupt_passive_work, runtime
        )
        runtime._handle_interrupt_signal = interrupt_turn
        runtime._passive_behavior_interrupt_handler = cancel_passive_request
        await TurnCoordinator._handle_vad_speech_started(runtime, "capture-1")

        assert interrupted_turns == []
        assert cancelled_passive_requests == [True]
        assert runtime._active_speech_capture_turns == {"capture-1"}

        await TurnCoordinator._handle_vad_speech_ended(runtime, "capture-1")
        assert not runtime._active_speech_capture_turns

    asyncio.run(run_case())


def test_ptt_capture_blocks_passive_work_until_stream_end(install_fake_astrbot, monkeypatch):
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime import turn_coordinator as module

    async def run_case():
        calls = []
        async def start(message):
            calls.append("start")
        async def end(message):
            assert runtime._active_speech_capture_turns == {"capture:ptt"}
            return None
        async def interrupt():
            calls.append("interrupt")
        runtime = types.SimpleNamespace(
            _turn_lock=asyncio.Lock(),
            _active_vad_turn_by_capture_turn={},
            _active_speech_capture_turns=set(),
            _require_interactive_turn_id=lambda message: message.turn_id,
            _interrupt_passive_work=interrupt,
            speech_ingress=types.SimpleNamespace(
                handle_audio_stream_start=start, handle_audio_stream_end=end
            ),
            _input_preparation=None,
            _preparing_inputs=set(),
            pre_action=_pre_action_stub(),
            observation_window=_observation_window_stub(),
        )
        monkeypatch.setattr(module, "parse_inbound_message", lambda message: message)
        await module.TurnCoordinator.handle_msg(runtime, types.SimpleNamespace(
            type=module.TYPE_INPUT_AUDIO_STREAM_START,
            turn_id="capture:ptt", payload={"capture_mode": "ptt"},
        ))
        assert calls == ["start", "interrupt"]
        assert runtime._active_speech_capture_turns == {"capture:ptt"}
        await module.TurnCoordinator.handle_msg(runtime, types.SimpleNamespace(
            type=module.TYPE_INPUT_AUDIO_STREAM_END,
            turn_id="capture:ptt", payload={},
        ))
        assert not runtime._active_speech_capture_turns
    asyncio.run(run_case())
