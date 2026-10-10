from __future__ import annotations

import asyncio
import sys
import types


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
        _terminating_turn_ids=set(),
        _events_by_turn_id={},
        _turn_timings={},
        turn_identity_map=types.SimpleNamespace(clear_frontend_turn=lambda _turn_id: None),
        session_state=types.SimpleNamespace(current_turn_id=None, reset_to_idle=lambda: None),
        output_segments=types.SimpleNamespace(clear_turn=lambda _turn_id: None),
        performance_curves=types.SimpleNamespace(cancel_turn=lambda _turn_id: None),
    )
    runtime._send_json = send_json
    runtime._require_turn_id_value = TurnCoordinator._require_turn_id_value
    runtime._prune_turn_terminal_results = lambda: None
    runtime._clear_active_vad_turn = lambda _turn_id: None
    runtime._finish_turn = types.MethodType(TurnCoordinator._finish_turn, runtime)

    async def run_case() -> None:
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

    asyncio.run(run_case())

    assert [payload["type"] for payload in emitted] == [
        "control.interrupt",
        "control.turn_finished",
    ]
    assert runtime._turn_terminal_results == {
        "old-turn": (False, "superseded_by_new_user_input"),
    }


def test_backend_abort_cancels_turn_owned_motion_task_and_discards_cache(
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
        extras = {
            "_ag99live_independent_motion_result": object(),
        }
        event = types.SimpleNamespace(
            get_extra=lambda key, default=None: extras.get(key, default),
            set_extra=lambda key, value: extras.__setitem__(key, value),
            stop_event=lambda: None,
        )
        runtime = types.SimpleNamespace(
            runtime_state=types.SimpleNamespace(
                independent_motion_result_cache={"old-turn": [object()]},
                independent_motion_generation_tasks_by_turn={"old-turn": {task}},
                independent_motion_segment_batches_by_turn={
                    "old-turn": [object()]
                },
            ),
            _turn_terminal_results={},
            _terminating_turn_ids=set(),
            _events_by_turn_id={"old-turn": event},
            _turn_timings={},
            turn_identity_map=types.SimpleNamespace(
                clear_frontend_turn=lambda _turn_id: None
            ),
            session_state=types.SimpleNamespace(
                current_turn_id=None,
                reset_to_idle=lambda: None,
            ),
            output_segments=types.SimpleNamespace(clear_turn=lambda _turn_id: None),
            performance_curves=types.SimpleNamespace(cancel_turn=lambda _turn_id: None),
        )
        runtime._send_json = send_json
        runtime._require_turn_id_value = TurnCoordinator._require_turn_id_value
        runtime._prune_turn_terminal_results = lambda: None
        runtime._clear_active_vad_turn = lambda _turn_id: None
        runtime._discard_independent_motion_result = types.MethodType(
            TurnCoordinator._discard_independent_motion_result,
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
        assert extras["_ag99live_independent_motion_task"] is None
        assert extras["_ag99live_independent_motion_result"] is None
        assert runtime.runtime_state.independent_motion_result_cache == {}
        assert runtime.runtime_state.independent_motion_generation_tasks_by_turn == {}
        assert runtime.runtime_state.independent_motion_segment_batches_by_turn == {}

    asyncio.run(run_case())
